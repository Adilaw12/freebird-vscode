import * as vscode from 'vscode';
import { getProvider } from '../ai';
import { FIMProvider } from '../ai/provider';
import { getMachineId, trackEvent } from '../telemetry';
import { stripFences } from '../util/text';
import { UPGRADE_URL, XENDIT_CHECKOUT_URL, getCachedLicenseStatus } from '../license/validator';

const MAX_PREFIX_LINES = 100;
const MAX_SUFFIX_LINES = 20;
const MAX_PREFIX_CHARS = 6_000;
const MAX_SUFFIX_CHARS = 1_000;
const DEFAULT_DELAY_MS = 350;
// Free cloud completions are metered: every request the user types past still spends quota, and in practice
// over half of in-flight requests were cancelled that way. Wait a little longer before sending on the cloud
// backend (local Ollama is free, so it keeps the snappy default), and back off further while cancellations
// keep happening. A delay the user set themselves is always honoured as-is.
const CLOUD_DELAY_MS = 500;
const MAX_EXTRA_DELAY_MS = 400;
const BLOCKED_UNTIL_KEY = 'freebird.completionBlockedUntil';
const WALL_DAY_KEY = 'freebird.completionWallDay';
const PAUSED_COMMAND = 'freebird.completionsPaused';

const COMPLETION_SYSTEM_PROMPT =
    'You are a code-completion engine. Reply with ONLY the text to insert at <CURSOR>: no explanation, no markdown fences, ' +
    'never repeat surrounding code. Always give your best short continuation (finish the current line, or write the next ' +
    'line or two). Output nothing only if the file is clearly complete.';

let warnedThisSession = false;
let extraDelayMs = 0;
let lastSkipEventAt = 0;

function nextUtcMidnight(): number {
    const d = new Date();
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
}

function effectiveDelay(config: vscode.WorkspaceConfiguration, backend: string): number {
    const set = config.inspect<number>('tabCompletion.delay');
    const userChoseOne = set?.globalValue !== undefined || set?.workspaceValue !== undefined || set?.workspaceFolderValue !== undefined;
    if (userChoseOne) return config.get<number>('tabCompletion.delay', DEFAULT_DELAY_MS);
    return (backend === 'cloud' ? CLOUD_DELAY_MS : DEFAULT_DELAY_MS) + extraDelayMs;
}

