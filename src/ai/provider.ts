export interface Message {
    role: 'user' | 'assistant';
    content: string;
}

export interface CompletionOptions {
    maxTokens?: number;
    temperature?: number;
}

// ── Native tool calling ──────────────────────────────────────────────────────

export interface ToolSchema {
    name: string;
    description: string;
    input_schema: {
        type: 'object';
        properties: Record<string, unknown>;
        required?: string[];
    };
}

export interface NativeToolCall {
    id: string;
    name: string;
    input: Record<string, unknown>;
}

export interface ToolResultEntry {
    toolCallId: string;
    output: string;
    isError?: boolean;
}

export interface RichMessage {
    role: 'user' | 'assistant' | 'tool_result';
    content?: string;
    toolCalls?: NativeToolCall[];
    toolResults?: ToolResultEntry[];
}

export interface StreamToolsResult {
    text: string;
    toolCalls: NativeToolCall[];
}

// ── Provider interface ───────────────────────────────────────────────────────

export interface AIProvider {
    stream(messages: Message[], onChunk: (text: string) => void, opts?: CompletionOptions): Promise<void>;
    complete(messages: Message[], opts?: CompletionOptions): Promise<string>;

    readonly supportsNativeTools?: boolean;
    streamWithTools?(
        messages: RichMessage[],
        tools: ToolSchema[],
        onChunk: (text: string) => void,
        opts?: CompletionOptions
    ): Promise<StreamToolsResult>;
}

// ── FIM (Fill-in-the-Middle) for tab completion ──────────────────────────────

export interface FIMProvider {
    fillInMiddle(prefix: string, suffix: string, opts?: CompletionOptions): Promise<string>;
}
