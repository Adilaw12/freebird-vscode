import { perfLog } from '../util/perfLog';
import * as vscode from 'vscode';
import { AIProvider, Message, CompletionOptions } from './provider';
import { getStoredSession } from '../auth/github';
import { QUOTA_KEY } from '../license/usage';
import { trackEvent } from '../telemetry';

const API_BASE  = 'https://freebird-backend.vercel.app';

// Last model reported by the backend via X-Model-Used (e.g. "gemini-3.1-flash-lite").
// Read by the chat panel after a stream() call completes so the webview can show
// which model actually answered — otherwise invisible to users. Stored the same
// way as QUOTA_KEY since there's no other channel back to the caller mid-stream.
const MODEL_KEY = 'freebird.lastModelUsed';

// Last monthly Sonnet allowance reported via X-Premium-Remaining/-Limit.
const PREMIUM_KEY = 'freebird.premiumAllowance';

export function getPremiumAllowance(context: vscode.ExtensionContext): { remaining: number; limit: number } | undefined {
    return context.globalState.get<{ remaining: number; limit: number }>(PREMIUM_KEY);
}

/**
 * CloudProvider — calls the Freebird Vercel backend.
 *
 * Two modes:
 *   'quota'    → POST /api/chat    — enforces the daily free-edit quota
 *   'fallback' → POST /api/fallback — used when Ollama fails; enforces the same
 *                                     daily quota (shared keys) plus an hourly
 *                                     IP burst limit to prevent abuse
 */
const STREAM_TIMEOUT_MS = 150_000;

/** Combines an optional caller signal with a timeout (AbortSignal.any needs Node 20+). */
function withTimeout(signal: AbortSignal | undefined, ms: number): AbortSignal {
    const timeout = AbortSignal.timeout(ms);
    if (!signal) return timeout;
    const ctrl = new AbortController();
    for (const s of [signal, timeout]) {
        if (s.aborted) { ctrl.abort(s.reason); break; }
        s.addEventListener('abort', () => ctrl.abort(s.reason), { once: true });
    }
    return ctrl.signal;
}

export class CloudProvider implements AIProvider {
    private readonly context: vscode.ExtensionContext;
    private readonly sessionId: string;
    private readonly mode: 'quota' | 'fallback';

    /** True after a stream() call whose response carried X-Template-Bonus-Used —
     *  the caller (panel.ts) checks this immediately after awaiting stream() to
     *  decide whether to show the one-time Template Library upsell nudge. */
    templateBonusUsed = false;

    // Pro/unmetered traffic always resolves to Claude Haiku 4.5/Sonnet 5 server-side
    // (backend/api/chat.js) — both support Anthropic's image content-block shape,
    // which is exactly what a Message.image gets converted into below.
    readonly supportsImageInput = true;

    constructor(
        context: vscode.ExtensionContext,
        sessionId: string,
        mode: 'quota' | 'fallback' = 'quota'
    ) {
        this.context   = context;
        this.sessionId = sessionId;
        this.mode      = mode;
    }

    async stream(
        messages: Message[],
        onChunk: (text: string) => void,
        opts?: CompletionOptions
    ): Promise<void> {
        try {
            await this.streamOnce(messages, onChunk, opts);
        } catch (err: any) {
            // Our own backstop timer fired (not a user cancel, which has AbortError). Say so in
            // plain words instead of surfacing "The operation was aborted due to timeout".
            if (err?.name === 'TimeoutError') {
                const e = new Error(
                    'Freebird Cloud did not finish answering in time (over ' + Math.round(STREAM_TIMEOUT_MS / 60_000 * 10) / 10 + ' minutes). ' +
                    'Agent requests that plan a lot before writing can be slow — try again, or break the request into smaller steps.'
                ) as any;
                e.code = 'REQUEST_TIMEOUT';
                throw e;
            }
            throw err;
        }
    }

