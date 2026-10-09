export interface Message {
    /** 'system' is only sent to providers that set supportsSystemMessages (Freebird Cloud). It lets the backend cache
     *  the system prompt; sent as a user message, the prompt is never cached. */
    role: 'user' | 'assistant' | 'system';
    content: string;
    /** Set when this message carries an image (e.g. verify_diagram's rendered
     *  PNG) for a provider that supports it — see AIProvider.supportsImageInput. */
    image?: { mimeType: string; base64: string };
}

export interface CompletionOptions {
    maxTokens?: number;
    temperature?: number;
    /** Set when this message originated from one of the built-in prompt templates —
     *  lets CloudProvider request the free-tier Haiku quality bonus for it. */
    templateId?: string;
    /** Set for tab-completion requests specifically — lets CloudProvider route
     *  free-tier completions through Cerebras (fast, paid) before the existing
     *  Gemini path, without touching regular chat. See api/chat.js. */
    isTabCompletion?: boolean;
    /** How hard the Freebird Cloud Sonnet model should think before answering. Omitted = server default (medium). */
    effort?: 'low' | 'medium' | 'high';
    /** Aborts the in-flight request. Tab completions pass VS Code's cancellation
     *  here so a result the user has typed past stops costing quota and bandwidth. */
    signal?: AbortSignal;
    /** Tab completion only: the chat-style prompt a non-FIM provider should use
     *  when a FIM-capable primary (Ollama) is unavailable. */
    fallbackPrompt?: string;
    /** Tab completion only: the same prompt split into instructions and code. Freebird Cloud sends it as a system
     *  message plus a user message — measured on the live backend, that returns nothing about 16% of the time instead
     *  of 50%. Other providers ignore this and use `messages` / `fallbackPrompt` as before. */
    completionParts?: { system: string; user: string };
    /** Set only by the Agent-mode loop — asks the backend to serve this request
     *  from the licence's monthly Claude Sonnet allowance (see api/chat.js). */
    premium?: boolean;
    /** Set only for a free-tier user's free Agent-mode run — asks the backend to
     *  serve it from the capped per-identity trial budget instead of the daily
     *  chat quota (see api/chat.js, src/license/agentTrial.ts). */
    agentTrial?: boolean;
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
    image?: { mimeType: string; base64: string };
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

    /** True when stream()/complete() know how to turn a Message.image into
     *  this provider's own multimodal content-block shape. Duck-typed check,
     *  same convention as isFIMProvider (src/inline/completionProvider.ts) —
     *  only CloudProvider sets this today; Ollama's own image convention
     *  (`images: string[]`) is a different shape and not wired up yet. */
    readonly supportsImageInput?: boolean;

    /** True when this provider takes role 'system' messages and caches them (Freebird Cloud). */
    readonly supportsSystemMessages?: boolean;

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
