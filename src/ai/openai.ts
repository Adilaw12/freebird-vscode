import * as vscode from 'vscode';
import { AIProvider, Message } from './provider';

export class OpenAIProvider implements AIProvider {
    private get apiKey() {
        return vscode.workspace.getConfiguration('openpilot').get<string>('apiKey', '');
    }

    private get model() {
        return vscode.workspace.getConfiguration('openpilot').get<string>('model') || 'gpt-4o-mini';
    }

    async stream(messages: Message[], onChunk: (text: string) => void): Promise<void> {
        if (!this.apiKey) {
            throw new Error('No OpenAI API key set. Go to Settings → OpenPilot → API Key.');
        }

        const response = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${this.apiKey}`
            },
            body: JSON.stringify({
                model: this.model,
                stream: true,
                messages: [{ role: 'system', content: 'You are OpenPilot, a free AI coding assistant for VS Code.' }, ...messages]
            })
        });

        if (!response.ok) {
            const err = await response.text();
            throw new Error(`OpenAI API error: ${err}`);
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
                    const text = parsed.choices?.[0]?.delta?.content;
                    if (text) onChunk(text);
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