    private async streamOnce(
        messages: Message[],
        onChunk: (text: string) => void,
        opts?: CompletionOptions
    ): Promise<void> {
        const t0 = Date.now();
        const endpoint = this.mode === 'fallback'
            ? `${API_BASE}/api/fallback`
            : `${API_BASE}/api/chat`;

        // sessionId (machineId) is still sent as a legacy fallback identity for
        // as long as the backend supports it during rollout. authToken — issued
        // after GitHub sign-in — is the real, unspoofable identity. licenseKey
        // lets Pro/Enterprise subscribers skip quota entirely server-side.
        const session    = await getStoredSession(this.context);
        const cfg        = vscode.workspace.getConfiguration('freebird');
        const licenseKey = cfg.get<string>('licenseKey', '').trim();
        const templateLicenseKey = cfg.get<string>('templateLicenseKey', '').trim();

        this.templateBonusUsed = false;

        // Messages carrying an image (e.g. verify_diagram's rendered PNG) get
        // converted to Anthropic's multimodal content-block shape; everything
        // else stays a plain string. Safe to send unconditionally — chat.js
        // only special-cases content when it's actually an array.
        const wireMessages = messages.map(m => m.image
            ? {
                role: m.role,
                content: [
                    { type: 'image', source: { type: 'base64', media_type: m.image.mimeType, data: m.image.base64 } },
                    { type: 'text', text: m.content }
                ]
            }
            : { role: m.role, content: m.content }
        );

        const body = {
            messages: wireMessages,
            sessionId:  this.sessionId,
            authToken:  session?.sessionToken,
            licenseKey: licenseKey || undefined,
            // templateId is set only when this message originated from one of
            // the 3 free built-in templates (see panel.ts) — the backend uses
            // it purely for routing (a free-tier Haiku quality bonus), never
            // for anything billing/security-relevant.
            templateId: opts?.templateId,
            templateLicenseKey: templateLicenseKey || undefined,
            // Agent-mode requests (premium flag) produce whole files and drawings in one
            // answer; the chat default of 2048 truncated them mid-file. The backend still
            // caps each tier (free trial 4096) — this just stops us asking for too little.
            maxTokens:  opts?.maxTokens ?? (opts?.premium ? 4096 : 2048),
            isTabCompletion: opts?.isTabCompletion,
            premium: opts?.premium,
            agentTrial: opts?.agentTrial
        };

        const res = await fetch(endpoint, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify(body),
            // Backstop only. This covers the WHOLE request, including the time a Pro agent
            // model spends planning before it streams a single character. It sits above the
            // backend's own 120s function limit (backend/vercel.json) so the server's limit,
            // not this timer, normally ends a stuck request. 90s used to cut off requests
            // the server was still happily working on.
            signal:  withTimeout(opts?.signal, STREAM_TIMEOUT_MS)
        });

        if (res.status === 401) {
            const errorBody = await res.json().catch(() => ({})) as Record<string, unknown>;
            const err = new Error('AUTH_REQUIRED') as any;
            err.code  = (errorBody.code as string) ?? 'AUTH_REQUIRED';
            throw err;
        }

        if (res.status === 429) {
            const errorBody = await res.json().catch(() => ({})) as Record<string, unknown>;
            const code = (errorBody.code as string) ?? 'RATE_LIMITED';

            if (code === 'QUOTA_EXCEEDED') {
                await this.context.globalState.update(QUOTA_KEY, 0);
                const err  = new Error('QUOTA_EXCEEDED') as any;
                err.code   = 'QUOTA_EXCEEDED';
                throw err;
            }

            // Completions have their own server-side bucket — running out of
            // it must not zero the cached chat quota, which gates chat features.
            if (code === 'COMPLETION_QUOTA_EXCEEDED') {
                const err  = new Error('COMPLETION_QUOTA_EXCEEDED') as any;
                err.code   = 'COMPLETION_QUOTA_EXCEEDED';
                throw err;
            }

            if (code === 'IP_RATE_LIMITED') {
                const err  = new Error('IP_RATE_LIMITED') as any;
                err.code   = 'IP_RATE_LIMITED';
                throw err;
            }

            // e.g. AGENT_TRIAL_EXHAUSTED / AGENT_TRIAL_RATE_LIMITED — the server's
            // own message is the useful one to show.
            const err  = new Error((errorBody.error as string) || 'Rate limited') as any;
            err.code   = code;
            throw err;
        }

