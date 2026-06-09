import * as vscode from 'vscode';
import { AIProvider, Message } from './provider';

export class AnthropicProvider implements AIProvider {
    private get apiKey() {
        return vscode.workspace.getConfiguration('openpilot').get<string>('apiKey', '');
    }

    private get model() {
        return vscode.workspace.getConfiguration('openpilot').get<string>('model') || 'claude-haiku-4-5-20251001';
    }

    async stream(messages: Message[], onChunk: (text: string) => void): Promise<void> {
        if (!this.apiKey) {
            throw new Error('No Anthropic API key set. Go to Settings → OpenPilot → API Key.');
        }

        const response = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': this.apiKey,
                'anthropic-version': '2023-06-01'
            },
            body: JSON.stringify({
                model: this.model,
                max_tokens: 4096,
                stream: true,
                messages
            })
        });

        if (!response.ok) {
            const err = await response.text();
            throw new Error(`Anthropic API error: ${err}`);
        }

        const reader = response.body!.getReader();
        const decoder = new TextDecoder();

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            for (const line of decoder.decode(value).split('\n')) {
                if (!line.startsWith('data: ')) continue;
                const data = line.slice(6).trim();
                if (data === '[DONE]') return;
                try {
                    const parsed = JSON.parse(data);
                    if (parsed.type === 'content_block_delta' && parsed.delta?.text) {
                        onChunk(parsed.delta.text);
                    }
                } catch { /* skip */ }
            }
        }
    }

    async complete(messages: Message[]): Promise<string> {
        let result = '';
        await this.stream(messages, chunk => { result += chunk; });
        return result;
    }
}
