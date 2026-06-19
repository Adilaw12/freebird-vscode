import * as vscode from 'vscode';
import { AIProvider, CompletionOptions, Message, ToolSchema, RichMessage, StreamToolsResult, NativeToolCall } from './provider';

export class AnthropicProvider implements AIProvider {
    readonly supportsNativeTools = true;

    private get apiKey() {
        return vscode.workspace.getConfiguration('freebird').get<string>('apiKey', '');
    }

    private get model() {
        return vscode.workspace.getConfiguration('freebird').get<string>('model') || 'claude-haiku-4-5-20251001';
    }

    async stream(messages: Message[], onChunk: (text: string) => void, opts?: CompletionOptions): Promise<void> {
        if (!this.apiKey) {
            throw new Error('No Anthropic API key set. Go to Settings → Freebird → API Key.');
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
                max_tokens: opts?.maxTokens ?? 4096,
                stream: true,
                messages,
                ...(opts?.temperature !== undefined && { temperature: opts.temperature })
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

    async streamWithTools(
        messages: RichMessage[],
        tools: ToolSchema[],
        onChunk: (text: string) => void,
        opts?: CompletionOptions
    ): Promise<StreamToolsResult> {
        if (!this.apiKey) {
            throw new Error('No Anthropic API key set. Go to Settings → Freebird → API Key.');
        }

        const anthropicMessages = convertToAnthropicMessages(messages);
        const anthropicTools = tools.map(t => ({
            name: t.name,
            description: t.description,
            input_schema: t.input_schema
        }));

        const response = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': this.apiKey,
                'anthropic-version': '2023-06-01'
            },
            body: JSON.stringify({
                model: this.model,
                max_tokens: opts?.maxTokens ?? 4096,
                stream: true,
                messages: anthropicMessages,
                tools: anthropicTools,
                ...(opts?.temperature !== undefined && { temperature: opts.temperature })
            })
        });

        if (!response.ok) {
            const err = await response.text();
            throw new Error(`Anthropic API error: ${err}`);
        }

        let text = '';
        const toolCalls: NativeToolCall[] = [];
        let currentToolId = '';
        let currentToolName = '';
        let currentToolInput = '';

        const reader = response.body!.getReader();
        const decoder = new TextDecoder();

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            for (const line of decoder.decode(value).split('\n')) {
                if (!line.startsWith('data: ')) continue;
                const data = line.slice(6).trim();
                if (data === '[DONE]') break;
                try {
                    const event = JSON.parse(data);
                    switch (event.type) {
                        case 'content_block_start':
                            if (event.content_block?.type === 'tool_use') {
                                currentToolId = event.content_block.id;
                                currentToolName = event.content_block.name;
                                currentToolInput = '';
                            }
                            break;
                        case 'content_block_delta':
                            if (event.delta?.type === 'text_delta' && event.delta.text) {
                                text += event.delta.text;
                                onChunk(event.delta.text);
                            } else if (event.delta?.type === 'input_json_delta' && event.delta.partial_json) {
                                currentToolInput += event.delta.partial_json;
                            }
                            break;
                        case 'content_block_stop':
                            if (currentToolId) {
                                try {
                                    const input = currentToolInput ? JSON.parse(currentToolInput) : {};
                                    toolCalls.push({ id: currentToolId, name: currentToolName, input });
                                } catch {
                                    toolCalls.push({ id: currentToolId, name: currentToolName, input: {} });
                                }
                                currentToolId = '';
                                currentToolName = '';
                                currentToolInput = '';
                            }
                            break;
                    }
                } catch { /* skip malformed */ }
            }
        }

        return { text, toolCalls };
    }

    async complete(messages: Message[], opts?: CompletionOptions): Promise<string> {
        let result = '';
        await this.stream(messages, chunk => { result += chunk; }, opts);
        return result;
    }
}

function convertToAnthropicMessages(messages: RichMessage[]): unknown[] {
    const result: unknown[] = [];

    for (const msg of messages) {
        if (msg.role === 'user') {
            result.push({ role: 'user', content: msg.content ?? '' });
        } else if (msg.role === 'assistant') {
            const content: unknown[] = [];
            if (msg.content) {
                content.push({ type: 'text', text: msg.content });
            }
            if (msg.toolCalls) {
                for (const tc of msg.toolCalls) {
                    content.push({
                        type: 'tool_use',
                        id: tc.id,
                        name: tc.name,
                        input: tc.input
                    });
                }
            }
            result.push({ role: 'assistant', content });
        } else if (msg.role === 'tool_result') {
            const content = (msg.toolResults ?? []).map(tr => ({
                type: 'tool_result' as const,
                tool_use_id: tr.toolCallId,
                content: tr.output,
                ...(tr.isError && { is_error: true })
            }));
            result.push({ role: 'user', content });
        }
    }

    return result;
}
