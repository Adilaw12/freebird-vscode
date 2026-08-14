import * as vscode from 'vscode';
import { getLicenseStatus, UPGRADE_URL, API_BASE } from '../license/validator';

// "Share a portion of your code with a colleague without exposing your whole
// codebase" — a Pro feature. Posts the selection to backend/api/share.js,
// which stores it in Redis for 14 days behind an unguessable link; the
// colleague opens it in a browser, no Freebird install or repo access needed.

export function registerShareSelection(context: vscode.ExtensionContext) {
    context.subscriptions.push(
        vscode.commands.registerCommand('freebird.shareSelection', () => shareSelection(context))
    );
}

async function shareSelection(context: vscode.ExtensionContext) {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        vscode.window.showWarningMessage('Open a file and select the code you want to share first.');
        return;
    }

    const selection = editor.selection;
    const code = selection.isEmpty ? editor.document.getText() : editor.document.getText(selection);
    if (!code.trim()) {
        vscode.window.showWarningMessage('Select some code first, then use Freebird: Share Selection.');
        return;
    }

    const license = await getLicenseStatus(context);
    if (!license.isPro) {
        vscode.window.showWarningMessage(
            'Sharing a snippet with a colleague is a Pro feature — share just this selection, not your whole workspace.',
            'Upgrade to Pro',
            'Dismiss'
        ).then(choice => {
            if (choice === 'Upgrade to Pro') vscode.env.openExternal(vscode.Uri.parse(UPGRADE_URL));
        });
        return;
    }

    const licenseKey = vscode.workspace.getConfiguration('freebird').get<string>('licenseKey', '').trim();
    if (!licenseKey) {
        vscode.window.showWarningMessage('Run Freebird: Activate Pro License first.');
        return;
    }

    const title = await vscode.window.showInputBox({
        prompt: 'Optional title for this share (shown to whoever opens the link)',
        placeHolder: 'e.g. "the retry logic we discussed" — leave blank to skip',
        title: 'Freebird: Share Selection'
    });
    if (title === undefined) return; // Escape — user backed out of the flow entirely

    const language = editor.document.languageId;
    const filename = vscode.workspace.asRelativePath(editor.document.fileName);

    await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Freebird: Creating share link…', cancellable: false },
        async () => {
            try {
                const res = await fetch(`${API_BASE}/api/share`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ licenseKey, code, language, filename, title: title || undefined }),
                    signal: AbortSignal.timeout(15_000)
                });

                if (!res.ok) {
                    const body = await res.json().catch(() => ({})) as Record<string, unknown>;
                    vscode.window.showErrorMessage(`Couldn't create share link: ${(body.error as string) ?? res.statusText}`);
                    return;
                }

                const { url, expiresInDays } = await res.json() as { url: string; expiresInDays: number };
                await vscode.env.clipboard.writeText(url);
                vscode.window.showInformationMessage(
                    `Share link copied to clipboard — expires in ${expiresInDays} days.`,
                    'Open in Browser'
                ).then(choice => {
                    if (choice === 'Open in Browser') vscode.env.openExternal(vscode.Uri.parse(url));
                });
            } catch (err: any) {
                vscode.window.showErrorMessage(`Couldn't create share link: ${err?.message ?? String(err)}`);
            }
        }
    );
}
