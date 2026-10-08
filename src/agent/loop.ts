import { isDesignConversation } from '../architecture/intent';
import * as vscode from 'vscode';
import { Message, AIProvider, RichMessage, ToolResultEntry } from '../ai/provider';
import { parseToolCalls, executeToolCall, getWorkspaceTree, stripToolBlocks, nativeToToolCall,
         TOOL_SYSTEM_PROMPT, NATIVE_TOOL_GUIDELINES, NATIVE_TOOL_SCHEMAS, ToolCall } from './tools';
import { GitService } from '../git/service';
import { buildFileContext } from '../chat/contextBuilder';
import { readProjectMemory, MEMORY_RELATIVE_PATH } from './memory';
import { readProjectRules, RULES_RELATIVE_PATH } from './rules';
import { trackEvent } from '../telemetry';

const MAX_ITERATIONS = 15;

// A tool failing once or twice in a row and then recovering (wrong path,
// adjusts, succeeds) is normal agent behavior — not something to interrupt.
// Three in a row within one turn is a different pattern: the same class of
// failure repeating without the agent correcting course, and every retry
// resends the whole growing (uncached, for Anthropic) conversation history,
// so a stuck loop compounds in cost as fast as it does in iterations. Built
// after a real incident: telemetry showed tool_error spiking (run_command/
// read_file repeatedly, up to ~19 failures in one ~60s flush window) with a
// ~63:1 input:output token ratio on the Anthropic side for the same window —
// consistent with exactly this pattern running unchecked to MAX_ITERATIONS.
const MAX_CONSECUTIVE_TOOL_FAILURES = 3;

function circuitBreakerMessage(threshold: number): string {
    return (
        `⚠️ Stopped after ${threshold} tool calls failed in a row — continuing would likely just repeat ` +
        `the same failure without making progress. Check the tool cards above for what went wrong ` +
        `(a missing command, a bad path, or a permissions issue are common causes), fix it, then try again.`
    );
}

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
    | { type: 'turn-start'; turnId: string }
    | { type: 'iteration-start' }
    | { type: 'text-chunk'; text: string }
    | { type: 'response-complete'; rawText: string }
    /** Plain-language progress line for the UI ("Waiting for the model…", "Writing deck.pptx…"). */
    | { type: 'status'; text: string }
    | { type: 'tool-start'; id: string; tool: ToolCall }
    | { type: 'tool-result'; id: string; tool: ToolCall; success: boolean; output: string; image?: { mimeType: string; base64: string } };

export interface AgentRunOptions {
    userMessage: string;
    history: Message[];
    provider: AIProvider;
    git: GitService;
    context: vscode.ExtensionContext;
    sessionId: string;
    onEvent: (event: AgentEvent) => void;
    onApprovalNeeded: (id: string, description: string, preview: string) => Promise<boolean>;
    /** Free-tier Agent-mode trial run: tells CloudProvider to bill the capped trial budget. */
    agentTrial?: boolean;
    /** Overrides MAX_ITERATIONS — free trial runs are capped lower to bound cost. */
    maxIterations?: number;
    /** Set by the Stop button: ends the run between steps and aborts the in-flight model request. */
    signal?: AbortSignal;
}

function limitMessage(max: number): string {
    return (
        `⏸ Paused after ${max} steps in a row to keep the run bounded — nothing is lost. ` +
        `Say **continue** and I'll pick up where I left off.`
    );
}

function truncatedToolMessage(): string {
    return (
        `Your last reply was cut off by the output limit in the middle of a tool call, so nothing was executed. ` +
        `Retry with a SMALLER call: split big files into several write_file/edit_file calls of under ~150 lines each, ` +
        `and for a slide deck use create_presentation (one short structured call) instead of writing the file by hand. ` +
        `Do not apologise or restate the plan — just make the next call.`
    );
}

