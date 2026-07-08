import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { getProvider } from '../ai';
import { CloudProvider } from '../ai/cloud';
import { OllamaProvider } from '../ai/ollama';
import { GitService } from '../git/service';
import { Message } from '../ai/provider';
import { runAgentLoop, AgentEvent, stripToolBlocks } from '../agent/loop';
import { buildFileContext, resolveMentions, listWorkspaceFiles } from './contextBuilder';
import { getLicenseStatus, UPGRADE_URL } from '../license/validator';
import { getCloudEditsRemaining, consumeCloudEdit, DAILY_CLOUD_LIMIT } from '../license/usage';
import { readProjectMemory, clearProjectMemory, MEMORY_RELATIVE_PATH } from '../agent/memory';
import { trackEvent, getMachineId } from '../telemetry';

const MAX_HISTORY_PAIRS = 20;

// System prompt for the free cloud/Ollama tier (no agent tools)
const FREE_SYSTEM: Message[] = [
    {
        role: 'user',
        content:
            'You are Freebird, a free AI coding assistant for VS Code. ' +
            'Help with writing, debugging, explaining, and improving code. ' +
            'Use markdown with language-tagged code blocks. Be concise but thorough.\n\n' +
            'For multi-file editing, codebase search, and terminal commands, the user can ' +
            'upgrade to Pro for unlimited cloud-powered agent mode.'
    },
    {
        role: 'assistant',
        content: 'Ready — ask me anything about your code.'
    }
];

// ── Simple response cache ────────────────────────────────────────────────────
const _responseCache = new Map<string, { response: string; ts: number }>();
const CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_CACHE_ENTRIES = 20;

function cacheKey(text: string, history: Message[]): string {
    const h = crypto.createHash('md5').update(text + history.length).digest('hex');
    return h;
}

function getCachedResponse(key: string): string | null {
    const entry = _responseCache.get(key);
    if (!entry) return null;
    if (Date.now() - entry.ts > CACHE_TTL_MS) {
        _responseCache.delete(key);
        return null;
    }
    return entry.response;
}

function setCachedResponse(key: string, response: string): void {
    if (_responseCache.size >= MAX_CACHE_ENTRIES) {
        const oldest = _responseCache.keys().next().value;
        if (oldest !== undefined) _responseCache.delete(oldest);
    }
    _responseCache.set(key, { response, ts: Date.now() });
}

// ── Sidebar view provider ────────────────────────────────────────────────────

export class ChatViewProvider implements vscode.WebviewViewProvider {
    static readonly viewType = 'freebird.chatView';
    static current: ChatViewProvider | undefined;

    private view?: vscode.WebviewView;
    private readonly context: vscode.ExtensionContext;
    private readonly git: GitService;
    private history: Message[] = [];
    private readonly pendingApprovals = new Map<string, (approved: boolean) => void>();
    private rawBuffer = '';
    private sessionMessageCount = 0;
    private toolCallsThisRound = 0;

    constructor(context: vscode.ExtensionContext, git: GitService) {
        this.context = context;
        this.git = git;
        ChatViewProvider.current = this;
    }

    resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken
    ): void {
        this.view = webviewView;
        webviewView.webview.options = { enableScripts: true };
        webviewView.webview.html = fs.readFileSync(
            path.join(this.context.extensionPath, 'media', 'chat.html'), 'utf8'
        );

        this.sendWorkspaceFiles();

        webviewView.webview.onDidReceiveMessage(async (msg: any) => {
            switch (msg.type) {
                case 'send':
                    trackEvent('message_sent');
                    await this.handleMessage(msg.text);
                    break;
                case 'clear':
                    this.history = [];
                    this.post({ type: 'cleared' });
                    break;
                case 'approval-response': {
                    const resolve = this.pendingApprovals.get(msg.id);
                    if (resolve) {
                        resolve(msg.approved as boolean);
                        this.pendingApprovals.delete(msg.id);
                    }
                    break;
                }
                case 'quota-wall-shown':
                    // Funnel stage 1: user hit the quota wall and saw the prompt
                    trackEvent('quota_wall_shown');
                    if (msg.variant === 'power') trackEvent('quota_wall_shown_power');
                    break;
                case 'upgrade':
                    // Funnel stage 2: user clicked through to Stripe checkout
                    vscode.env.openExternal(vscode.Uri.parse(UPGRADE_URL));
                    trackEvent('upgrade_clicked');
                    break;
                case 'install-ollama':
                    vscode.env.openExternal(vscode.Uri.parse('https://ollama.com/download'));
                    trackEvent('ollama_install_clicked');
                    break;
                case 'activate-license':
                    vscode.commands.executeCommand('freebird.activateLicense');
                    break;
                case 'sign-in-github':
                    vscode.commands.executeCommand('freebird.signInWithGitHub');
                    break;
                case 'start-trial':
                    vscode.commands.executeCommand('freebird.startTrial');
                    break;
            }
        });

        webviewView.onDidDispose(() => {
            for (const resolve of this.pendingApprovals.values()) resolve(false);
            this.pendingApprovals.clear();
        });
    }

    async showLicenseStatus() {
        const status = await getLicenseStatus(this.context);
        this.post({ type: 'license-status', isPro: status.isPro, plan: status.plan, email: status.email });
    }

    triggerCommand(command: string) {
        if (command === 'commit') this.handleCommit();
    }

    focus() {
        if (this.view) {
            this.view.show(true);
        }
    }

    private async sendWorkspaceFiles() {
        try {
            const files = await listWorkspaceFiles(300);
            this.post({ type: 'workspace-files', files });
        } catch { /* no workspace open */ }
    }

    private async handleMessage(text: string) {
        const trimmed = text.trim();

        if (trimmed === '/commit') { await this.handleCommit(); return; }
        if (trimmed === '/push')   { await this.handlePush();   return; }
        if (trimmed === '/status') { await this.handleStatus(); return; }
        if (trimmed === '/clear')  {
            this.history = [];
            this.post({ type: 'cleared' });
            return;
        }
        if (trimmed === '/memory') {
            this.post({ type: 'user', text: '/memory' });
            this.post({ type: 'assistant-start' });
            const memory = readProjectMemory();
            this.post({
                type: 'set-text',
                text: memory
                    ? `**Project memory** (\`${MEMORY_RELATIVE_PATH}\`):\n\n${memory}`
                    : `No project memory yet. Ask Freebird (Pro) to remember something, and it'll save notes to \`${MEMORY_RELATIVE_PATH}\`.`
            });
            this.post({ type: 'assistant-end' });
            return;
        }
        if (trimmed === '/forget') {
            this.post({ type: 'user', text: '/forget' });
            const choice = await vscode.window.showWarningMessage(
                `Delete ${MEMORY_RELATIVE_PATH}? This clears everything Freebird remembers about this project.`,
                'Delete', 'Cancel'
            );
            this.post({ type: 'assistant-start' });
            this.post({
                type: 'set-text',
                text: choice === 'Delete'
                    ? (clearProjectMemory() ? 'Project memory cleared.' : 'No project memory to clear.')
                    : 'Cancelled.'
            });
            this.post({ type: 'assistant-end' });
            return;
        }
        if (trimmed === '/help') {
            this.post({ type: 'user', text: '/help' });
            this.post({ type: 'assistant-start' });
            const license = await getLicenseStatus(this.context);
            const helpLines = [
                '**Available commands:**',
                '',
                '`/commit` — AI-generate a git commit message',
                '`/push` — push current branch to remote',
                '`/status` — show git status',
                '`/memory` — show what Freebird remembers about this project',
                '`/forget` — clear project memory',
                '`/clear` — clear conversation history',
                '`/help` — show this message',
                '',
                '**@ mentions:**',
                'Type `@filename` to inject a file into your message.',
                'Example: `explain the logic in @src/utils/parser.ts`',
                '',
                '**Keyboard shortcuts:**',
                '`Ctrl+Alt+O` — open chat',
                '`Ctrl+Alt+K` — inline edit selected code',
                '',
            ];
            if (!license.isPro) {
                helpLines.push(
                    '**Free plan:**',
                    `${getCloudEditsRemaining(this.context)}/${DAILY_CLOUD_LIMIT} cloud edits left today (Gemini Flash) — resets daily.`,
                    `After cloud edits: falls back to local Ollama if available.`,
                    `[Upgrade to Pro](${UPGRADE_URL}) for unlimited cloud edits + BYOK.`,
                    ''
                );
            }
            helpLines.push(
                '**Need help?**',
                'Billing or technical issues: [support@ten-labs.com.au](mailto:support@ten-labs.com.au)',
            );
            this.post({ type: 'set-text', text: helpLines.join('\n') });
            this.post({ type: 'assistant-end' });
            return;
        }

        const { cleanText, mentionContext } = await resolveMentions(trimmed);
        this.post({ type: 'user', text: trimmed });

        const license = await getLicenseStatus(this.context);
        this.sessionMessageCount++;

        if (license.isPro) {
            trackEvent('pro_message');
            await this.runProChat(cleanText, mentionContext);

        } else if (getCloudEditsRemaining(this.context) > 0) {
            // Free tier: use cloud edits (Gemini Flash via Vercel backend)
            trackEvent('cloud_edit_used');
            this.toolCallsThisRound = 0;
            await this.runFreeChat(cleanText, mentionContext, 'cloud');
            const remaining = await consumeCloudEdit(this.context);
            this.post({ type: 'cloud-edit-used', remaining });

            if (remaining === 2) {
                this.post({ type: 'upgrade-nudge', variant: 'running-low' });
            }
            if (this.toolCallsThisRound >= 3) {
                this.post({ type: 'upgrade-nudge', variant: 'power-user' });
            }

        } else {
            // Cloud edits exhausted — try Ollama, then fall back to cloud with upgrade prompt
            trackEvent('ollama_fallback');
            this.post({ type: 'ollama-fallback' });
            await this.runFreeChat(cleanText, mentionContext, 'ollama-then-cloud');

            if (this.sessionMessageCount % 10 === 0) {
                this.post({ type: 'upgrade-nudge', variant: 'periodic' });
            }
        }
    }

    // ── Pro: full agentic loop ────────────────────────────────────────────────

    private async runProChat(text: string, mentionContext: string) {
        const fileCtx = buildFileContext();
        const contextPrefix = [mentionContext, fileCtx].filter(Boolean).join('\n');
        const fullText = contextPrefix ? `${contextPrefix}\n\n${text}` : text;

        try {
            const newHistory = await runAgentLoop({
                userMessage: fullText,
                history: this.trimHistory(this.history),
                provider: getProvider(this.context, getMachineId()),
                git: this.git,
                onEvent: (event: AgentEvent) => this.handleAgentEvent(event),
                onApprovalNeeded: (id, description, preview) =>
                    new Promise<boolean>(resolve => {
                        this.pendingApprovals.set(id, resolve);
                        this.post({ type: 'approval-request', id, description, preview });
                    })
            });
            this.history = this.trimHistory(newHistory);
        } catch (err: any) {
            trackEvent('api_error');
            this.post({ type: 'assistant-start' });
            this.post({
                type: 'set-text',
                text: `**Error:** ${err.message}\n\nRun \`Freebird: Configure AI Backend\` to check your settings.`
            });
        }
        this.post({ type: 'assistant-end' });
    }

    // ── Free tier: cloud (Gemini Flash) with Ollama fallback ─────────────────
    //
    // mode = 'cloud'            → use CloudProvider directly (has quota)
    // mode = 'ollama-then-cloud' → try Ollama first; if unreachable, use CloudProvider
    //                              (quota exhausted path — cloud here has no daily limit
    //                               since we only reach this after the 5 paid edits are gone,
    //                               but Gemini Flash is cheap enough to absorb the overflow)

    private async runFreeChat(
        text: string,
        mentionContext: string,
        mode: 'cloud' | 'ollama-then-cloud'
    ) {
        const fileContext  = buildFileContext();
        const contextParts = [mentionContext, fileContext].filter(Boolean).join('\n');
        const userContent  = contextParts ? `${contextParts}\n\n${text}` : text;

        // Cache check
        const key = cacheKey(userContent, this.history);
        const cached = getCachedResponse(key);
        if (cached) {
            this.post({ type: 'assistant-start' });
            this.post({ type: 'set-text', text: cached });
            this.history = this.trimHistory([
                ...this.history,
                { role: 'user', content: text },
                { role: 'assistant', content: cached }
            ]);
            this.post({ type: 'assistant-end' });
            return;
        }

        const messages: Message[] = [
            ...FREE_SYSTEM,
            ...this.trimHistory(this.history),
            { role: 'user', content: userContent }
        ];

        this.post({ type: 'assistant-start' });
        let response = '';

        try {
            if (mode === 'ollama-then-cloud') {
                // Try Ollama first
                const ollamaAvailable = await this.tryOllama(messages, chunk => {
                    response += chunk;
                    this.post({ type: 'set-text', text: response });
                });

                if (!ollamaAvailable) {
                    // Ollama not available — fall back to Gemini via /api/fallback
                    // (no quota, rate-limited by IP instead)
                    trackEvent('ollama_not_reachable');
                    const cloud = new CloudProvider(this.context, getMachineId(), 'fallback');
                    await cloud.stream(messages, chunk => {
                        response += chunk;
                        this.post({ type: 'set-text', text: response });
                    });
                    // Show a one-time gentle upgrade prompt since they're in overflow
                    this.post({ type: 'upgrade-nudge', variant: 'quota-overflow' });
                }
            } else {
                // mode = 'cloud' — use CloudProvider with normal quota
                const cloud = new CloudProvider(this.context, getMachineId());
                await cloud.stream(messages, chunk => {
                    response += chunk;
                    this.post({ type: 'set-text', text: response });
                });
            }

            if (response) setCachedResponse(key, response);

        } catch (err: any) {
            trackEvent('api_error');
            if (err?.code === 'AUTH_REQUIRED') {
                trackEvent('auth_required_shown');
                this.post({ type: 'auth-required' });
                return;
            } else if (err?.code === 'QUOTA_EXCEEDED') {
                this.post({ type: 'quota-exceeded' });
                trackEvent('upgrade_prompt_shown');
                return;
            } else if (err?.code === 'IP_RATE_LIMITED') {
                response =
                    `**Too many requests** — you've hit the fallback rate limit (20/hr).\n\n` +
                    `[Upgrade to Pro](${UPGRADE_URL}) for unlimited access, or install ` +
                    `[Ollama](https://ollama.com) for unlimited free local AI.`;
            } else {
                response =
                    `**Error:** ${err.message}\n\n` +
                    `Try running \`Freebird: Configure AI Backend\` to check your settings, ` +
                    `or [contact support](mailto:support@ten-labs.com.au).`;
            }
            this.post({ type: 'set-text', text: response });
        }

        this.history = this.trimHistory([
            ...this.history,
            { role: 'user', content: text },
            { role: 'assistant', content: response }
        ]);

        this.post({ type: 'assistant-end' });
    }

    // Returns true if Ollama responded, false if unreachable
    private async tryOllama(
        messages: Message[],
        onChunk: (text: string) => void
    ): Promise<boolean> {
        try {
            const ollama = new OllamaProvider();
            await ollama.stream(messages, onChunk);
            return true;
        } catch {
            return false;
        }
    }

    private handleAgentEvent(event: AgentEvent) {
        switch (event.type) {
            case 'iteration-start':
                this.rawBuffer = '';
                this.post({ type: 'assistant-start' });
                break;
            case 'text-chunk':
                this.rawBuffer += event.text;
                this.post({ type: 'set-text', text: stripToolBlocks(this.rawBuffer) });
                break;
            case 'response-complete':
                this.rawBuffer = '';
                break;
            case 'tool-start':
                this.toolCallsThisRound++;
                trackEvent(`tool_used_${event.tool.action}`);
                this.post({ type: 'tool-status', id: event.id, state: 'running', label: toolLabel(event.tool) });
                break;
            case 'tool-result':
                if (!event.success) trackEvent('tool_error');
                this.post({
                    type: 'tool-update',
                    id: event.id,
                    state: event.success ? 'done' : 'error',
                    output: event.output.length > 200 ? event.output.slice(0, 200) + '…' : event.output
                });
                break;
        }
    }

    // ── Trim history ─────────────────────────────────────────────────────────

    private trimHistory(messages: Message[]): Message[] {
        const maxMessages = MAX_HISTORY_PAIRS * 2;
        if (messages.length <= maxMessages) return messages;
        return messages.slice(messages.length - maxMessages);
    }

    // ── Git commands ─────────────────────────────────────────────────────────

    private async handleCommit() {
        const diff = await this.git.getDiff();
        if (!diff) {
            this.post({ type: 'user', text: '/commit' });
            this.post({ type: 'assistant-start' });
            this.post({ type: 'set-text', text: 'No changes detected in the workspace.' });
            this.post({ type: 'assistant-end' });
            return;
        }

        this.post({ type: 'user', text: '/commit' });
        this.post({ type: 'assistant-start' });
        this.post({ type: 'set-text', text: 'Analyzing your changes…' });

        let commitMsg = '';
        try {
            // Use getProvider with context + sessionId so routing logic applies
            commitMsg = await getProvider(this.context, getMachineId()).complete([{
                role: 'user',
                content: `Write a concise conventional git commit message (imperative mood, max 72 chars subject line) for these changes. Reply with ONLY the commit message:\n\n${diff}`
            }]);
        } catch (err: any) {
            this.post({ type: 'set-text', text: `**Error:** ${err.message}` });
            this.post({ type: 'assistant-end' });
            return;
        }

        const trimmed = commitMsg.trim();
        this.post({ type: 'set-text', text: `Proposed commit:\n\n\`${trimmed}\`` });
        this.post({ type: 'assistant-end' });

        const choice = await vscode.window.showInformationMessage(
            `Proposed commit: "${trimmed}"`, 'Commit', 'Edit & Commit', 'Cancel'
        );
        if (choice === 'Commit') {
            try {
                await this.git.commit(trimmed);
                this.post({ type: 'assistant-start' });
                this.post({ type: 'set-text', text: `**Committed:** ${trimmed}` });
                this.post({ type: 'assistant-end' });
            } catch (err: any) { vscode.window.showErrorMessage(`Commit failed: ${err.message}`); }
        } else if (choice === 'Edit & Commit') {
            const edited = await vscode.window.showInputBox({ value: trimmed, prompt: 'Edit commit message' });
            if (edited) {
                try {
                    await this.git.commit(edited);
                    this.post({ type: 'assistant-start' });
                    this.post({ type: 'set-text', text: `**Committed:** ${edited}` });
                    this.post({ type: 'assistant-end' });
                } catch (err: any) { vscode.window.showErrorMessage(`Commit failed: ${err.message}`); }
            }
        }
    }

    private async handlePush() {
        this.post({ type: 'user', text: '/push' });
        this.post({ type: 'assistant-start' });
        try {
            await this.git.push();
            this.post({ type: 'set-text', text: '**Pushed** to remote successfully.' });
        } catch (err: any) {
            this.post({ type: 'set-text', text: `**Push failed:** ${err.message}` });
        }
        this.post({ type: 'assistant-end' });
    }

    private async handleStatus() {
        this.post({ type: 'user', text: '/status' });
        this.post({ type: 'assistant-start' });
        try {
            this.post({ type: 'set-text', text: `**Git status:**\n\n${await this.git.getStatus()}` });
        } catch (err: any) {
            this.post({ type: 'set-text', text: `**Error:** ${err.message}` });
        }
        this.post({ type: 'assistant-end' });
    }

    private post(msg: object) {
        this.view?.webview.postMessage(msg);
    }
}

function toolLabel(tool: { action: string; [key: string]: unknown }): string {
    switch (tool.action) {
        case 'read_file':      return `Reading ${tool.path}`;
        case 'list_files':     return `Listing files (${tool.pattern || '**/*'})`;
        case 'search_code':    return `Searching for "${tool.query}"`;
        case 'write_file':     return `Writing ${tool.path}`;
        case 'edit_file':      return `Editing ${tool.path}`;
        case 'run_command':    return `Running: ${tool.command}`;
        case 'download_file':  return `Downloading ${tool.url}`;
        case 'create_diagram': return `Creating diagram: ${tool.title}`;
        case 'copy_file':      return `Copying ${tool.source} → ${tool.destination}`;
        case 'git_status':     return 'Checking git status';
        case 'git_push':       return 'Pushing to remote';
        default:               return tool.action;
    }
}
