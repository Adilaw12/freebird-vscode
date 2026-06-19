import { Message, AIProvider, RichMessage, ToolResultEntry } from '../ai/provider';
import { parseToolCalls, executeToolCall, getWorkspaceTree, stripToolBlocks, nativeToToolCall,
         TOOL_SYSTEM_PROMPT, NATIVE_TOOL_GUIDELINES, NATIVE_TOOL_SCHEMAS, ToolCall } from './tools';
import { GitService } from '../git/service';
import { buildFileContext } from '../chat/contextBuilder';
import { readProjectMemory, MEMORY_RELATIVE_PATH } from './memory';

const MAX_ITERATIONS = 15;

// Rough token estimates per model family
const MODEL_CONTEXT_LIMITS: Record<string, number> = {
    'claude': 200_000,
    'gpt-4o': 128_000,
    'gpt-4o-mini': 128_000,
    'deepseek': 128_000,
    'qwen': 32_000,
    'default': 8_000
};

export type AgentEvent =
    | { type: 'iteration-start' }
    | { type: 'text-chunk'; text: string }
    | { type: 'response-complete'; rawText: string }
    | { type: 'tool-start'; id: string; tool: ToolCall }
    | { type: 'tool-result'; id: string; tool: ToolCall; success: boolean; output: string };

export interface AgentRunOptions {
    userMessage: string;
    history: Message[];
    provider: AIProvider;
    git: GitService;
    onEvent: (event: AgentEvent) => void;
    onApprovalNeeded: (id: string, description: string, preview: string) => Promise<boolean>;
}

export async function runAgentLoop(opts: AgentRunOptions): Promise<Message[]> {
    const { provider, git, onEvent, onApprovalNeeded } = opts;

    if (provider.supportsNativeTools && provider.streamWithTools) {
        return runNativeToolLoop(opts);
    }
    return runTextParsedLoop(opts);
}

// ── Native tool calling loop (Anthropic/OpenAI/DeepSeek/Qwen) ────────────────