/** The free-completions wall as a message the user can act on, with the real reset time. */
function showCompletionWall(resetAt: number): void {
    const resetTime = new Date(resetAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    vscode.window.showWarningMessage(
        `Freebird: you've used today's free tab completions — they come back at ${resetTime}. Chat still works. ` +
            'Pro makes completions unlimited and adds Agent mode.',
        'Upgrade to Pro',
        'Pay with Local Methods (VN/ID)',
        'Use a local model'
    ).then(choice => {
        if (choice === 'Upgrade to Pro') {
            trackEvent('upgrade_clicked', 'completion');
            vscode.env.openExternal(vscode.Uri.parse(UPGRADE_URL));
        } else if (choice === 'Pay with Local Methods (VN/ID)') {
            trackEvent('upgrade_clicked_local', 'completion');
            vscode.env.openExternal(vscode.Uri.parse(XENDIT_CHECKOUT_URL));
        } else if (choice === 'Use a local model') {
            vscode.commands.executeCommand('freebird.configure');
        }
    });
}

class FreebirdCompletionProvider implements vscode.InlineCompletionItemProvider {
    private pendingTimer: ReturnType<typeof setTimeout> | undefined;
    private readonly pausedItem: vscode.StatusBarItem;
    private resumeTimer: ReturnType<typeof setTimeout> | undefined;

    constructor(private readonly context: vscode.ExtensionContext) {
        // Persistent, clickable notice while free completions are used up — the one-off toast was easy to miss,
        // and after it nothing explained why suggestions had stopped.
        this.pausedItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
        this.pausedItem.command = PAUSED_COMMAND;
        context.subscriptions.push(
            this.pausedItem,
            { dispose: () => { if (this.resumeTimer) clearTimeout(this.resumeTimer); } },
            vscode.commands.registerCommand(PAUSED_COMMAND, () => {
                const until = this.context.globalState.get<number>(BLOCKED_UNTIL_KEY, 0);
                trackEvent('completions_paused_clicked');
                showCompletionWall(until || nextUtcMidnight());
            })
        );
        this.refreshPausedItem();
    }

    /** True while the free daily completion allowance is used up (cloud backend only; Pro is never blocked). */
    private isQuotaBlocked(): boolean {
        const until = this.context.globalState.get<number>(BLOCKED_UNTIL_KEY, 0);
        if (!until) return false;
        if (Date.now() >= until || getCachedLicenseStatus().isPro) {
            void this.context.globalState.update(BLOCKED_UNTIL_KEY, undefined);
            this.refreshPausedItem();
            return false;
        }
        return true;
    }

    private refreshPausedItem(): void {
        const until = this.context.globalState.get<number>(BLOCKED_UNTIL_KEY, 0);
        if (this.resumeTimer) { clearTimeout(this.resumeTimer); this.resumeTimer = undefined; }
        if (!until || Date.now() >= until) { this.pausedItem.hide(); return; }
        const resetTime = new Date(until).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
        this.pausedItem.text = '$(circle-slash) Completions paused';
        this.pausedItem.tooltip = `Freebird: today's free tab completions are used up. They return at ${resetTime}. Click for options (Pro is unlimited).`;
        this.pausedItem.show();
        this.resumeTimer = setTimeout(() => this.refreshPausedItem(), Math.min(until - Date.now() + 1000, 2_147_000_000));
    }

    private blockUntilReset(): number {
        const until = nextUtcMidnight();
        void this.context.globalState.update(BLOCKED_UNTIL_KEY, until);
        this.refreshPausedItem();
        return until;
    }

    async provideInlineCompletionItems(
        document: vscode.TextDocument,
        position: vscode.Position,
        _context: vscode.InlineCompletionContext,
        token: vscode.CancellationToken
    ): Promise<vscode.InlineCompletionItem[]> {
        const config = vscode.workspace.getConfiguration('freebird');
        const backend = config.get<string>('backend', 'cloud');
        if (!config.get<boolean>('tabCompletion.enabled', true)) return [];

        if (document.uri.scheme !== 'file' && document.uri.scheme !== 'untitled') return [];
        if (document.getText().length === 0) return [];

        const editor = vscode.window.activeTextEditor;
        if (editor && !editor.selection.isEmpty) return [];

        // Out of free completions: don't send a request the server will only refuse. (Before this, every pause in
        // typing sent one — 662 refused requests in a day against 6 times the wall was actually shown.)
        if (backend === 'cloud' && this.isQuotaBlocked()) {
            if (Date.now() - lastSkipEventAt > 10 * 60 * 1000) {
                lastSkipEventAt = Date.now();
                trackEvent('tab_completion_skipped_quota', backend);
            }
            return [];
        }

        const delayMs = effectiveDelay(config, backend);
        const cancelled = await this.debounce(delayMs, token);
        if (cancelled || token.isCancellationRequested) {
            // Never sent: the user kept typing inside the debounce window. Free,
            // so counted apart from in-flight cancellations (which cost quota).
            trackEvent('tab_completion_cancelled_debounce', backend);
            return [];
        }

        const abort = new AbortController();
        const cancelSub = token.onCancellationRequested(() => abort.abort());

        const { prefix, suffix } = getSurroundingText(document, position);

        const fileName = vscode.workspace.asRelativePath(document.fileName);
        const lang = document.languageId;
        const completionParts = {
            system: COMPLETION_SYSTEM_PROMPT,
            user: `File: ${fileName} (${lang})\n\n${prefix}<CURSOR>${suffix}`
        };
        // The original single-message prompt stays for Ollama and bring-your-own-key providers: the system-message
        // version was measured on Freebird Cloud only.
        const prompt =
            `You are a code-completion engine for ${fileName} (${lang}). Given the code ` +
            `before and after <CURSOR>, output ONLY the text to insert at <CURSOR> — ` +
            `no explanation, no markdown fences, no repeating surrounding code. If ` +
            `nothing useful belongs there, output nothing.\n\n` +
            `${prefix}<CURSOR>${suffix}`;

        let raw: string;
        try {
            const provider = getProvider(this.context, getMachineId());

            // Use FIM endpoint when available (Ollama, incl. via the cloud-fallback
            // wrapper) — much faster for completions. fallbackPrompt is what the
            // cloud provider gets if Ollama is down.
            if (isFIMProvider(provider)) {
                raw = await provider.fillInMiddle(prefix, suffix, {
                    maxTokens: 128, temperature: 0.2, signal: abort.signal, fallbackPrompt: prompt, completionParts
                });
            } else {
                raw = await provider.complete(
                    [{ role: 'user', content: prompt }],
                    { maxTokens: 128, temperature: 0.2, isTabCompletion: true, signal: abort.signal, completionParts }
                );
            }
        } catch (err: any) {
            // Aborted because the user typed past it — not an error, no warning.
            if (token.isCancellationRequested) {
                trackEvent('tab_completion_cancelled', backend);
                extraDelayMs = Math.min(MAX_EXTRA_DELAY_MS, extraDelayMs + 50);
                return [];
            }
            const quotaHit = err?.code === 'COMPLETION_QUOTA_EXCEEDED' || err?.code === 'QUOTA_EXCEEDED';
            if (quotaHit) {
                trackEvent('tab_completion_quota_blocked', backend);
                // Stop asking until the allowance resets, and say so in the status bar. The message itself shows
                // once per day (not once per window), so someone who reopens VS Code still hears about it.
                const resetAt = this.blockUntilReset();
                const today = new Date().toISOString().slice(0, 10);
                if (this.context.globalState.get<string>(WALL_DAY_KEY) !== today) {
                    await this.context.globalState.update(WALL_DAY_KEY, today);
                    trackEvent('quota_wall_shown', 'completion');
                    showCompletionWall(resetAt);
                }
                return [];
            }
            if (!warnedThisSession) {
                warnedThisSession = true;

                    vscode.window.showWarningMessage(
                        `Freebird: tab completion unavailable — ${err?.message ?? String(err)}`,
                        'Configure AI Backend'
                    ).then(choice => {
                        if (choice === 'Configure AI Backend') {
                            vscode.commands.executeCommand('freebird.configure');
                        }
                    });
            }
            return [];
        } finally {
            cancelSub.dispose();
        }

        // Distinguishes WHY a completion never reaches the user — previously
        // all three outcomes below looked identical from telemetry alone
        // (no event fired either way), which made a high model_used-vs-
        // tab_completion_shown gap impossible to diagnose: was the backend
        // returning empty/redundant text, or was the result just arriving
        // after the user had already typed past it and VS Code cancelled?
        // Those have very different fixes (a bad maxTokens/reasoning_effort
        // tuning vs. nothing actually wrong), so they need separate counts.
        // (Normally an in-flight cancellation aborts the request and lands in the
        // catch above; this covers a response that finished as it was cancelled.)
        if (token.isCancellationRequested) {
            trackEvent('tab_completion_cancelled', backend);
            extraDelayMs = Math.min(MAX_EXTRA_DELAY_MS, extraDelayMs + 50);
            return [];
        }

        const text = stripFences(raw).replace(/\s+$/, '');
        if (!text.trim()) {
            trackEvent('tab_completion_empty', backend);
            return [];
        }
        if (suffix.startsWith(text)) {
            trackEvent('tab_completion_redundant', backend);
            return [];
        }

        // This entire feature previously had zero telemetry — a completely
        // silent, ambient capability running for every user on every keystroke
        // pause, with no way to know if anyone was actually getting suggestions
        // from it. "Shown" (a real suggestion was generated) rather than
        // "accepted" — VS Code's provider API doesn't hand back a clean
        // accept/reject signal here, and shown-count is still far more visible
        // than the prior nothing.
        trackEvent('tab_completion_shown', backend);
        extraDelayMs = Math.max(0, extraDelayMs - 25);

        return [new vscode.InlineCompletionItem(text, new vscode.Range(position, position))];
    }

    private debounce(delayMs: number, token: vscode.CancellationToken): Promise<boolean> {
        if (this.pendingTimer) clearTimeout(this.pendingTimer);

        return new Promise<boolean>(resolve => {
            this.pendingTimer = setTimeout(() => resolve(false), delayMs);
            token.onCancellationRequested(() => {
                if (this.pendingTimer) clearTimeout(this.pendingTimer);
                resolve(true);
            });
        });
    }
}

function isFIMProvider(provider: unknown): provider is FIMProvider {
    return typeof (provider as FIMProvider).fillInMiddle === 'function';
}

function getSurroundingText(document: vscode.TextDocument, position: vscode.Position): { prefix: string; suffix: string } {
    const prefixStartLine = Math.max(0, position.line - MAX_PREFIX_LINES);
    const prefixStart = new vscode.Position(prefixStartLine, 0);
    let prefix = document.getText(new vscode.Range(prefixStart, position));
    if (prefix.length > MAX_PREFIX_CHARS) prefix = prefix.slice(-MAX_PREFIX_CHARS);

    const suffixEndLine = Math.min(document.lineCount - 1, position.line + MAX_SUFFIX_LINES);
    const suffixEnd = new vscode.Position(suffixEndLine, document.lineAt(suffixEndLine).text.length);
    let suffix = document.getText(new vscode.Range(position, suffixEnd));
    if (suffix.length > MAX_SUFFIX_CHARS) suffix = suffix.slice(0, MAX_SUFFIX_CHARS);

    return { prefix, suffix };
}

export function registerTabCompletion(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
        vscode.languages.registerInlineCompletionItemProvider(
            { pattern: '**' },
            new FreebirdCompletionProvider(context)
        )
    );
}
