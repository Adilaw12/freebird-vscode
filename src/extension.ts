import * as vscode from 'vscode';
import { ChatPanel } from './chat/panel';
import { GitService } from './git/service';
import { registerInlineEdit } from './inline/editor';
import { getLicenseStatus, warmLicenseCache, activateLicense, clearLicenseCache, UPGRADE_URL } from './license/validator';
import { initWorkspaceTreeCache } from './agent/tools';

export function activate(context: vscode.ExtensionContext) {
    const git = new GitService();

    registerInlineEdit(context);

    // Warm caches immediately in the background — no blocking at startup
    warmLicenseCache(context);
    initWorkspaceTreeCache(context);

    // ── Status bar ──────────────────────────────────────────────────────────
    const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusBar.command = 'openpilot.openChat';
    statusBar.text = '$(send) OpenPilot AI';
    statusBar.tooltip = 'OpenPilot AI — click to open chat';
    statusBar.show();
    context.subscriptions.push(statusBar);

    async function refreshStatusBar() {
        const s = await getLicenseStatus(context);
        statusBar.text = s.isPro ? '$(send) OpenPilot AI Pro' : '$(send) OpenPilot AI';
        statusBar.tooltip = s.isPro
            ? `OpenPilot AI Pro — ${s.email ?? 'active'}`
            : 'OpenPilot AI Free — click to open chat';
        if (ChatPanel.current) ChatPanel.current.showLicenseStatus();
    }
    refreshStatusBar();

    // ── Helper: require Pro or prompt upgrade ───────────────────────────────
    async function requirePro(featureName: string): Promise<boolean> {
        const s = await getLicenseStatus(context); // hits in-memory cache — fast
        if (s.isPro) return true;

        const action = await vscode.window.showWarningMessage(
            `"${featureName}" is an OpenPilot AI Pro feature.`,
            'Upgrade to Pro',
            'Activate License'
        );
        if (action === 'Upgrade to Pro') vscode.env.openExternal(vscode.Uri.parse(UPGRADE_URL));
        if (action === 'Activate License') vscode.commands.executeCommand('openpilot.activateLicense');
        return false;
    }

    // ── Commands ────────────────────────────────────────────────────────────
    context.subscriptions.push(

        // FREE — chat is available to everyone
        vscode.commands.registerCommand('openpilot.openChat', () => {
            ChatPanel.open(context, git);
        }),

        // PRO — AI commit requires active subscription
        vscode.commands.registerCommand('openpilot.aiCommit', async () => {
            if (!await requirePro('AI Commit')) return;
            ChatPanel.open(context, git, 'commit');
        }),

        // PRO — inline edit requires active subscription
        vscode.commands.registerCommand('openpilot.inlineEdit', async () => {
            if (!await requirePro('Inline Edit')) return;
            vscode.commands.executeCommand('openpilot._inlineEditInternal');
        }),

        vscode.commands.registerCommand('openpilot.activateLicense', async () => {
            const key = await vscode.window.showInputBox({
                prompt: 'Enter your OpenPilot AI Pro license key',
                placeHolder: 'OP-XXXX-XXXX-XXXX-XXXX',
                title: 'Activate OpenPilot AI Pro',
                validateInput: v => v && v.trim().length > 5 ? null : 'Please enter a valid license key'
            });
            if (!key) return;

            await vscode.window.withProgress(
                { location: vscode.ProgressLocation.Notification, title: 'Validating license key…', cancellable: false },
                async () => {
                    const status = await activateLicense(context, key);
                    if (status.isPro) {
                        vscode.window.showInformationMessage(
                            `OpenPilot AI Pro activated${status.email ? ` for ${status.email}` : ''}. Enjoy unlimited access!`
                        );
                        refreshStatusBar();
                    } else {
                        const action = await vscode.window.showErrorMessage(
                            'License key not recognised or subscription is inactive.',
                            'Buy Pro', 'Try Again'
                        );
                        if (action === 'Buy Pro') vscode.env.openExternal(vscode.Uri.parse(UPGRADE_URL));
                        if (action === 'Try Again') vscode.commands.executeCommand('openpilot.activateLicense');
                    }
                }
            );
        }),

        vscode.commands.registerCommand('openpilot.upgradeToPro', () => {
            vscode.env.openExternal(vscode.Uri.parse(UPGRADE_URL));
        }),

        vscode.commands.registerCommand('openpilot.configure', async () => {
            const backend = await vscode.window.showQuickPick(
                [
                    { label: '$(server) Ollama (local — free)', value: 'ollama',    description: 'Runs on your machine, no API key needed' },
                    { label: '$(cloud) Anthropic Claude',       value: 'anthropic', description: 'Pay-as-you-go, ~$0.001 per message' },
                    { label: '$(cloud) OpenAI',                 value: 'openai',    description: 'Pay-as-you-go, GPT-4o-mini' }
                ],
                { placeHolder: 'Select AI backend', title: 'OpenPilot AI: Configure AI Backend' }
            );
            if (!backend) return;

            await vscode.workspace.getConfiguration('openpilot').update('backend', backend.value, true);

            if (backend.value !== 'ollama') {
                const key = await vscode.window.showInputBox({
                    prompt: `Enter your ${backend.label} API key`,
                    password: true,
                    placeHolder: 'sk-...'
                });
                if (key) await vscode.workspace.getConfiguration('openpilot').update('apiKey', key, true);
            }

            vscode.window.showInformationMessage(`OpenPilot AI configured to use ${backend.label}`);
            clearLicenseCache(context);
            refreshStatusBar();
        })
    );
}

export function deactivate() {}
