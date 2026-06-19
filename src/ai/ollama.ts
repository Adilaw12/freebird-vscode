import * as vscode from 'vscode';
import { AIProvider, CompletionOptions, Message, FIMProvider } from './provider';

export class OllamaProvider implements AIProvider, FIMProvider {
    private get url() {
        return vscode.workspace.getConfiguration('freebird').get<string>('ollamaUrl', 'http://localhost:11434');
    }

    private get model() {
        return vscode.workspace.getConfiguration('freebird').get<string>('model') || 'qwen2.5-coder';
    }

    async stream(messages: Message[], onChunk: (text: string) => void, opts?: CompletionOptions): Promise<void> {
        const response = await fetch(`${this.url}/api/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: this.model,
                messages,
                stream: true,
                ...(opts && {
                    options: {
                        ...(opts.maxTokens !== undefined && { num_predict: opts.maxTokens }),
                        ...(opts.temperature !== undefined && { temperature: opts.temperature })
                    }
                })
            })
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

    async complete(messages: Message[], opts?: CompletionOptions): Promise<string> {
        let result = '';
        await this.stream(messages, chunk => { result += chunk; }, opts);
        return result;
    }

    async fillInMiddle(prefix: string, suffix: string, opts?: CompletionOptions): Promise<string> {
        const response = await fetch(`${this.url}/api/generate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: this.model,
                prompt: prefix,
                suffix,
                stream: false,
                options: {
                    num_predict: opts?.maxTokens ?? 128,
                    temperature: opts?.temperature ?? 0.2,
                    stop: ['\n\n', '\r\n\r\n']
                }
            })
        });

        if (!response.ok) {
            throw new Error(`Ollama FIM error: ${response.statusText}`);
        }

        const data = await response.json() as { response?: string };
        return data.response ?? '';
    }
}
