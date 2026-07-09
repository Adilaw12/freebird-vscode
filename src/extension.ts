import * as vscode from 'vscode';
import { ChatViewProvider } from './chat/panel';
import { GitService } from './git/service';
import { registerInlineEdit } from './inline/editor';
import { registerTabCompletion } from './inline/completionProvider';
import { getLicenseStatus, warmLicenseCache, activateLicense, clearLicenseCache, startTrial, UPGRADE_URL, API_BASE } from './license/validator';
import { getCloudEditsRemaining } from './license/usage';
import { signInWithGitHub, getStoredSession, clearSession } from './auth/github';
import { initWorkspaceTreeCache } from './agent/tools';
import { previewHtmlFile } from './agent/preview';
import { checkOllamaSetup } from './ai/ollamaSetup';
import { initTelemetry, disposeTelemetry, trackEvent } from './telemetry';
import { checkAnnouncement } from './announcement';

export function activate(context: vscode.ExtensionContext) {
    const git = new GitService();

    registerInlineEdit(context);
    registerTabCompletion(context);

    // Init systems in background
    warmLicenseCache(context);
    initWorkspaceTreeCache(context);
    initTelemetry(context);
    checkOllamaSetup(context).catch(() => {});
    checkAnnouncement(context).catch(() => {});

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
        const planLabel = s.plan === 'enterprise' ? 'Enterprise' : s.plan === 'team' ? 'Team' : s.plan === 'trial' ? 'Trial' : 'Pro';
        if (s.isPro) {
            statusBar.text = `$(send) Freebird AI ${planLabel}`;
            if (s.plan === 'trial' && s.expiresAt) {
                const daysLeft = Math.max(0, Math.ceil((new Date(s.expiresAt).getTime() - Date.now()) / (24 * 60 * 60 * 1000)));
                statusBar.tooltip = `Freebird AI Trial — ${daysLeft} day${daysLeft === 1 ? '' : 's'} left`;
            } else {
                statusBar.tooltip = `Freebird AI ${planLabel} — ${s.email ?? 'active'}`;
            }
        } else {
            const session = await getStoredSession(context);
            statusBar.text = '$(send) Freebird AI';
            statusBar.tooltip = session
                ? `Freebird AI Free — signed in as ${session.login} — click to open chat`
                : 'Freebird AI Free — click to open chat';
        }
        if (ChatViewProvider.current) ChatViewProvider.current.showLicenseStatus();
    }
    refreshStatusBar();

    // ── First-run onboarding walkthrough ────────────────────────────────────
    // Opens once per install, guiding: choose a backend → sign in/try an edit
    // → learn commands → (optionally) upgrade. Safe to call repeatedly — VS
    // Code no-ops if the user already dismissed or completed it, but we still
    // gate on our own flag so it never reopens after the very first run.
    const WALKTHROUGH_SHOWN_KEY = 'freebird.walkthroughShown';
    if (!context.globalState.get<boolean>(WALKTHROUGH_SHOWN_KEY)) {
        context.globalState.update(WALKTHROUGH_SHOWN_KEY, true);
        vscode.commands.executeCommand(
            'workbench.action.openWalkthrough',
            'TenLabs.freebird-ai#freebirdWelcome',
            false
        );
    }

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

        vscode.commands.registerCommand('freebird.signInWithGitHub', async () => {
            try {
                const session = await vscode.window.withProgress(
                    { location: vscode.ProgressLocation.Notification, title: 'Waiting for GitHub sign-in…', cancellable: false },
                    () => signInWithGitHub(context)
                );
                trackEvent('github_signed_in');
                vscode.window.showInformationMessage(`Signed in to Freebird as ${session.login}.`);
                refreshStatusBar();
            } catch (err: any) {
                if (err?.message === 'CANCELLED') return;
                vscode.window.showErrorMessage(`GitHub sign-in failed: ${err.message}`);
            }
        }),

        vscode.commands.registerCommand('freebird.signOutGitHub', async () => {
            await clearSession(context);
            vscode.window.showInformationMessage('Signed out of Freebird GitHub sign-in.');
            refreshStatusBar();
        }),

        vscode.commands.registerCommand('freebird.startTrial', async () => {
            let session = await getStoredSession(context);

            if (!session) {
                const choice = await vscode.window.showInformationMessage(
                    'Starting your free 7-day Pro trial needs a quick GitHub sign-in (so trials can\'t be reused) — no email required.',
                    'Sign in with GitHub', 'Cancel'
                );
                if (choice !== 'Sign in with GitHub') return;

                try {
                    session = await vscode.window.withProgress(
                        { location: vscode.ProgressLocation.Notification, title: 'Waiting for GitHub sign-in…', cancellable: false },
                        () => signInWithGitHub(context)
                    );
                    trackEvent('github_signed_in');
                } catch (err: any) {
                    if (err?.message === 'CANCELLED') return;
                    vscode.window.showErrorMessage(`GitHub sign-in failed: ${err.message}`);
                    return;
                }
            }

            const activeSession = session;
            await vscode.window.withProgress(
                { location: vscode.ProgressLocation.Notification, title: 'Starting your Pro trial…', cancellable: false },
                async () => {
                    const result = await startTrial(context, activeSession.sessionToken);

                    if (result.ok) {
                        trackEvent('trial_started');
                        vscode.window.showInformationMessage(
                            '🎉 7-day Freebird Pro trial activated — unlimited edits, BYOK, and project memory. Enjoy!'
                        );
                        refreshStatusBar();
                    } else if (result.code === 'TRIAL_USED') {
                        trackEvent('trial_already_used');
                        const action = await vscode.window.showWarningMessage(
                            'You\'ve already used your free trial on this GitHub account.',
                            'Upgrade to Pro'
                        );
                        if (action === 'Upgrade to Pro') {
                            trackEvent('upgrade_clicked');
                            vscode.env.openExternal(vscode.Uri.parse(UPGRADE_URL));
                        }
                    } else {
                        vscode.window.showErrorMessage(result.error ?? 'Could not start trial. Please try again.');
                    }
                }
            );
        }),

        vscode.commands.registerCommand('freebird.manageTeamSeats', async () => {
            const status = await getLicenseStatus(context);
            if (status.plan !== 'team') {
                vscode.window.showWarningMessage('Team seat management is only available on the Team plan.');
                return;
            }
            if (!status.isTeamOwner) {
                vscode.window.showWarningMessage(
                    'Only the team owner can manage seats. Ask whoever purchased the Team plan to run this from their own license key.'
                );
                return;
            }

            const ownerKey = vscode.workspace.getConfiguration('freebird').get<string>('licenseKey', '').trim();

            const choice = await vscode.window.showQuickPick(
                [
                    { label: '$(list-unordered) View seats',  value: 'list' },
                    { label: '$(person-add) Add a teammate',  value: 'add' },
                    { label: '$(person-remove) Remove a seat', value: 'remove' }
                ],
                { placeHolder: 'Manage Freebird Team seats', title: 'Freebird Team' }
            );
            if (!choice) return;

            try {
                if (choice.value === 'list') {
                    const listRes = await fetch(`${API_BASE}/api/team-seats`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ ownerLicenseKey: ownerKey, action: 'list' })
                    });
                    const data = await listRes.json() as any;
                    if (!listRes.ok) throw new Error(data.error ?? 'Could not load seats');

                    const lines = data.seats.map((s: any) =>
                        `${s.isOwner ? '👑 ' : '   '}${s.email} — ${s.status}`
                    );
                    vscode.window.showInformationMessage(
                        `Team seats (${data.usedSeats}/${data.maxSeats}):\n${lines.join('\n')}`,
                        { modal: true }
                    );

                } else if (choice.value === 'add') {
                    const email = await vscode.window.showInputBox({
                        prompt: 'Teammate\'s email address',
                        placeHolder: '[email protected]',
                        validateInput: v => v && v.includes('@') ? null : 'Enter a valid email'
                    });
                    if (!email) return;

                    const addRes = await vscode.window.withProgress(
                        { location: vscode.ProgressLocation.Notification, title: 'Adding teammate…', cancellable: false },
                        () => fetch(`${API_BASE}/api/team-seats`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ ownerLicenseKey: ownerKey, action: 'add', teammateEmail: email })
                        })
                    );
                    const data = await addRes.json() as any;
                    if (!addRes.ok) throw new Error(data.error ?? 'Could not add seat');

                    await vscode.env.clipboard.writeText(data.key);
                    vscode.window.showInformationMessage(
                        `Seat added for ${data.email} (${data.usedSeats}/${data.maxSeats} used). ` +
                        `License key copied to clipboard — send it to them to activate via "Freebird: Activate Pro License": ${data.key}`,
                        { modal: true }
                    );

                } else if (choice.value === 'remove') {
                    const listRes = await fetch(`${API_BASE}/api/team-seats`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ ownerLicenseKey: ownerKey, action: 'list' })
                    });
                    const data = await listRes.json() as any;
                    if (!listRes.ok) throw new Error(data.error ?? 'Could not load seats');

                    const removable = data.seats.filter((s: any) => !s.isOwner);
                    if (removable.length === 0) {
                        vscode.window.showInformationMessage('No teammate seats to remove yet.');
                        return;
                    }

                    const target = await vscode.window.showQuickPick(
                        removable.map((s: any) => ({ label: s.email, description: s.status, value: s.key })),
                        { placeHolder: 'Remove which teammate?' }
                    );
                    if (!target) return;

                    const removeRes = await fetch(`${API_BASE}/api/team-seats`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ ownerLicenseKey: ownerKey, action: 'remove', seatKey: (target as any).value })
                    });
                    const removeData = await removeRes.json() as any;
                    if (!removeRes.ok) throw new Error(removeData.error ?? 'Could not remove seat');

                    vscode.window.showInformationMessage(`Removed ${(target as any).label} (${removeData.usedSeats}/${removeData.maxSeats} used).`);
                }
            } catch (err: any) {
                vscode.window.showErrorMessage(`Team seat management failed: ${err.message}`);
            }
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
                    { label: '$(zap) Freebird Cloud (default)',    value: 'cloud',     description: 'Gemini Flash — works instantly, 5 free edits/day' },
                    { label: '$(server) Ollama (local — free)',    value: 'ollama',    description: 'Unlimited, 100% private, runs on your machine' },
                    { label: '$(cloud) Anthropic Claude (Pro)',    value: 'anthropic', description: 'BYOK — direct-to-LLM speed, total privacy' },
                    { label: '$(cloud) OpenAI (Pro)',              value: 'openai',    description: 'BYOK — direct-to-LLM speed, total privacy' },
                    { label: '$(cloud) DeepSeek V4-pro (Pro)',     value: 'deepseek',  description: 'BYOK — advanced reasoning model, excellent value' },
                    { label: '$(cloud) Qwen 2.5 (Pro)',            value: 'qwen',      description: 'BYOK — powerful coding model via DashScope' }
                ],
                { placeHolder: 'Select AI backend', title: 'Freebird AI: Configure AI Backend' }
            );
            if (!backend) return;

            await vscode.workspace.getConfiguration('freebird').update('backend', backend.value, true);

            const needsKey = !['cloud', 'ollama'].includes(backend.value);
            if (needsKey) {
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

export function deactivate() {
    disposeTelemetry();
}
