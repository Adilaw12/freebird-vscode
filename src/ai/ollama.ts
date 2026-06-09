import * as vscode from 'vscode';
import { AIProvider, Message } from './provider';

export class OllamaProvider implements AIProvider {
    private get url() {
        return vscode.workspace.getConfiguration('openpilot').get<string>('ollamaUrl', 'http://localhost:11434');
    }

    private get model() {
        return vscode.workspace.getConfiguration('openpilot').get<string>('model') || 'qwen2.5-coder';
    }

    async stream(messages: Message[], onChunk: (text: string) => void): Promise<void> {
        const response = await fetch(`${this.url}/api/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: this.model, messages, stream: true })
        });

        if (!response.ok) {
            throw new Error(`Ollama error: ${response.statusText}. Is Ollama running? Start it with: ollama serve`);
        }

        const reader = response.body!.getReader();
        const decoder = new TextDecoder();

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            for (const line of decoder.decode(value).split('\n').filter(Boolean)) {
                try {
                    const data = JSON.parse(line);
                    if (data.message?.content) onChunk(data.message.content);
                } catch { /* skip malformed lines */ }
            }
        }
    }

    async complete(messages: Message[]): Promise<string> {
        let result = '';
        await this.stream(messages, chunk => { result += chunk; });
        return result;
    }
}
