import * as vscode from 'vscode';
import { ChatPanel } from './chat/panel';
import { GitService } from './git/service';
import { registerInlineEdit } from './inline/editor';
import { getLicenseStatus, activateLicense, clearLicenseCache, UPGRADE_URL } from './license/validator';

export function activate(context: vscode.ExtensionContext) {
    const git = new GitService();

    registerInlineEdit(context);

    // ── Status bar ────────────────────────────────────────────────────────────
    const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusBar.command = 'openpilot.openChat';
    statusBar.text = '$(rocket) OpenPilot';
    statusBar.tooltip = 'OpenPilot — click to open chat';
    statusBar.show();
    context.subscriptions.push(statusBar);

    async function refreshStatusBar() {
        const s = await getLicenseStatus(context);
        statusBar.text = s.isPro ? '$(rocket) OpenPilot Pro' : '$(rocket) OpenPilot';
        statusBar.tooltip = s.isPro
            ? `OpenPilot Pro — ${s.email ?? 'active'}`
            : 'OpenPilot Free — click to open chat';
        if (ChatPanel.current) ChatPanel.current.showLicenseStatus();
    }
    refreshStatusBar();

    // ── Commands ──────────────────────────────────────────────────────────────
    context.subscriptions.push(

        vscode.commands.registerCommand('openpilot.openChat', () => {
            ChatPanel.open(context, git);
        }),

        vscode.commands.registerCommand('openpilot.aiCommit', () => {
            ChatPanel.open(context, git, 'commit');
        }),

        vscode.commands.registerCommand('openpilot.activateLicense', async () => {
            const key = await vscode.window.showInputBox({
                prompt: 'Enter your OpenPilot Pro license key',
                placeHolder: 'OP-XXXX-XXXX-XXXX-XXXX',
                title: 'Activate OpenPilot Pro',
                validateInput: v => v && v.trim().length > 5 ? null : 'Please enter a valid license key'
            });
            if (!key) return;

            const status = await activateLicense(context, key);
            if (status.isPro) {
                vscode.window.showInformationMessage(
                    `OpenPilot Pro activated${status.email ? ` for ${status.email}` : ''}. Enjoy unlimited access!`
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
        }),

        vscode.commands.registerCommand('openpilot.upgradeToPro', () => {
            vscode.env.openExternal(vscode.Uri.parse(UPGRADE_URL));
        }),

        vscode.commands.registerCommand('openpilot.configure', async () => {
            const backend = await vscode.window.showQuickPick(
                [
                    { label: '$(server) Ollama (local — free)', value: 'ollama',     description: 'Runs on your machine, no API key needed' },
                    { label: '$(cloud) Anthropic Claude',        value: 'anthropic',  description: 'Pay-as-you-go, ~$0.001 per message' },
                    { label: '$(cloud) OpenAI',                  value: 'openai',     description: 'Pay-as-you-go, GPT-4o-mini' }
                ],
                { placeHolder: 'Select AI backend', title: 'OpenPilot: Configure AI Backend' }
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

            vscode.window.showInformationMessage(`OpenPilot configured to use ${backend.label}`);
            clearLicenseCache(context);
            refreshStatusBar();
        })
    );
}

export function deactivate() {}
