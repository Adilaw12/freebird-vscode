import * as vscode from 'vscode';
import { OpenAIProvider } from './openai';

export class KimiProvider extends OpenAIProvider {
    protected get baseUrl() { return 'https://api.moonshot.ai/v1'; }
    protected get providerName() { return 'Kimi'; }

    protected get model() {
        // Defaults to the latest (K3, 2.8T MoE, 1M token context). Override
        // freebird.model to 'kimi-k2' for the previous generation instead.
        return vscode.workspace.getConfiguration('freebird').get<string>('model') || 'kimi-k3';
    }
}
