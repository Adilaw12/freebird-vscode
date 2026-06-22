import * as vscode from 'vscode';
import { AIProvider, Message, CompletionOptions } from './provider';
import { OllamaProvider } from './ollama';
import { AnthropicProvider } from './anthropic';
import { OpenAIProvider } from './openai';
import { DeepSeekProvider } from './deepseek';
import { QwenProvider } from './qwen';
import { CloudProvider } from './cloud';
import { trackEvent } from '../telemetry';

// Re-export so callers don't need to import CloudProvider separately
export { CloudProvider };

/**
 * Returns the appropriate AI provider based on user config.
 *
 * Routing logic:
 *
 * BYOK backends (anthropic / openai / deepseek / qwen):
 *   → Return provider directly. User has explicitly configured these.
 *
 * ollama (explicit):
 *   → Return a FallbackProvider: tries Ollama first, falls back to Cloud
 *     if Ollama is unreachable. Shows a one-time notification on fallback.
 *
 * default (new installs / no config):
 *   → Return CloudProvider directly. No Ollama dependency on first run.
 *     User can switch to Ollama via freebird.configure once they have it set up.
 */
export function getProvider(context: vscode.ExtensionContext, sessionId: string): AIProvider {
    const config  = vscode.workspace.getConfiguration('freebird');
    const backend = config.get<string>('backend', 'cloud');

    switch (backend) {
        case 'anthropic': return new AnthropicProvider();
        case 'openai':    return new OpenAIProvider();
        case 'deepseek':  return new DeepSeekProvider();
        case 'qwen':      return new QwenProvider();

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
