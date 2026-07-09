import * as vscode from 'vscode';
import { AIProvider, Message, CompletionOptions } from './provider';
import { OllamaProvider } from './ollama';
import { AnthropicProvider } from './anthropic';
import { OpenAIProvider } from './openai';
import { DeepSeekProvider } from './deepseek';
import { QwenProvider } from './qwen';
import { CloudProvider } from './cloud';
import { trackEvent } from '../telemetry';
import { getCachedLicenseStatus, UPGRADE_URL } from '../license/validator';

// Re-export so callers don't need to import CloudProvider separately
export { CloudProvider };

const BYOK_BACKENDS = new Set(['anthropic', 'openai', 'deepseek', 'qwen']);

/**
 * Returns the appropriate AI provider based on user config.
 *
 * Routing logic:
 *
 * BYOK backends (anthropic / openai / deepseek / qwen):
 *   → Requires an active Pro/Team/Enterprise license (checked against the
 *     cache warmed at activation — see getCachedLicenseStatus). Without one,
 *     silently routes to CloudProvider instead of honoring the BYOK setting.
 *     This closes a real gap: previously any free user could switch
 *     Backend to e.g. "openai", supply their own key, and get fully
 *     unmetered use with zero license required — no spoofing needed, just
 *     a settings dropdown.
 *
 * ollama (explicit):
 *   → Return a FallbackProvider: tries Ollama first, falls back to Cloud
 *     if Ollama is unreachable. Shows a one-time notification on fallback.
 *     Ollama is always free — no license required.
 *
 * default (new installs / no config):
 *   → Return CloudProvider directly. No Ollama dependency on first run.
 *     User can switch to Ollama via freebird.configure once they have it set up.
 */
export function getProvider(context: vscode.ExtensionContext, sessionId: string): AIProvider {
    const config  = vscode.workspace.getConfiguration('freebird');
    const backend = config.get<string>('backend', 'cloud');

    if (BYOK_BACKENDS.has(backend)) {
        if (getCachedLicenseStatus().isPro) {
            switch (backend) {
                case 'anthropic': return new AnthropicProvider();
                case 'openai':    return new OpenAIProvider();
                case 'deepseek':  return new DeepSeekProvider();
                case 'qwen':      return new QwenProvider();
            }
        }
        // Not licensed — fall back to the free cloud tier instead of honoring
        // the BYOK setting, and let them know once per session why.
        trackEvent('byok_blocked_no_license');
        notifyByokRequiresPro(context);
        return new CloudProvider(context, sessionId);
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
            // 'cloud' or unrecognised — use cloud tier (Gemini Flash, 5/day free)
            return new CloudProvider(context, sessionId);
    }
}

let byokWarningShown = false;
function notifyByokRequiresPro(context: vscode.ExtensionContext): void {
    if (byokWarningShown) return;
    byokWarningShown = true;

    vscode.window.showWarningMessage(
        'Your Backend setting is a bring-your-own-key model, but that requires an active Pro/Team/Enterprise license — using the free cloud tier instead for now.',
        'Upgrade to Pro',
        'Dismiss'
    ).then(choice => {
        if (choice === 'Upgrade to Pro') {
            vscode.env.openExternal(vscode.Uri.parse(UPGRADE_URL));
        }
    });
}

/**
 * FallbackProvider — wraps a primary provider and falls back to a secondary
 * when the primary throws a network/connection error.
 *
 * Used for: Ollama (primary) → Cloud (secondary)
 * Does NOT fall back on quota errors (QUOTA_EXCEEDED) — those bubble up
 * so the caller can show the upgrade prompt.
 */
class FallbackProvider implements AIProvider {
    constructor(
        private readonly primary: AIProvider,
        private readonly secondary: AIProvider,
        private readonly context: vscode.ExtensionContext
    ) {}

    async stream(
        messages: Message[],
        onChunk: (text: string) => void,
        opts?: CompletionOptions
    ): Promise<void> {
        try {
            await this.primary.stream(messages, onChunk, opts);
        } catch (err: any) {
            // Don't fall back on quota errors — surface them directly
            if (err?.code === 'QUOTA_EXCEEDED') throw err;

            // Ollama unreachable — fall back to cloud
            trackEvent('ollama_fallback');
            await this.notifyFallback();
            await this.secondary.stream(messages, onChunk, opts);
        }
    }

    async complete(messages: Message[], opts?: CompletionOptions): Promise<string> {
        try {
            return await this.primary.complete(messages, opts);
        } catch (err: any) {
            if (err?.code === 'QUOTA_EXCEEDED') throw err;
            trackEvent('ollama_fallback');
            await this.notifyFallback();
            return await this.secondary.complete(messages, opts);
        }
    }

    private async notifyFallback(): Promise<void> {
        // Show once per session
        const shown = this.context.globalState.get<boolean>('freebird.fallbackNotified');
        if (shown) return;
        await this.context.globalState.update('freebird.fallbackNotified', true);

        const action = await vscode.window.showWarningMessage(
            'Ollama is not reachable — using your free Freebird cloud edits instead (5/day).',
            'Set up Ollama',
            'Dismiss'
        );
        if (action === 'Set up Ollama') {
            vscode.env.openExternal(vscode.Uri.parse('https://ollama.com/download'));
        }
    }
}
