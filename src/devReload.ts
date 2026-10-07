import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Development only: reload the Extension Development Host whenever the compiled
 * extension (out/) or the webview HTML (media/) changes, so `npm run dev` gives a
 * save → rebuild → reload loop with no manual Ctrl+R. Does nothing for an
 * installed copy. Set FREEBIRD_NO_AUTORELOAD=1 to switch it off.
 */
export function watchForDevReload(context: vscode.ExtensionContext): void {
    if (context.extensionMode !== vscode.ExtensionMode.Development) return;
    if (process.env.FREEBIRD_NO_AUTORELOAD) return;

    let timer: ReturnType<typeof setTimeout> | undefined;
    // A compile rewrites many files at once — wait for the burst to finish.
    const trigger = () => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
            void vscode.commands.executeCommand('workbench.action.reloadWindow');
        }, 1500);
    };

    for (const dir of ['out', 'media']) {
        try {
            const watcher = fs.watch(path.join(context.extensionPath, dir), { recursive: true }, (_event, file) => {
                if (file && /\.(js|html|json)$/.test(file)) trigger();
            });
            context.subscriptions.push({ dispose: () => watcher.close() });
        } catch { /* directory missing or watching unsupported — manual reload still works */ }
    }
}
