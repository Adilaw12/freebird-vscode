import * as vscode from 'vscode';
import { AIProvider, Message, CompletionOptions, FIMProvider } from './provider';
import { OllamaProvider } from './ollama';
import { AnthropicProvider } from './anthropic';
import { OpenAIProvider } from './openai';
import { DeepSeekProvider } from './deepseek';
import { QwenProvider } from './qwen';
import { KimiProvider } from './kimi';
import { CustomProvider } from './customProvider';
import { CloudProvider } from './cloud';
import { trackEvent } from '../telemetry';

// Re-export so callers don't need to import CloudProvider separately
export { CloudProvider };

export const BYOK_BACKENDS = new Set(['anthropic', 'openai', 'deepseek', 'qwen', 'kimi', 'custom']);

/**
 * Returns the appropriate AI provider based on user config.
 *
 * Routing logic (v0.8.9):
 *
 * BYOK backends (anthropic / openai / deepseek / qwen / kimi / custom):
 *   → FREE for everyone. The user supplies their own API key, calls go
 *     direct from their machine to the provider, and Freebird's servers
 *     never touch the request — so there is nothing for us to meter and
 *     no reason to gate it. (Gating BYOK behind Pro was charging for the
 *     one thing that costs us nothing, while the market — Continue, Cline,
 *     Roo — gives it away. Pro is now about what DOES cost us something:
 *     unlimited cloud edits and the full agent mode.)
 *
 * ollama (explicit):
 *   → Return a FallbackProvider: tries Ollama first, falls back to Cloud
 *     if Ollama is unreachable. Shows a one-time notification on fallback.
 *     Ollama is always free.
 *
 * default (new installs / no config):
 *   → Return CloudProvider directly. No Ollama dependency on first run.
 *     User can switch to Ollama via freebird.configure once they have it set up.
 */
export function getProvider(context: vscode.ExtensionContext, sessionId: string): AIProvider {
    const config  = vscode.workspace.getConfiguration('freebird');
    const backend = config.get<string>('backend', 'cloud');

    if (BYOK_BACKENDS.has(backend)) {
        switch (backend) {
            case 'anthropic': return new AnthropicProvider();
            case 'openai':    return new OpenAIProvider();
            case 'deepseek':  return new DeepSeekProvider();
            case 'qwen':      return new QwenProvider();
            case 'kimi':      return new KimiProvider();
            case 'custom':    return new CustomProvider();
        }
    }

    switch (backend) {
        case 'ollama':
            // Explicit Ollama: try it, fall back to cloud on failure
            return new FallbackProvider(
                new OllamaProvider(),
                new CloudProvider(context, sessionId),
                context
            );

        default:
            // 'cloud' or unrecognised — use cloud tier (Gemini Flash, 10 free edits/day)
            return new CloudProvider(context, sessionId);
    }
}

/**
 * FallbackProvider — wraps a primary provider and falls back to a secondary
 * when the primary throws a network/connection error.
 *
 * Used for: Ollama (primary) → Cloud (secondary)
 * Does NOT fall back on quota errors (QUOTA_EXCEEDED) — those bubble up
 * so the caller can show the upgrade prompt.
 */
/**
 * Persisted Ollama-unreachable cooldown (globalState, survives window reloads).
 *
 * Tab completion calls getProvider() + FallbackProvider on every debounced
 * keystroke (~350ms). Without this, each keystroke while Ollama is down
 * re-attempts the connection, fires trackEvent('ollama_fallback'), and
 * makes a real cloud completion call — turning one genuine outage into
 * hundreds of telemetry events and wasted cloud calls per session. During
 * the cooldown, Ollama is skipped entirely and requests go straight to
 * cloud without re-firing telemetry; it retries once the window elapses.
 *
 * 10 minutes rather than the original 60s: "Ollama isn't running" almost
 * never resolves itself mid-session, so a short window still lets a long
 * active-typing session generate dozens of events (one per elapsed window).
 * A longer window doesn't cost UX — fallback is already silent after the
 * one-time notification — it just means fewer, more meaningful events.
 */
const COOLDOWN_KEY = 'freebird.ollamaUnreachableUntil';
const OLLAMA_RETRY_MS = 10 * 60_000;

class FallbackProvider implements AIProvider {
    constructor(
        private readonly primary: AIProvider,
        private readonly secondary: AIProvider,
        private readonly context: vscode.ExtensionContext
    ) {}

    // Persisted (not module-level) so a window reload doesn't reset the
    // cooldown and re-fire ollama_fallback for the same outage.
    private cooling(): boolean {
        return Date.now() < (this.context.globalState.get<number>(COOLDOWN_KEY) ?? 0);
    }

    private setCooldown(until: number): void {
        void this.context.globalState.update(COOLDOWN_KEY, until);
    }

    /** Tab completion: Ollama's FIM endpoint, else the same prompt on the cloud provider. */
    async fillInMiddle(prefix: string, suffix: string, opts?: CompletionOptions): Promise<string> {
        const cloud = () => this.secondary.complete(
            [{ role: 'user', content: opts?.fallbackPrompt ?? `${prefix}<CURSOR>${suffix}` }],
            { ...opts, isTabCompletion: true }
        );
        if (this.cooling()) return cloud();
        try {
            const result = await (this.primary as unknown as FIMProvider).fillInMiddle(prefix, suffix, opts);
            this.setCooldown(0);
            return result;
        } catch (err: any) {
            if (opts?.signal?.aborted) throw err;
            this.setCooldown(Date.now() + OLLAMA_RETRY_MS);
            trackEvent('ollama_fallback');
            void this.notifyFallback(); // don't hold the completion hostage to a notification click
            return cloud();
        }
    }

    async stream(
        messages: Message[],
        onChunk: (text: string) => void,
        opts?: CompletionOptions
    ): Promise<void> {
        if (this.cooling()) {
            return this.secondary.stream(messages, onChunk, opts);
        }
        try {
            await this.primary.stream(messages, onChunk, opts);
            this.setCooldown(0);
        } catch (err: any) {
            // Don't fall back on quota errors — surface them directly
            if (err?.code === 'QUOTA_EXCEEDED' || opts?.signal?.aborted) throw err;

            // Ollama unreachable — fall back to cloud
            this.setCooldown(Date.now() + OLLAMA_RETRY_MS);
            trackEvent('ollama_fallback');
            await this.notifyFallback();
            await this.secondary.stream(messages, onChunk, opts);
        }
    }

    async complete(messages: Message[], opts?: CompletionOptions): Promise<string> {
        if (this.cooling()) {
            return this.secondary.complete(messages, opts);
        }
        try {
            const result = await this.primary.complete(messages, opts);
            this.setCooldown(0);
            return result;
        } catch (err: any) {
            if (err?.code === 'QUOTA_EXCEEDED' || opts?.signal?.aborted) throw err;
            this.setCooldown(Date.now() + OLLAMA_RETRY_MS);
            trackEvent('ollama_fallback');
            await this.notifyFallback();
            return this.secondary.complete(messages, opts);
        }
    }

    private async notifyFallback(): Promise<void> {
        // Show once per session
        const shown = this.context.globalState.get<boolean>('freebird.fallbackNotified');
        if (shown) return;
        await this.context.globalState.update('freebird.fallbackNotified', true);

        const action = await vscode.window.showWarningMessage(
            'Ollama is not reachable — using your free Freebird cloud edits instead (10/day).',
            'Set up Ollama',
            'Dismiss'
        );
        if (action === 'Set up Ollama') {
            vscode.env.openExternal(vscode.Uri.parse('https://ollama.com/download'));
        }
    }
}
