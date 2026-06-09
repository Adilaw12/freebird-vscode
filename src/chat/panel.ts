import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { getProvider } from '../ai';
import { GitService } from '../git/service';
import { Message } from '../ai/provider';
import { runAgentLoop, AgentEvent, stripToolBlocks } from '../agent/loop';
import { buildFileContext } from './contextBuilder';
import { getLicenseStatus, UPGRADE_URL } from '../license/validator';

const FREE_SYSTEM: Message[] = [
    {
        role: 'user',
        content:
            'You are OpenPilot, a free open-source AI coding assistant for VS Code. ' +
            'Help with writing, debugging, explaining, and improving code. ' +
            'Use markdown with language-tagged code blocks. Be concise but thorough.\n\n' +
            'IMPORTANT: You are running in free mode and cannot access files or run commands. ' +
            'When the user asks you to read files, edit across multiple files, search the codebase, ' +
            'or run terminal commands, explain that OpenPilot Pro enables these capabilities and ' +
            'encourage them to upgrade. In the meantime, ask them to paste the relevant code ' +
            'directly into the chat so you can still help.'
    },
    {
        role: 'assistant',
        content: 'Ready. I am OpenPilot — ask me anything about your code.'
    }
];

export class ChatPanel {
    static current: ChatPanel | undefined;
    private readonly panel: vscode.WebviewPanel;
    private readonly context: vscode.ExtensionContext;
    private history: Message[] = [];
    private readonly disposables: vscode.Disposable[] = [];
    private readonly pendingApprovals = new Map<string, (approved: boolean) => void>();
    private rawBuffer = '';

    static open(context: vscode.ExtensionContext, git: GitService, initialCommand?: string) {
        if (ChatPanel.current) {
            ChatPanel.current.panel.reveal(vscode.ViewColumn.Beside);
            if (initialCommand) ChatPanel.current.triggerCommand(initialCommand, git);
            return;
        }
        ChatPanel.current = new ChatPanel(context, git, initialCommand);
    }

    private constructor(context: vscode.ExtensionContext, git: GitService, initialCommand?: string) {
        this.context = context;
        this.panel = vscode.window.createWebviewPanel(
            'openpilot.chat',
            'OpenPilot',
            vscode.ViewColumn.Beside,
            { enableScripts: true, retainContextWhenHidden: true }
        );
        this.panel.iconPath = new vscode.ThemeIcon('rocket');
        this.panel.webview.html = fs.readFileSync(
            path.join(context.extensionPath, 'media', 'chat.html'), 'utf8'
        );

        this.panel.webview.onDidReceiveMessage(async (msg: any) => {
            switch (msg.type) {
                case 'send':
                    await this.handleMessage(msg.text, git);
                    break;
                case 'approval-response': {
                    const resolve = this.pendingApprovals.get(msg.id);
                    if (resolve) {
                        resolve(msg.approved as boolean);
                        this.pendingApprovals.delete(msg.id);
                    }
                    break;
                }
                case 'upgrade':
                    vscode.env.openExternal(vscode.Uri.parse(UPGRADE_URL));
                    break;
                case 'activate-license':
                    vscode.commands.executeCommand('openpilot.activateLicense');
                    break;
            }
        }, null, this.disposables);

        this.panel.onDidDispose(() => {
            ChatPanel.current = undefined;
            for (const resolve of this.pendingApprovals.values()) resolve(false);
            this.pendingApprovals.clear();
            this.disposables.forEach(d => d.dispose());
        }, null, this.disposables);

        if (initialCommand) this.triggerCommand(initialCommand, git);
    }

    async showLicenseStatus() {
        const status = await getLicenseStatus(this.context);
        this.post({ type: 'license-status', isPro: status.isPro, email: status.email });
    }

    triggerCommand(command: string, git: GitService) {
        if (command === 'commit') this.handleCommit(git);
    }

    private async handleMessage(text: string, git: GitService) {
        const trimmed = text.trim();

        if (trimmed === '/commit') { await this.handleCommit(git); return; }
        if (trimmed === '/push')   { await this.handlePush(git);   return; }
        if (trimmed === '/status') { await this.handleStatus(git); return; }

        this.post({ type: 'user', text });

        const license = await getLicenseStatus(this.context);

        if (license.isPro) {
            await this.runProChat(text, git);
        } else {
            await this.runFreeChat(text);
        }
    }

    // ── Pro: full agentic loop ────────────────────────────────────────────────