        // 502/503/504 here come from the hosting gateway, not the AI provider: the
        // backend function hit its time limit before sending anything. The usual
        // cause is a very large single answer (e.g. a detailed drawing), and the
        // bare "Cloud AI error (504)" gave the user nothing to act on.
        if (res.status === 504 || res.status === 503 || res.status === 502) {
            const err = new Error(
                'The cloud AI took too long to answer (the request timed out). ' +
                'This usually happens with very large outputs — try again, or ask for something smaller or simpler ' +
                '(for a drawing: fewer rooms or less detail). If it keeps happening, switch to a faster backend via "Freebird: Configure AI Backend".'
            ) as any;
            err.code = 'GATEWAY_TIMEOUT';
            throw err;
        }

        if (!res.ok) {
            let detail = res.statusText;
            try {
                const body = await res.json() as Record<string, unknown>;
                detail = (body.error as string) ?? detail;
            } catch { /* ignore */ }
            throw new Error(`Cloud AI error (${res.status}): ${detail}`);
        }

        // Update local quota cache from response headers (quota mode only)
        if (res.headers.get('X-Quota-Unmetered') === 'true') {
            await this.context.globalState.update(QUOTA_KEY, Number.POSITIVE_INFINITY);
        } else {
            const remaining = res.headers.get('X-Quota-Remaining');
            if (remaining !== null) {
                await this.context.globalState.update(QUOTA_KEY, parseInt(remaining, 10));
            }
        }

        const premiumRemaining = res.headers.get('X-Premium-Remaining');
        const premiumLimit = res.headers.get('X-Premium-Limit');
        if (premiumRemaining !== null && premiumLimit !== null) {
            await this.context.globalState.update(PREMIUM_KEY, {
                remaining: parseInt(premiumRemaining, 10),
                limit: parseInt(premiumLimit, 10)
            });
        }

        if (res.headers.get('X-Template-Bonus-Used') === 'true') {
            this.templateBonusUsed = true;
        }

        const modelUsed = res.headers.get('X-Model-Used');
        if (modelUsed) {
            await this.context.globalState.update(MODEL_KEY, modelUsed);
            // Per-model breakdown (e.g. how often the Anthropic->Gemini fallback
            // engages for Pro) lands in Redis as telemetry:eventDetails:{date}
            // under "model_used:<model id>" — readable directly, no dashboard
            // chart needed for this one.
            trackEvent('model_used', modelUsed);
        }

        // Stream plain-text response
        const reader  = res.body!.getReader();
        const decoder = new TextDecoder();
        let firstByteMs = -1, chars = 0;

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            const text = decoder.decode(value, { stream: true });
            if (text) {
                if (firstByteMs < 0) firstByteMs = Date.now() - t0;
                chars += text.length;
                onChunk(text);
            }
        }
        perfLog(`request  model=${modelUsed ?? '?'}  first-text=${firstByteMs < 0 ? 'none' : (firstByteMs / 1000).toFixed(1) + 's'}  total=${((Date.now() - t0) / 1000).toFixed(1)}s  out=${chars} chars`);
    }

    async complete(messages: Message[], opts?: CompletionOptions): Promise<string> {
        let result = '';
        await this.stream(messages, chunk => { result += chunk; }, opts);
        return result;
    }

    static getCachedQuota(context: vscode.ExtensionContext): number {
        return context.globalState.get<number>(QUOTA_KEY) ?? 5;
    }

    static getLastModelUsed(context: vscode.ExtensionContext): string | undefined {
        return context.globalState.get<string>(MODEL_KEY);
    }
}
