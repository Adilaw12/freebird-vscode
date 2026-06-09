import * as vscode from 'vscode';
import { AIProvider } from './provider';
import { OllamaProvider } from './ollama';
import { AnthropicProvider } from './anthropic';
import { OpenAIProvider } from './openai';

export function getProvider(): AIProvider {
    const backend = vscode.workspace.getConfiguration('openpilot').get<string>('backend', 'ollama');
    switch (backend) {
        case 'anthropic': return new AnthropicProvider();
        case 'openai': return new OpenAIProvider();
        default: return new OllamaProvider();
    }
}

export type { AIProvider, Message } from './provider';