/** Number of ```tool fences opened in a reply (closed or not) — compared with what parsed to spot a cut-off call. */
function openedToolBlocks(text: string): number {
    return (text.match(/```tool\b/g) ?? []).length;
}

function isAbort(err: any): boolean {
    return err?.name === 'AbortError' || err?.code === 'ABORT_ERR';
}

export async function runAgentLoop(opts: AgentRunOptions): Promise<Message[]> {
    const { provider, onEvent } = opts;

    const turnId = `turn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    onEvent({ type: 'turn-start', turnId });

    if (provider.supportsNativeTools && provider.streamWithTools) {
        return runNativeToolLoop(opts, turnId);
    }
    return runTextParsedLoop(opts, turnId);
}

// ── Native tool calling loop (Anthropic/OpenAI/DeepSeek/Qwen) ────────────────

async function runNativeToolLoop(opts: AgentRunOptions, turnId: string): Promise<Message[]> {
    const { userMessage, history, provider, git, context, sessionId, onEvent, onApprovalNeeded } = opts;

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

    const projectRules = readProjectRules();
    if (projectRules) {
        systemContent += `\n\nProject rules (${RULES_RELATIVE_PATH}) — the user's own conventions for this project. Follow these even when they conflict with your own defaults:\n${projectRules}`;
        trackEvent('rules_loaded');
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

    let consecutiveToolFailures = 0;

    const nativeMax = opts.maxIterations ?? MAX_ITERATIONS;
    let nativeEnded = false;
    for (let i = 0; i < nativeMax; i++) {
        if (opts.signal?.aborted) { nativeEnded = true; break; }
        onEvent({ type: 'iteration-start' });
        onEvent({ type: 'status', text: i === 0 ? 'Sending your request to the model…' : 'Reading the result and deciding the next step…' });

        let result;
        try {
            result = await provider.streamWithTools!(
                richMessages,
                NATIVE_TOOL_SCHEMAS,
                chunk => onEvent({ type: 'text-chunk', text: chunk }),
                { signal: opts.signal }
            );
        } catch (err: any) {
            if (opts.signal?.aborted && isAbort(err)) { nativeEnded = true; break; }
            throw err;
        }

        onEvent({ type: 'response-complete', rawText: result.text });
        newHistory.push({ role: 'assistant', content: result.text });

        if (result.toolCalls.length === 0) { nativeEnded = true; break; }

        // Add assistant message with tool calls to rich history
        richMessages.push({
            role: 'assistant',
            content: result.text || undefined,
            toolCalls: result.toolCalls
        });

        const toolResults: ToolResultEntry[] = [];
        let circuitBroken = false;

        for (const tc of result.toolCalls) {
            const internalTool = nativeToToolCall(tc.name, tc.input);
            const id = `${tc.name}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
            onEvent({ type: 'tool-start', id, tool: internalTool });
            const toolResult = await executeToolCall(internalTool, git, onApprovalNeeded, context, sessionId, turnId);
            onEvent({ type: 'tool-result', id, tool: internalTool, success: toolResult.success, output: toolResult.output, image: toolResult.image });

            toolResults.push({
                toolCallId: tc.id,
                output: toolResult.output,
                isError: !toolResult.success,
                image: toolResult.image
            });

            consecutiveToolFailures = toolResult.success ? 0 : consecutiveToolFailures + 1;
            if (consecutiveToolFailures >= MAX_CONSECUTIVE_TOOL_FAILURES) {
                circuitBroken = true;
                break; // stop this batch — remaining queued tool calls in this response go unexecuted
            }
        }

        // Add tool results
        richMessages.push({ role: 'tool_result', toolResults });

        // Also add to plain history for context
        const toolSummary = toolResults.map(tr =>
            tr.isError ? `[ERROR] ${tr.output}` : tr.output
        ).join('\n\n---\n\n');
        newHistory.push({ role: 'user', content: toolSummary });

        if (circuitBroken) {
            trackEvent('agent_circuit_breaker_engaged');
            const message = circuitBreakerMessage(MAX_CONSECUTIVE_TOOL_FAILURES);
            onEvent({ type: 'iteration-start' });
            onEvent({ type: 'text-chunk', text: message });
            onEvent({ type: 'response-complete', rawText: message });
            newHistory.push({ role: 'assistant', content: message });
            nativeEnded = true;
            break;
        }
    }

    if (!nativeEnded) {
        const message = limitMessage(nativeMax);
        onEvent({ type: 'iteration-start' });
        onEvent({ type: 'text-chunk', text: message });
        onEvent({ type: 'response-complete', rawText: message });
        newHistory.push({ role: 'assistant', content: message });
    }

    return newHistory;
}

// ── Text-parsed loop (Ollama fallback) ───────────────────────────────────────

async function runTextParsedLoop(opts: AgentRunOptions, turnId: string): Promise<Message[]> {
    const { userMessage, history, provider, git, context, sessionId, onEvent, onApprovalNeeded } = opts;

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

    const projectRules = readProjectRules();
    if (projectRules) {
        systemContent += `\n\nProject rules (${RULES_RELATIVE_PATH}) — the user's own conventions for this project. Follow these even when they conflict with your own defaults:\n${projectRules}`;
        trackEvent('rules_loaded');
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

    let consecutiveToolFailures = 0;
    // Layout briefs make the Pro model plan silently for minutes; the floor-plan validator does the checking instead.
    const effort = isDesignConversation(userMessage, history) ? 'low' as const : undefined;

    const maxIter = opts.maxIterations ?? MAX_ITERATIONS;
    let ended = false;                // true once the loop stopped for a reason we already told the user about
    let truncatedRetries = 0;
    const say = (message: string) => {
        onEvent({ type: 'iteration-start' });
        onEvent({ type: 'text-chunk', text: message });
        onEvent({ type: 'response-complete', rawText: message });
        newHistory.push({ role: 'assistant', content: message });
    };

    for (let i = 0; i < maxIter; i++) {
        if (opts.signal?.aborted) { say('Stopped.'); ended = true; break; }

        let rawText = '';
        // The first step is where planning pays off; steps that just react to a tool result (read a file,
        // write the next one) don't need Sonnet to think as long, and thinking time is most of the wait.
        const stepEffort = i > 0 ? 'low' as const : effort;

        onEvent({ type: 'iteration-start' });
        onEvent({ type: 'status', text: i === 0 ? 'Sending your request to the model…' : 'Reading the result and deciding the next step…' });

        // premium: lets Freebird Cloud serve this from the Pro Sonnet allowance;
        // other providers ignore it.
        const onChunk = (chunk: string) => { rawText += chunk; onEvent({ type: 'text-chunk', text: chunk }); };
        try {
            try {
                await provider.stream(messages, onChunk, { premium: true, agentTrial: opts.agentTrial, effort: stepEffort, signal: opts.signal });
            } catch (err: any) {
                // The Pro model can spend its whole budget planning and write nothing. Rather than end the
                // run, redo this one step on the fast model — it answers immediately, and the validators
                // give it concrete fixes to apply.
                if (err?.code !== 'EMPTY_RESPONSE' || rawText) throw err;
                await provider.stream(messages, onChunk, { premium: false, agentTrial: opts.agentTrial, effort: stepEffort, signal: opts.signal });
            }
        } catch (err: any) {
            if (opts.signal?.aborted && (isAbort(err) || err?.name === 'TimeoutError')) {
                onEvent({ type: 'response-complete', rawText });
                say('Stopped.');
                ended = true;
                break;
            }
            throw err;
        }

        onEvent({ type: 'response-complete', rawText });
        newHistory.push({ role: 'assistant', content: rawText });

        const toolCalls = parseToolCalls(rawText);
        const cutOff = openedToolBlocks(rawText) - toolCalls.length; // tool blocks that never closed or weren't valid JSON

        // A tool call that was cut off by the output limit used to vanish: the unfinished block is hidden from
        // the chat, nothing parsed, and the run simply ended with an empty-looking reply. Tell the model and
        // let it retry smaller instead.
        if (cutOff > 0 && toolCalls.length === 0 && truncatedRetries < 2) {
            truncatedRetries++;
            trackEvent('agent_truncated_tool_call');
            const brief = rawText.length > 400 ? rawText.slice(0, 400) + '\n… [cut off]' : rawText;
            const retryMsg = truncatedToolMessage();
            messages.push({ role: 'assistant', content: brief }, { role: 'user', content: retryMsg });
            newHistory.push({ role: 'user', content: retryMsg });
            onEvent({ type: 'status', text: 'The reply was cut off mid-step — asking the model to redo it in smaller pieces…' });
            continue;
        }

        if (toolCalls.length === 0) {
            if (!stripToolBlocks(rawText).trim()) {
                say(
                    cutOff > 0
                        ? 'The model kept running out of room before finishing that step. Try asking for it in smaller pieces (for example one section or one slide group at a time).'
                        : 'The model returned an empty reply that time. Send the request again, or say **continue**.'
                );
            }
            ended = true;
            break;
        }

        const toolResultParts: string[] = [];
        let circuitBroken = false;
        let stopped = false;
        // Last image produced in this batch (e.g. verify_diagram's rendered
        // PNG) — attached to the next turn only if this provider can use it
        // (CloudProvider today; Ollama never sets supportsImageInput, so its
        // payload shape is untouched and it keeps getting text-only results).
        let diagramImage: { mimeType: string; base64: string } | undefined;

        for (const tool of toolCalls) {
            if (opts.signal?.aborted) { stopped = true; break; }
            const id = `${tool.action}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
            onEvent({ type: 'tool-start', id, tool });
            const result = await executeToolCall(tool, git, onApprovalNeeded, context, sessionId, turnId);
            onEvent({ type: 'tool-result', id, tool, success: result.success, output: result.output, image: result.image });
            toolResultParts.push(
                `Result of ${tool.action}:\n` +
                (result.success ? result.output : `[ERROR] ${result.output}`)
            );
            if (result.image) diagramImage = result.image;

            consecutiveToolFailures = result.success ? 0 : consecutiveToolFailures + 1;
            if (consecutiveToolFailures >= MAX_CONSECUTIVE_TOOL_FAILURES) {
                circuitBroken = true;
                break; // stop this batch — remaining queued tool calls in this response go unexecuted
            }
        }
        if (cutOff > 0) {
            toolResultParts.push(`Note: another tool call in your reply was cut off by the output limit and was NOT run. Redo it as a smaller call.`);
        }

        const toolResultMsg = toolResultParts.join('\n\n---\n\n');
        // Pictures are large and every later step resends the whole conversation: keep only the newest few.
        if (diagramImage) {
            const withImage = messages.filter(m => m.image);
            for (const old of withImage.slice(0, Math.max(0, withImage.length - 2))) delete old.image;
        }
        messages.push({ role: 'assistant', content: rawText });
        messages.push({
            role: 'user',
            content: toolResultMsg || 'Stopped by the user.',
            ...(diagramImage && provider.supportsImageInput && { image: diagramImage })
        });
        newHistory.push({ role: 'user', content: toolResultMsg || 'Stopped by the user.' });

        if (stopped) {
            say('Stopped.');
            ended = true;
            break;
        }

        if (circuitBroken) {
            trackEvent('agent_circuit_breaker_engaged');
            say(circuitBreakerMessage(MAX_CONSECUTIVE_TOOL_FAILURES));
            ended = true;
            break;
        }
    }

    // The step budget ran out while the model still had work queued. This used to end the turn with no
    // message at all, which read as the agent going quiet.
    if (!ended) {
        trackEvent('agent_step_limit_reached');
        say(limitMessage(maxIter));
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
