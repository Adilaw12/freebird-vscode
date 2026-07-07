import * as vscode from 'vscode';
import { AIProvider, Message, CompletionOptions } from './provider';
import { getStoredSession } from '../auth/github';

const API_BASE  = 'https://freebird-backend.vercel.app';
const QUOTA_KEY = 'freebird.cloudQuotaRemaining';

/**
 * CloudProvider — calls the Freebird Vercel backend.
 *
 * Two modes:
 *   'quota'    → POST /api/chat    — enforces the daily free-edit quota
 *   'fallback' → POST /api/fallback — used when Ollama fails; enforces the same
 *                                     daily quota (shared keys) plus an hourly
 *                                     IP burst limit to prevent abuse
 */
export class CloudProvider implements AIProvider {
    private readonly context: vscode.ExtensionContext;
    private readonly sessionId: string;
    private readonly mode: 'quota' | 'fallback';

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
        const endpoint = this.mode === 'fallback'
            ? `${API_BASE}/api/fallback`
            : `${API_BASE}/api/chat`;

        // sessionId (machineId) is still sent as a legacy fallback identity for
        // as long as the backend supports it during rollout. authToken — issued
        // after GitHub sign-in — is the real, unspoofable identity. licenseKey
        // lets Pro/Enterprise subscribers skip quota entirely server-side.
        const session    = await getStoredSession(this.context);
        const licenseKey = vscode.workspace.getConfiguration('freebird').get<string>('licenseKey', '').trim();

        const body = {
            messages,
            sessionId:  this.sessionId,
            authToken:  session?.sessionToken,
            licenseKey: licenseKey || undefined,
            maxTokens:  opts?.maxTokens ?? 2048
        };

        const res = await fetch(endpoint, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify(body),
            signal:  AbortSignal.timeout(30_000)
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

            if (code === 'IP_RATE_LIMITED') {
                const err  = new Error('IP_RATE_LIMITED') as any;
                err.code   = 'IP_RATE_LIMITED';
                throw err;
            }

            const err  = new Error('Rate limited') as any;
            err.code   = code;
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

        // Stream plain-text response
        const reader  = res.body!.getReader();
        const decoder = new TextDecoder();

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            const text = decoder.decode(value, { stream: true });
            if (text) onChunk(text);
        }
    }

    async complete(messages: Message[], opts?: CompletionOptions): Promise<string> {
        let result = '';
        await this.stream(messages, chunk => { result += chunk; }, opts);
        return result;
    }

    static getCachedQuota(context: vscode.ExtensionContext): number {
        return context.globalState.get<number>(QUOTA_KEY) ?? 5;
    }
}
