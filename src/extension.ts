import * as vscode from 'vscode';
import { ChatViewProvider } from './chat/panel';
import { GitService } from './git/service';
import { registerInlineEdit } from './inline/editor';
import { registerTabCompletion } from './inline/completionProvider';
import { getLicenseStatus, warmLicenseCache, activateLicense, clearLicenseCache, UPGRADE_URL } from './license/validator';
import { getCloudEditsRemaining } from './license/usage';
import { initWorkspaceTreeCache } from './agent/tools';
import { previewHtmlFile } from './agent/preview';
import { checkOllamaSetup } from './ai/ollamaSetup';
import { initTelemetry, trackEvent } from './telemetry';

export function activate(context: vscode.ExtensionContext) {
    const git = new GitService();

    registerInlineEdit(context);
    registerTabCompletion(context);

    // Init systems in background
    warmLicenseCache(context);
    initWorkspaceTreeCache(context);
    initTelemetry(context);
    checkOllamaSetup(context).catch(() => {});

    // ── Sidebar chat ───────────────────────────────────────────────────────
    const chatProvider = new ChatViewProvider(context, git);
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, chatProvider, {
            webviewOptions: { retainContextWhenHidden: true }
        })
    );

    // ── Status bar ──────────────────────────────────────────────────────────
    const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusBar.command = 'freebird.openChat';
    statusBar.text = '$(send) Freebird AI';
    statusBar.tooltip = 'Freebird AI — click to open chat';
    statusBar.show();
    context.subscriptions.push(statusBar);

    async function refreshStatusBar() {
        const s = await getLicenseStatus(context);
        statusBar.text = s.isPro ? '$(send) Freebird AI Pro' : '$(send) Freebird AI';
        statusBar.tooltip = s.isPro
            ? `Freebird AI Pro — ${s.email ?? 'active'}`
            : 'Freebird AI Free — click to open chat';
        if (ChatViewProvider.current) ChatViewProvider.current.showLicenseStatus();
    }
    refreshStatusBar();

    // ── Helper: require Pro or daily cloud edits ────────────────────────────
    async function requireProOrCloudEdit(featureName: string): Promise<boolean> {
        const s = await getLicenseStatus(context);
        if (s.isPro) return true;

        const remaining = getCloudEditsRemaining(context);
        if (remaining > 0) return true;

        const action = await vscode.window.showWarningMessage(
            `Daily cloud edits used. "${featureName}" needs cloud AI — upgrade to Pro for unlimited, or wait until tomorrow.`,
            'Upgrade to Pro',
            'Activate License'
        );
        if (action === 'Upgrade to Pro') vscode.env.openExternal(vscode.Uri.parse(UPGRADE_URL));
        if (action === 'Activate License') vscode.commands.executeCommand('freebird.activateLicense');
        return false;
    }

    // ── Commands ────────────────────────────────────────────────────────────
    context.subscriptions.push(

        // Open or focus the sidebar chat
        vscode.commands.registerCommand('freebird.openChat', () => {
            trackEvent('chat_opened');
            if (ChatViewProvider.current) {
                ChatViewProvider.current.focus();
            }
            // The sidebar view is auto-created by VS Code when the view container is shown
            vscode.commands.executeCommand('freebird.chatView.focus');
        }),

        // AI commit
        vscode.commands.registerCommand('freebird.aiCommit', async () => {
            if (!await requireProOrCloudEdit('AI Commit')) return;
            trackEvent('ai_commit');
            if (ChatViewProvider.current) {
                ChatViewProvider.current.focus();
                ChatViewProvider.current.triggerCommand('commit');
            }
        }),

        // Inline edit
        vscode.commands.registerCommand('freebird.inlineEdit', async () => {
            if (!await requireProOrCloudEdit('Inline Edit')) return;
            trackEvent('inline_edit');
            vscode.commands.executeCommand('freebird._inlineEditInternal');
        }),

        vscode.commands.registerCommand('freebird.activateLicense', async () => {
            const key = await vscode.window.showInputBox({
                prompt: 'Enter your Freebird AI Pro license key',
                placeHolder: 'FB-XXXX-XXXX-XXXX-XXXX',
                title: 'Activate Freebird AI Pro',
                validateInput: v => v && v.trim().length > 5 ? null : 'Please enter a valid license key'
            });
            if (!key) return;

            await vscode.window.withProgress(
                { location: vscode.ProgressLocation.Notification, title: 'Validating license key…', cancellable: false },
                async () => {
                    const status = await activateLicense(context, key);
                    if (status.isPro) {
                        trackEvent('license_activated');
                        vscode.window.showInformationMessage(
                            `Freebird AI Pro activated${status.email ? ` for ${status.email}` : ''}. Enjoy unlimited access!`
                        );
                        refreshStatusBar();
                    } else {
                        const action = await vscode.window.showErrorMessage(
                            'License key not recognised or subscription is inactive.',
                            'Buy Pro', 'Try Again'
                        );
                        if (action === 'Buy Pro') vscode.env.openExternal(vscode.Uri.parse(UPGRADE_URL));
                        if (action === 'Try Again') vscode.commands.executeCommand('freebird.activateLicense');
                    }
                }
            );
        }),

        vscode.commands.registerCommand('freebird.upgradeToPro', () => {
            trackEvent('upgrade_clicked');
            vscode.env.openExternal(vscode.Uri.parse(UPGRADE_URL));
        }),

        vscode.commands.registerCommand('freebird.previewHtml', (uri?: vscode.Uri) => {
            const target = uri ?? vscode.window.activeTextEditor?.document.uri;
            if (!target) {
                vscode.window.showWarningMessage('Open an HTML file to preview it.');
                return;
            }
            previewHtmlFile(target.fsPath);
        }),

        vscode.commands.registerCommand('freebird.configure', async () => {
            const backend = await vscode.window.showQuickPick(
                [
                    { label: '$(server) Ollama (local — free)',  value: 'ollama',    description: 'Unlimited, 100% private, runs on your machine' },
                    { label: '$(cloud) Anthropic Claude (Pro)',  value: 'anthropic', description: 'BYOK — direct-to-LLM speed, total privacy' },
                    { label: '$(cloud) OpenAI (Pro)',            value: 'openai',    description: 'BYOK — direct-to-LLM speed, total privacy' },
                    { label: '$(cloud) DeepSeek Coder V2 (Pro)', value: 'deepseek',  description: 'BYOK — fast coding model, great value' },
                    { label: '$(cloud) Qwen 2.5 (Pro)',          value: 'qwen',      description: 'BYOK — powerful coding model via DashScope' }
                ],
                { placeHolder: 'Select AI backend', title: 'Freebird AI: Configure AI Backend' }
            );
            if (!backend) return;

            await vscode.workspace.getConfiguration('freebird').update('backend', backend.value, true);

            if (backend.value !== 'ollama') {
                const key = await vscode.window.showInputBox({
                    prompt: `Enter your ${backend.label} API key`,
                    password: true,
                    placeHolder: 'sk-...'
                });
                if (key) await vscode.workspace.getConfiguration('freebird').update('apiKey', key, true);
            }

            trackEvent('backend_configured');
            vscode.window.showInformationMessage(`Freebird AI configured to use ${backend.label}`);
            clearLicenseCache(context);
            refreshStatusBar();
        })
    );
}

export function deactivate() {}
