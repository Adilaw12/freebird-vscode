import * as vscode from 'vscode';
import { AIProvider, CompletionOptions, Message, ToolSchema, RichMessage, StreamToolsResult, NativeToolCall } from './provider';
import { sseData } from './sse';
import { getApiKey, KeyProvider } from './keys';

export class OpenAIProvider implements AIProvider {
    readonly supportsNativeTools = true;

    protected get baseUrl() { return 'https://api.openai.com/v1'; }

    /** Which provider's stored key to use; subclasses override. */
    protected get keyProvider(): KeyProvider { return 'openai'; }

    protected get apiKey() {
        return getApiKey(this.keyProvider);
    }

    protected get model() {
        return vscode.workspace.getConfiguration('freebird').get<string>('model') || 'gpt-4o-mini';
    }

    protected get providerName() { return 'OpenAI'; }

    async stream(messages: Message[], onChunk: (text: string) => void, opts?: CompletionOptions): Promise<void> {
        if (!this.apiKey) {
            throw new Error(`No ${this.providerName} API key set. Run "Freebird: Configure AI Backend" (or "Freebird: Set API Key") to add one.`);
        }

        const response = await fetch(`${this.baseUrl}/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${this.apiKey}`
            },
            body: JSON.stringify({
                model: this.model,
                stream: true,
                messages: [{ role: 'system', content: 'You are Freebird, a free AI coding assistant for VS Code.' }, ...messages],
                ...(opts?.maxTokens !== undefined && { max_tokens: opts.maxTokens }),
                ...(opts?.temperature !== undefined && { temperature: opts.temperature })
            })
        });

        if (!response.ok) {
            const err = await response.text();
            throw new Error(`${this.providerName} API error: ${err}`);
        }

        await readOpenAIStream(response, onChunk);
    }

    async streamWithTools(
        messages: RichMessage[],
        tools: ToolSchema[],
        onChunk: (text: string) => void,
        opts?: CompletionOptions
    ): Promise<StreamToolsResult> {
        if (!this.apiKey) {
            throw new Error(`No ${this.providerName} API key set. Run "Freebird: Configure AI Backend" (or "Freebird: Set API Key") to add one.`);
        }

        const openaiMessages = convertToOpenAIMessages(messages);
        const openaiTools = tools.map(t => ({
            type: 'function' as const,
            function: {
                name: t.name,
                description: t.description,
                parameters: t.input_schema
            }
        }));

        const response = await fetch(`${this.baseUrl}/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${this.apiKey}`
            },
            body: JSON.stringify({
                model: this.model,
                stream: true,
                messages: openaiMessages,
                tools: openaiTools,
                ...(opts?.maxTokens !== undefined && { max_tokens: opts.maxTokens }),
                ...(opts?.temperature !== undefined && { temperature: opts.temperature })
            })
        });

        if (!response.ok) {
            const err = await response.text();
            throw new Error(`${this.providerName} API error: ${err}`);
        }

        let text = '';
        const toolCallMap = new Map<number, { id: string; name: string; args: string }>();

        for await (const data of sseData(response)) {
            if (data === '[DONE]') break;
            try {
                const parsed = JSON.parse(data);
                const delta = parsed.choices?.[0]?.delta;
                if (!delta) continue;

                if (delta.content) {
                    text += delta.content;
                    onChunk(delta.content);
                }

                if (delta.tool_calls) {
                    for (const tc of delta.tool_calls) {
                        const idx = tc.index ?? 0;
                        if (!toolCallMap.has(idx)) {
                            toolCallMap.set(idx, { id: tc.id ?? '', name: tc.function?.name ?? '', args: '' });
                        }
                        const entry = toolCallMap.get(idx)!;
                        if (tc.id) entry.id = tc.id;
                        if (tc.function?.name) entry.name = tc.function.name;
                        if (tc.function?.arguments) entry.args += tc.function.arguments;
                    }
                }
            } catch { /* skip */ }
        }

        const toolCalls: NativeToolCall[] = [];
        for (const [, entry] of toolCallMap) {
            try {
                toolCalls.push({ id: entry.id, name: entry.name, input: JSON.parse(entry.args || '{}') });
            } catch {
                toolCalls.push({ id: entry.id, name: entry.name, input: {} });
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

// ── Shared helpers for OpenAI-compatible providers ──────────────────────────

export async function readOpenAIStream(response: Response, onChunk: (text: string) => void): Promise<void> {
    for await (const data of sseData(response)) {
        if (data === '[DONE]') return;
        try {
            const parsed = JSON.parse(data);
            const text = parsed.choices?.[0]?.delta?.content;
            if (text) onChunk(text);
        } catch { /* skip */ }
    }
}

function convertToOpenAIMessages(messages: RichMessage[]): unknown[] {
    const result: unknown[] = [
        { role: 'system', content: 'You are Freebird, a free AI coding assistant for VS Code.' }
    ];

    for (const msg of messages) {
        if (msg.role === 'user') {
            result.push({ role: 'user', content: msg.content ?? '' });
        } else if (msg.role === 'assistant') {
            const m: Record<string, unknown> = { role: 'assistant', content: msg.content ?? '' };
            if (msg.toolCalls?.length) {
                m.tool_calls = msg.toolCalls.map(tc => ({
                    id: tc.id,
                    type: 'function',
                    function: { name: tc.name, arguments: JSON.stringify(tc.input) }
                }));
            }
            result.push(m);
        } else if (msg.role === 'tool_result') {
            for (const tr of msg.toolResults ?? []) {
                // tr.image (e.g. verify_diagram's rendered PNG) is intentionally
                // dropped here — OpenAI/DeepSeek/Qwen vision uses an `image_url`
                // content-block shape, different from Anthropic's `source` shape
                // this field was added for. Not wired up for v1; these providers
                // still get the textual render-success/failure message below.
                result.push({
                    role: 'tool',
                    tool_call_id: tr.toolCallId,
                    content: tr.output
                });
            }
        }
    }

    return result;
}
