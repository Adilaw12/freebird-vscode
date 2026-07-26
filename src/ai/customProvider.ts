import * as vscode from 'vscode';
import { OpenAIProvider } from './openai';

/**
 * Points at any OpenAI-compatible chat completions API (OpenRouter, Together,
 * Groq, Fireworks, a self-hosted vLLM/LM Studio server, etc.) via two settings
 * with no built-in defaults, unlike the other BYOK providers — there's no
 * sensible universal default base URL or model across arbitrary providers, so
 * both must be explicitly configured.
 */
export class CustomProvider extends OpenAIProvider {
    protected get providerName() { return 'Custom Provider'; }

    protected get baseUrl() {
        const url = vscode.workspace.getConfiguration('freebird').get<string>('customBaseUrl', '').trim();
        if (!url) {
            throw new Error(
                'Custom Provider requires a base URL. Go to Settings → Freebird → Custom Base Url ' +
                '(e.g. https://openrouter.ai/api/v1 for OpenRouter).'
            );
        }
        return url.replace(/\/$/, '');
    }

    protected get model() {
        const model = vscode.workspace.getConfiguration('freebird').get<string>('model', '').trim();
        if (!model) {
            throw new Error(
                'Custom Provider requires a model name. Go to Settings → Freebird → Model ' +
                '(e.g. openai/gpt-4o for OpenRouter).'
            );
        }
        return model;
    }
}
