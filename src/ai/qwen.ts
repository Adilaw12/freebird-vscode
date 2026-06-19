import * as vscode from 'vscode';
import { OpenAIProvider } from './openai';

export class QwenProvider extends OpenAIProvider {
    protected get baseUrl() { return 'https://dashscope.aliyuncs.com/compatible-mode/v1'; }
    protected get providerName() { return 'Qwen'; }

    protected get model() {
        return vscode.workspace.getConfiguration('freebird').get<string>('model') || 'qwen2.5-coder-32b-instruct';
    }
}
