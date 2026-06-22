import * as vscode from 'vscode';
import * as cp from 'child_process';

/**
 * checkOllamaSetup — called at extension activation when backend = 'ollama'.
 *
 * Replaces the previous silent auto-install approach (which failed on most
 * machines due to OS security restrictions) with a clear, actionable message.
 *
 * Flow:
 *   1. If Ollama is running → ensure the model is pulled, return.
 *   2. If Ollama is installed but not running → auto-start it, return.
 *   3. If Ollama is not installed → show a notification with two options:
 *        a. "Install Ollama" → open ollama.com/download
 *        b. "Use Cloud Edits" → switch backend to 'cloud' (5 free/day)
 *      This replaces the previous silent curl-pipe-to-sh installer which
 *      was blocked by Gatekeeper on macOS and UAC on Windows.
 */
export async function checkOllamaSetup(context: vscode.ExtensionContext): Promise<void> {
    const config  = vscode.workspace.getConfiguration('freebird');
    const backend = config.get<string>('backend', 'cloud');

    // Only run this check when the user has explicitly chosen Ollama
    if (backend !== 'ollama') return;

    const url = config.get<string>('ollamaUrl', 'http://localhost:11434');

    // Already running — ensure model is present
    if (await pingOllama(url)) {
        await ensureModel(url, config.get<string>('model') || 'qwen2.5-coder');
        return;
    }

    // Installed but not running — try to start it silently
    if (isOllamaInstalled()) {
        startOllama();
        const ready = await waitForOllama(url, 10_000);
        if (ready) {
            await ensureModel(url, config.get<string>('model') || 'qwen2.5-coder');
        } else {
            vscode.window.showWarningMessage(
                'Ollama is installed but took too long to start. Try running "ollama serve" in a terminal.',
                'Open Terminal'
            ).then(action => {
                if (action === 'Open Terminal') {
                    vscode.commands.executeCommand('workbench.action.terminal.new');
                }
            });
        }
        return;
    }

    // Not installed — show a clear choice instead of silently trying to install
    const dismissed = context.globalState.get<boolean>('freebird.ollamaPromptDismissed');
    if (dismissed) return;

    const action = await vscode.window.showInformationMessage(
        'Freebird is set to use Ollama (local AI), but Ollama isn\'t installed yet.',
        { modal: false },
        'Install Ollama',
        'Use Cloud Edits (5/day free)',
        'Don\'t show again'
    );

    if (action === 'Install Ollama') {
        vscode.env.openExternal(vscode.Uri.parse('https://ollama.com/download'));
        vscode.window.showInformationMessage(
            'After installing Ollama, run "ollama pull qwen2.5-coder" in a terminal, then reload VS Code.'
        );
    } else if (action === 'Use Cloud Edits (5/day free)') {
        await vscode.workspace.getConfiguration('freebird').update('backend', 'cloud', true);
        vscode.window.showInformationMessage(
            'Switched to Freebird Cloud (Gemini Flash, 5 free edits/day). Upgrade to Pro for unlimited.'
        );
    } else if (action === 'Don\'t show again') {
        await context.globalState.update('freebird.ollamaPromptDismissed', true);
    }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

async function pingOllama(url: string): Promise<boolean> {
    try {
        const res = await fetch(`${url}/api/tags`, { signal: AbortSignal.timeout(1500) });
        return res.ok;
    } catch {
        return false;
    }
}

function isOllamaInstalled(): boolean {
    try {
        const cmd = process.platform === 'win32' ? 'where ollama' : 'which ollama';
        return cp.execSync(cmd, { timeout: 3000, encoding: 'utf8' }).trim().length > 0;
    } catch {
        return false;
    }
}

function startOllama(): void {
    try {
        if (process.platform === 'win32') {
            cp.exec('ollama serve', { windowsHide: true });
        } else {
            cp.exec('ollama serve', { shell: '/bin/sh' });
        }
    } catch { /* may already be running */ }
}

async function waitForOllama(url: string, timeoutMs: number): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        if (await pingOllama(url)) return true;
        await new Promise(r => setTimeout(r, 1000));
    }
    return false;
}

async function ensureModel(url: string, model: string): Promise<void> {
    try {
        const res = await fetch(`${url}/api/tags`, { signal: AbortSignal.timeout(3000) });
        if (!res.ok) return;

        const data = await res.json() as { models?: Array<{ name: string }> };
        if (data.models?.some(m => m.name.startsWith(model))) return;

        const action = await vscode.window.showInformationMessage(
            `Ollama is running but "${model}" isn't installed. Pull it now? (~1–4 GB)`,
            'Pull model',
            'Skip'
        );
        if (action !== 'Pull model') return;

        await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: `Pulling ${model}…`, cancellable: true },
            async (progress, token) => {
                const pull = await fetch(`${url}/api/pull`, {
                    method:  'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body:    JSON.stringify({ name: model, stream: true })
                });
                if (!pull.ok) throw new Error(`Pull failed: ${pull.statusText}`);

                const reader  = pull.body!.getReader();
                const decoder = new TextDecoder();

                while (!token.isCancellationRequested) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    for (const line of decoder.decode(value).split('\n').filter(Boolean)) {
                        try {
                            const d = JSON.parse(line);
                            if (d.status) {
                                const pct = d.completed && d.total
                                    ? ` (${Math.round(d.completed / d.total * 100)}%)`
                                    : '';
                                progress.report({ message: `${d.status}${pct}` });
                            }
                        } catch { /* skip malformed */ }
                    }
                }
                vscode.window.showInformationMessage(`"${model}" is ready!`);
            }
        );
    } catch { /* non-critical */ }
}
