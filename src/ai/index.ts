import * as vscode from 'vscode';
import { AIProvider } from './provider';
import { OllamaProvider } from './ollama';
import { AnthropicProvider } from './anthropic';
import { OpenAIProvider } from './openai';
import { DeepSeekProvider } from './deepseek';
import { QwenProvider } from './qwen';

export function getProvider(): AIProvider {
    const backend = vscode.workspace.getConfiguration('freebird').get<string>('backend', 'ollama');
    switch (backend) {
        case 'anthropic': return new AnthropicProvider();
        case 'openai': return new OpenAIProvider();
        case 'deepseek': return new DeepSeekProvider();
        case 'qwen': return new QwenProvider();
        default: return new OllamaProvider();
    }
}

export type { AIProvider, Message, CompletionOptions, ToolSchema, NativeToolCall, RichMessage, StreamToolsResult, ToolResultEntry, FIMProvider } from './provider';
