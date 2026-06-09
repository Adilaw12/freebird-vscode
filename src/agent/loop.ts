import { Message, AIProvider } from '../ai/provider';
import { parseToolCalls, executeToolCall, getWorkspaceTree, stripToolBlocks, TOOL_SYSTEM_PROMPT, ToolCall } from './tools';
import { GitService } from '../git/service';
import { buildFileContext } from '../chat/contextBuilder';

const MAX_ITERATIONS = 15;

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
    const { userMessage, history, provider, git, onEvent, onApprovalNeeded } = opts;

    const fileContext = buildFileContext();
    const workspaceTree = await getWorkspaceTree();

    let systemContent =
        `You are OpenPilot, a free open-source AI coding assistant for VS Code. ` +
        `Help with writing, debugging, explaining, and improving code. ` +
        `Use markdown with language-tagged code blocks.` +
        TOOL_SYSTEM_PROMPT;

    if (workspaceTree) {
        systemContent += `\n\nWorkspace files:\n${workspaceTree}`;
    }

    const systemMessages: Message[] = [
        { role: 'user', content: systemContent },
        {
            role: 'assistant',
            content: 'Ready. I can read your entire codebase, edit files, run commands, and push to GitHub.'
        }
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

export { stripToolBlocks };
