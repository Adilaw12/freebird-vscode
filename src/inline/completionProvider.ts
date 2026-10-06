import * as vscode from 'vscode';
import { getProvider } from '../ai';
import { FIMProvider } from '../ai/provider';
import { getMachineId, trackEvent } from '../telemetry';
import { stripFences } from '../util/text';
import { UPGRADE_URL, XENDIT_CHECKOUT_URL } from '../license/validator';

const MAX_PREFIX_LINES = 100;
const MAX_SUFFIX_LINES = 20;
const MAX_PREFIX_CHARS = 6_000;
const MAX_SUFFIX_CHARS = 1_000;
const DEFAULT_DELAY_MS = 350;

let warnedThisSession = false;

class FreebirdCompletionProvider implements vscode.InlineCompletionItemProvider {
    private pendingTimer: ReturnType<typeof setTimeout> | undefined;
    constructor(private readonly context: vscode.ExtensionContext) {}

    async provideInlineCompletionItems(
        document: vscode.TextDocument,
        position: vscode.Position,
        _context: vscode.InlineCompletionContext,
        token: vscode.CancellationToken
    ): Promise<vscode.InlineCompletionItem[]> {
        const config = vscode.workspace.getConfiguration('freebird');
        if (!config.get<boolean>('tabCompletion.enabled', true)) return [];

        if (document.uri.scheme !== 'file' && document.uri.scheme !== 'untitled') return [];
        if (document.getText().length === 0) return [];

        const editor = vscode.window.activeTextEditor;
        if (editor && !editor.selection.isEmpty) return [];

        const delayMs = config.get<number>('tabCompletion.delay', DEFAULT_DELAY_MS);
        const cancelled = await this.debounce(delayMs, token);
        if (cancelled || token.isCancellationRequested) {
            // Never sent: the user kept typing inside the debounce window. Free,
            // so counted apart from in-flight cancellations (which cost quota).
            trackEvent('tab_completion_cancelled_debounce');
            return [];
        }

        const abort = new AbortController();
        const cancelSub = token.onCancellationRequested(() => abort.abort());

        const { prefix, suffix } = getSurroundingText(document, position);

        let raw: string;
        try {
            const provider = getProvider(this.context, getMachineId());

            // Use FIM endpoint when available (Ollama) — much faster for completions
            if (isFIMProvider(provider)) {
                raw = await provider.fillInMiddle(prefix, suffix, { maxTokens: 128, temperature: 0.2, signal: abort.signal });
            } else {
                const fileName = vscode.workspace.asRelativePath(document.fileName);
                const lang = document.languageId;
                const prompt =
                    `You are a code-completion engine for ${fileName} (${lang}). Given the code ` +
                    `before and after <CURSOR>, output ONLY the text to insert at <CURSOR> — ` +
                    `no explanation, no markdown fences, no repeating surrounding code. If ` +
                    `nothing useful belongs there, output nothing.\n\n` +
                    `${prefix}<CURSOR>${suffix}`;

                raw = await provider.complete(
                    [{ role: 'user', content: prompt }],
                    { maxTokens: 128, temperature: 0.2, isTabCompletion: true, signal: abort.signal }
                );
            }
        } catch (err: any) {
            // Aborted because the user typed past it — not an error, no warning.
            if (token.isCancellationRequested) {
                trackEvent('tab_completion_cancelled');
                return [];
            }
            if (err?.code === 'COMPLETION_QUOTA_EXCEEDED' || err?.code === 'QUOTA_EXCEEDED') {
                // The warning below shows once per session; this counts every
                // completion the quota wall blocked afterwards.
                trackEvent('tab_completion_quota_blocked');
            }
            if (!warnedThisSession) {
                warnedThisSession = true;

                // Tab completions share the same 10/day cloud quota as chat
                // (see backend/api/chat.js), but fire far more often — passively,
                // on nearly every keystroke — so they typically exhaust it long
                // before a user ever sends a deliberate chat message. Previously
                // this showed a raw "QUOTA_EXCEEDED" error with no upgrade path,
                // and never counted toward quota_wall_shown — so the wall was
                // real but invisible for most free users, undercutting the one
                // metric meant to explain trial-conversion behavior. Route it
                // through the same upgrade messaging chat already has.
                // COMPLETION_QUOTA_EXCEEDED: completions' own daily bucket ran out
                // (chat is unaffected). QUOTA_EXCEEDED kept for older backends.
                if (err?.code === 'COMPLETION_QUOTA_EXCEEDED' || err?.code === 'QUOTA_EXCEEDED') {
                    trackEvent('quota_wall_shown', 'completion');
                    vscode.window.showWarningMessage(
                        err.code === 'COMPLETION_QUOTA_EXCEEDED'
                            ? 'Freebird: you\'ve used today\'s free tab completions — chat still works. ' +
                                'Pro makes completions unlimited and adds Agent mode.'
                            : 'Freebird: daily cloud AI limit reached. Tab completions (and other cloud AI features) ' +
                                'resume tomorrow — or upgrade to Pro for unlimited.',
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
                } else {
                    vscode.window.showWarningMessage(
                        `Freebird: tab completion unavailable — ${err?.message ?? String(err)}`,
                        'Configure AI Backend'
                    ).then(choice => {
                        if (choice === 'Configure AI Backend') {
                            vscode.commands.executeCommand('freebird.configure');
                        }
                    });
                }
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
            trackEvent('tab_completion_cancelled');
            return [];
        }

        const text = stripFences(raw).replace(/\s+$/, '');
        if (!text.trim()) {
            trackEvent('tab_completion_empty');
            return [];
        }
        if (suffix.startsWith(text)) {
            trackEvent('tab_completion_redundant');
            return [];
        }

        // This entire feature previously had zero telemetry — a completely
        // silent, ambient capability running for every user on every keystroke
        // pause, with no way to know if anyone was actually getting suggestions
        // from it. "Shown" (a real suggestion was generated) rather than
        // "accepted" — VS Code's provider API doesn't hand back a clean
        // accept/reject signal here, and shown-count is still far more visible
        // than the prior nothing.
        trackEvent('tab_completion_shown');

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