    private async runProChat(text: string, git: GitService) {
        try {
            const newHistory = await runAgentLoop({
                userMessage: text,
                history: this.history,
                provider: getProvider(),
                git,
                onEvent: (event: AgentEvent) => this.handleAgentEvent(event),
                onApprovalNeeded: (id, description, preview) =>
                    new Promise<boolean>(resolve => {
                        this.pendingApprovals.set(id, resolve);
                        this.post({ type: 'approval-request', id, description, preview });
                    })
            });
            this.history = newHistory;
        } catch (err: any) {
            this.post({ type: 'assistant-start' });
            this.post({
                type: 'set-text',
                text: `**Error:** ${err.message}\n\nRun \`OpenPilot: Configure AI Backend\` to check your settings.`
            });
        }
        this.post({ type: 'assistant-end' });
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
                this.post({ type: 'tool-status', id: event.id, state: 'running', label: toolLabel(event.tool) });
                break;
            case 'tool-result':
                this.post({
                    type: 'tool-update',
                    id: event.id,
                    state: event.success ? 'done' : 'error',
                    output: event.output.length > 200 ? event.output.slice(0, 200) + '…' : event.output
                });
                break;
        }
    }

    // ── Free: simple chat, no tools ───────────────────────────────────────────

    private async runFreeChat(text: string) {
        const fileContext = buildFileContext();
        const userContent = fileContext ? `${fileContext}\n\n${text}` : text;

        const messages: Message[] = [
            ...FREE_SYSTEM,
            ...this.history,
            { role: 'user', content: userContent }
        ];

        this.post({ type: 'assistant-start' });
        let response = '';

        try {
            await getProvider().stream(messages, chunk => {
                response += chunk;
                this.post({ type: 'set-text', text: response });
            });
        } catch (err: any) {
            response = `**Error:** ${err.message}\n\nRun \`OpenPilot: Configure AI Backend\` to check your settings.`;
            this.post({ type: 'set-text', text: response });
        }

        this.history = [
            ...this.history,
            { role: 'user', content: text },
            { role: 'assistant', content: response }
        ];

        this.post({ type: 'assistant-end' });
        this.post({ type: 'show-upgrade-hint' });
    }

    // ── Shared git commands ───────────────────────────────────────────────────

    private async handleCommit(git: GitService) {
        const diff = await git.getDiff();
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
            commitMsg = await getProvider().complete([{
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
                await git.commit(trimmed);
                this.post({ type: 'assistant-start' });
                this.post({ type: 'set-text', text: `**Committed:** ${trimmed}` });
                this.post({ type: 'assistant-end' });
            } catch (err: any) { vscode.window.showErrorMessage(`Commit failed: ${err.message}`); }
        } else if (choice === 'Edit & Commit') {
            const edited = await vscode.window.showInputBox({ value: trimmed, prompt: 'Edit commit message' });
            if (edited) {
                try {
                    await git.commit(edited);
                    this.post({ type: 'assistant-start' });
                    this.post({ type: 'set-text', text: `**Committed:** ${edited}` });
                    this.post({ type: 'assistant-end' });
                } catch (err: any) { vscode.window.showErrorMessage(`Commit failed: ${err.message}`); }
            }
        }
    }

    private async handlePush(git: GitService) {
        this.post({ type: 'user', text: '/push' });
        this.post({ type: 'assistant-start' });
        try {
            await git.push();
            this.post({ type: 'set-text', text: '**Pushed** to remote successfully.' });
        } catch (err: any) {
            this.post({ type: 'set-text', text: `**Push failed:** ${err.message}` });
        }
        this.post({ type: 'assistant-end' });
    }

    private async handleStatus(git: GitService) {
        this.post({ type: 'user', text: '/status' });
        this.post({ type: 'assistant-start' });
        try {
            this.post({ type: 'set-text', text: `**Git status:**\n\n${await git.getStatus()}` });
        } catch (err: any) {
            this.post({ type: 'set-text', text: `**Error:** ${err.message}` });
        }
        this.post({ type: 'assistant-end' });
    }

    private post(msg: object) {
        this.panel.webview.postMessage(msg);
    }
}

function toolLabel(tool: { action: string; [key: string]: unknown }): string {
    switch (tool.action) {
        case 'read_file':   return `Reading ${tool.path}`;
        case 'list_files':  return `Listing files (${tool.pattern || '**/*'})`;
        case 'search_code': return `Searching for "${tool.query}"`;
        case 'write_file':  return `Writing ${tool.path}`;
        case 'edit_file':   return `Editing ${tool.path}`;
        case 'run_command': return `Running: ${tool.command}`;
        case 'git_status':  return 'Checking git status';
        case 'git_push':    return 'Pushing to remote';
        default:            return tool.action;
    }
}
