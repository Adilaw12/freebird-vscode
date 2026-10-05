import * as vscode from 'vscode';
import { OpenAIProvider } from './openai';
import { KeyProvider } from './keys';

export class DeepSeekProvider extends OpenAIProvider {
    protected get baseUrl() { return 'https://api.deepseek.com'; }
    protected get providerName() { return 'DeepSeek'; }
    protected get keyProvider(): KeyProvider { return 'deepseek'; }

    protected get model() {
        return vscode.workspace.getConfiguration('freebird').get<string>('model') || 'deepseek-reasoner';
    }
}
