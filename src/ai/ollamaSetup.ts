import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as path from 'path';
import * as fs from 'fs';

export async function checkOllamaSetup(context: vscode.ExtensionContext): Promise<void> {
    const config = vscode.workspace.getConfiguration('freebird');
    const backend = config.get<string>('backend', 'ollama');
    if (backend !== 'ollama') return;
    if (context.globalState.get<boolean>('ollamaSetupDismissed')) return;

    const url = config.get<string>('ollamaUrl', 'http://localhost:11434');

    // Already running — just make sure the model is pulled
    if (await pingOllama(url)) {
        await ensureModel(url, config.get<string>('model') || 'qwen2.5-coder');
        return;
    }

    // Installed but not running — auto-start
    if (isOllamaInstalled()) {
        startOllama();
        const ready = await waitForOllama(url, 15000);
        if (ready) {
            await ensureModel(url, config.get<string>('model') || 'qwen2.5-coder');
        }
        return;
    }

    // Not installed — auto-download with progress notification
    await installOllama(context);
}

async function installOllama(context: vscode.ExtensionContext): Promise<void> {
    const platform = process.platform;

    await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Freebird: Setting up Ollama for free local AI...', cancellable: true },
        async (progress, token) => {
            try {
                if (platform === 'win32') {
                    progress.report({ message: 'Downloading Ollama installer...' });
                    const installerUrl = 'https://ollama.com/download/OllamaSetup.exe';
                    const downloadDir = path.join(context.globalStorageUri.fsPath, 'downloads');
                    fs.mkdirSync(downloadDir, { recursive: true });
                    const installerPath = path.join(downloadDir, 'OllamaSetup.exe');

                    await downloadFile(installerUrl, installerPath, token);
                    if (token.isCancellationRequested) {
                        await context.globalState.update('ollamaSetupDismissed', true);
                        return;
                    }

                    progress.report({ message: 'Installing (this may take a moment)...' });
                    cp.execSync(`"${installerPath}" /VERYSILENT /SUPPRESSMSGBOXES /NORESTART`, { timeout: 120000 });

                    try { fs.unlinkSync(installerPath); } catch { /* cleanup optional */ }
                } else if (platform === 'darwin' || platform === 'linux') {
                    progress.report({ message: 'Downloading and installing Ollama...' });
                    cp.execSync('curl -fsSL https://ollama.com/install.sh | sh', {
                        timeout: 120000,
                        shell: '/bin/sh'
                    });
                } else {
                    vscode.env.openExternal(vscode.Uri.parse('https://ollama.com/download'));
                    return;
                }

                if (token.isCancellationRequested) {
                    await context.globalState.update('ollamaSetupDismissed', true);
                    return;
                }

                progress.report({ message: 'Starting Ollama...' });
                startOllama();

                const url = vscode.workspace.getConfiguration('freebird').get<string>('ollamaUrl', 'http://localhost:11434');
                const ready = await waitForOllama(url, 20000);

                if (ready) {
                    progress.report({ message: 'Pulling qwen2.5-coder model...' });
                    const model = vscode.workspace.getConfiguration('freebird').get<string>('model') || 'qwen2.5-coder';
                    await pullModel(url, model, progress, token);
                    vscode.window.showInformationMessage(
                        'Ollama is ready! Freebird is now using free local AI.'
                    );
                } else {
                    vscode.window.showWarningMessage('Ollama installed but taking a while to start. Try restarting VS Code.');
                }
            } catch (err: any) {
                const action = await vscode.window.showErrorMessage(
                    `Ollama auto-setup failed: ${err.message}`,
                    'Install manually', 'Use cloud backend', "Don't try again"
                );
                if (action === 'Install manually') {
                    vscode.env.openExternal(vscode.Uri.parse('https://ollama.com/download'));
                } else if (action === 'Use cloud backend') {
                    vscode.commands.executeCommand('freebird.configure');
                } else if (action === "Don't try again") {
                    await context.globalState.update('ollamaSetupDismissed', true);
                }
            }
        }
    );
}

function isOllamaInstalled(): boolean {
    try {
        if (process.platform === 'win32') {
            const result = cp.execSync('where ollama', { timeout: 3000, encoding: 'utf8' });
            return result.trim().length > 0;
        } else {
            const result = cp.execSync('which ollama', { timeout: 3000, encoding: 'utf8' });
            return result.trim().length > 0;
        }
    } catch {
        return false;
    }
}

function startOllama(): void {
    try {
        if (process.platform === 'win32') {
            cp.exec('ollama serve', { windowsHide: true });
        } else {
            cp.exec('ollama serve &', { shell: '/bin/sh' });
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
        const installed = data.models?.some(m => m.name.startsWith(model)) ?? false;
        if (installed) return;

        const choice = await vscode.window.showInformationMessage(
            `Ollama is running but the "${model}" model isn't installed yet. Pull it now?`,
            'Pull model', 'Skip'
        );
        if (choice === 'Pull model') {
            await vscode.window.withProgress(
                { location: vscode.ProgressLocation.Notification, title: `Pulling ${model}...`, cancellable: true },
                async (progress, token) => {
                    await pullModel(url, model, progress, token);
                    vscode.window.showInformationMessage(`Model "${model}" is ready!`);
                }
            );
        }
    } catch { /* non-critical */ }
}

async function pullModel(
    url: string,
    model: string,
    progress: vscode.Progress<{ message?: string }>,
    token: vscode.CancellationToken
): Promise<void> {
    const res = await fetch(`${url}/api/pull`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: model, stream: true })
    });

    if (!res.ok) throw new Error(`Failed to pull model: ${res.statusText}`);

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();

    while (!token.isCancellationRequested) {
        const { done, value } = await reader.read();
        if (done) break;
        for (const line of decoder.decode(value).split('\n').filter(Boolean)) {
            try {
                const data = JSON.parse(line);
                if (data.status) {
                    const pct = data.completed && data.total
                        ? ` (${Math.round(data.completed / data.total * 100)}%)`
                        : '';
                    progress.report({ message: `${data.status}${pct}` });
                }
            } catch { /* skip malformed */ }
        }
    }
}

async function downloadFile(url: string, dest: string, token: vscode.CancellationToken): Promise<void> {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Download failed: ${res.statusText}`);

    const fileStream = fs.createWriteStream(dest);
    const reader = res.body!.getReader();

    while (!token.isCancellationRequested) {
        const { done, value } = await reader.read();
        if (done) break;
        fileStream.write(Buffer.from(value));
    }

    fileStream.end();
    await new Promise<void>((resolve, reject) => {
        fileStream.on('finish', resolve);
        fileStream.on('error', reject);
    });
}

async function pingOllama(url: string): Promise<boolean> {
    try {
        const res = await fetch(`${url}/api/tags`, { signal: AbortSignal.timeout(1500) });
        return res.ok;
    } catch {
        return false;
    }
}