async function runNativeToolLoop(opts: AgentRunOptions): Promise<Message[]> {
    const { userMessage, history, provider, git, onEvent, onApprovalNeeded } = opts;

    const fileContext = buildFileContext();
    const workspaceTree = await getWorkspaceTree();

    let systemContent =
        `You are Freebird, a free open-source AI coding assistant for VS Code. ` +
        `Help with writing, debugging, explaining, and improving code. ` +
        `Use markdown with language-tagged code blocks.\n\n` +
        NATIVE_TOOL_GUIDELINES;

    if (workspaceTree) {
        systemContent += `\n\nWorkspace files:\n${truncateToTokenBudget(workspaceTree, 4000)}`;
    }

    const projectMemory = readProjectMemory();
    if (projectMemory) {
        systemContent += `\n\nProject memory (${MEMORY_RELATIVE_PATH}):\n${projectMemory}`;
    }

    const userContent = fileContext ? `${fileContext}\n\n${userMessage}` : userMessage;

    const richMessages: RichMessage[] = [
        { role: 'user', content: systemContent },
        { role: 'assistant', content: 'Ready. I can read your entire codebase, edit files, run commands, and push to GitHub.' },
        ...history.map(m => ({ role: m.role, content: m.content }) as RichMessage),
        { role: 'user', content: userContent }
    ];

    const newHistory: Message[] = [
        ...history,
        { role: 'user', content: userMessage }
    ];

    for (let i = 0; i < MAX_ITERATIONS; i++) {
        onEvent({ type: 'iteration-start' });

        const result = await provider.streamWithTools!(
            richMessages,
            NATIVE_TOOL_SCHEMAS,
            chunk => onEvent({ type: 'text-chunk', text: chunk })
        );

        onEvent({ type: 'response-complete', rawText: result.text });
        newHistory.push({ role: 'assistant', content: result.text });

        if (result.toolCalls.length === 0) break;

        // Add assistant message with tool calls to rich history
        richMessages.push({
            role: 'assistant',
            content: result.text || undefined,
            toolCalls: result.toolCalls
        });

        const toolResults: ToolResultEntry[] = [];

        for (const tc of result.toolCalls) {
            const internalTool = nativeToToolCall(tc.name, tc.input);
            const id = `${tc.name}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
            onEvent({ type: 'tool-start', id, tool: internalTool });
            const toolResult = await executeToolCall(internalTool, git, onApprovalNeeded);
            onEvent({ type: 'tool-result', id, tool: internalTool, success: toolResult.success, output: toolResult.output });

            toolResults.push({
                toolCallId: tc.id,
                output: toolResult.output,
                isError: !toolResult.success
            });
        }

        // Add tool results
        richMessages.push({ role: 'tool_result', toolResults });

        // Also add to plain history for context
        const toolSummary = toolResults.map(tr =>
            tr.isError ? `[ERROR] ${tr.output}` : tr.output
        ).join('\n\n---\n\n');
        newHistory.push({ role: 'user', content: toolSummary });
    }

    return newHistory;
}

// ── Text-parsed loop (Ollama fallback) ───────────────────────────────────────

async function runTextParsedLoop(opts: AgentRunOptions): Promise<Message[]> {
    const { userMessage, history, provider, git, onEvent, onApprovalNeeded } = opts;

    const fileContext = buildFileContext();
    const workspaceTree = await getWorkspaceTree();

    let systemContent =
        `You are Freebird, a free open-source AI coding assistant for VS Code. ` +
        `Help with writing, debugging, explaining, and improving code. ` +
        `Use markdown with language-tagged code blocks.` +
        TOOL_SYSTEM_PROMPT;

    if (workspaceTree) {
        systemContent += `\n\nWorkspace files:\n${truncateToTokenBudget(workspaceTree, 4000)}`;
    }

    const projectMemory = readProjectMemory();
    if (projectMemory) {
        systemContent += `\n\nProject memory (${MEMORY_RELATIVE_PATH}):\n${projectMemory}`;
    }

    const systemMessages: Message[] = [
        { role: 'user', content: systemContent },
        { role: 'assistant', content: 'Ready. I can read your entire codebase, edit files, run commands, and push to GitHub.' }
    ];

    const userContent = fileContext ? `${fileContext}\n\n${userMessage}` : userMessage;

    const messages: Message[] = [
        ...systemMessages,
        ...history,
        { role: 'user', content: userContent }
    ];

    const newHistory: Message[] = [
        ...history,
        { role: 'user', content: userMessage }
    ];

    for (let i = 0; i < MAX_ITERATIONS; i++) {
        let rawText = '';

        onEvent({ type: 'iteration-start' });

        await provider.stream(messages, chunk => {
            rawText += chunk;
            onEvent({ type: 'text-chunk', text: chunk });
        });

        onEvent({ type: 'response-complete', rawText });
        newHistory.push({ role: 'assistant', content: rawText });

        const toolCalls = parseToolCalls(rawText);
        if (toolCalls.length === 0) break;

        const toolResultParts: string[] = [];

        for (const tool of toolCalls) {
            const id = `${tool.action}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
            onEvent({ type: 'tool-start', id, tool });
            const result = await executeToolCall(tool, git, onApprovalNeeded);
            onEvent({ type: 'tool-result', id, tool, success: result.success, output: result.output });
            toolResultParts.push(
                `Result of ${tool.action}:\n` +
                (result.success ? result.output : `[ERROR] ${result.output}`)
            );
        }

        const toolResultMsg = toolResultParts.join('\n\n---\n\n');
        messages.push({ role: 'assistant', content: rawText });
        messages.push({ role: 'user', content: toolResultMsg });
        newHistory.push({ role: 'user', content: toolResultMsg });
    }

    return newHistory;
}

// ── Token-aware context management ───────────────────────────────────────────

function estimateTokens(text: string): number {
    return Math.ceil(text.length / 3.5);
}

function truncateToTokenBudget(text: string, maxTokens: number): string {
    const estimated = estimateTokens(text);
    if (estimated <= maxTokens) return text;
    const charBudget = maxTokens * 3;
    const lines = text.split('\n');
    let result = '';
    for (const line of lines) {
        if (result.length + line.length + 1 > charBudget) {
            result += `\n… (${lines.length} total items, showing first ${result.split('\n').length})`;
            break;
        }
        result += (result ? '\n' : '') + line;
    }
    return result;
}

export { stripToolBlocks };
