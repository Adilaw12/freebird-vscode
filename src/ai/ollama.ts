import * as vscode from 'vscode';
import { AIProvider, CompletionOptions, Message, FIMProvider } from './provider';
import { LineBuffer } from './sse';

// Does not set supportsImageInput: Ollama's own multimodal convention is a
// separate `images: string[]` field per message, not the Anthropic-shaped
// `{mimeType, base64}` object Message.image carries — not wired up for v1,
// so verify_diagram's rendered image is never attached here (loop.ts only
// attaches it when provider.supportsImageInput is true).
export class OllamaProvider implements AIProvider, FIMProvider {
    private get url() {
        return vscode.workspace.getConfiguration('freebird').get<string>('ollamaUrl', 'http://localhost:11434');
    }

    private get model() {
        return vscode.workspace.getConfiguration('freebird').get<string>('model') || 'qwen2.5-coder';
    }

    async stream(messages: Message[], onChunk: (text: string) => void, opts?: CompletionOptions): Promise<void> {
        let response: Response;
        try {
            response = await fetch(`${this.url}/api/chat`, {
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
            }),
            signal: opts?.signal
        });
        } catch (err: any) {
            if (opts?.signal?.aborted) throw err;
            // fetch throws a bare TypeError on connection refusal — turn it
            // into something actionable instead of "fetch failed".
            const e = new Error(`Ollama isn't reachable at ${this.url}. Start it with \`ollama serve\`, or switch backend via "Freebird: Configure AI Backend".`) as any;
            e.code = 'OLLAMA_UNREACHABLE';
            throw e;
        }

        if (!response.ok) {
            throw new Error(`Ollama returned ${response.status}${response.statusText ? ' ' + response.statusText : ''}. Is the model pulled? Try: ollama pull ${this.model}`);
        }

        const reader = response.body!.getReader();
        const buffer = new LineBuffer();
        const handle = (line: string) => {
            if (!line.trim()) return;
            try {
                const data = JSON.parse(line);
                if (data.message?.content) onChunk(data.message.content);
            } catch { /* skip malformed lines */ }
        };

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer.push(value).forEach(handle);
        }
        buffer.flush().forEach(handle);
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
            }),
            signal: opts?.signal
        });

        if (!response.ok) {
            throw new Error(`Ollama FIM error: ${response.statusText}`);
        }

        const data = await response.json() as { response?: string };
        return data.response ?? '';
    }
}
