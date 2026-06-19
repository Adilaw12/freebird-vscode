import * as vscode from 'vscode';
import { getProvider } from '../ai';
import { FIMProvider } from '../ai/provider';
import { stripFences } from '../util/text';

const MAX_PREFIX_LINES = 100;
const MAX_SUFFIX_LINES = 20;
const MAX_PREFIX_CHARS = 6_000;
const MAX_SUFFIX_CHARS = 1_000;
const DEFAULT_DELAY_MS = 350;

let warnedThisSession = false;

class FreebirdCompletionProvider implements vscode.InlineCompletionItemProvider {
    private pendingTimer: ReturnType<typeof setTimeout> | undefined;

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
        if (cancelled || token.isCancellationRequested) return [];

        const { prefix, suffix } = getSurroundingText(document, position);

        let raw: string;
        try {
            const provider = getProvider();

            // Use FIM endpoint when available (Ollama) — much faster for completions
            if (isFIMProvider(provider)) {
                raw = await provider.fillInMiddle(prefix, suffix, { maxTokens: 128, temperature: 0.2 });
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
                    { maxTokens: 128, temperature: 0.2 }
                );
            }
        } catch (err: any) {
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
        }

        if (token.isCancellationRequested) return [];

        const text = stripFences(raw).replace(/\s+$/, '');
        if (!text.trim()) return [];
        if (suffix.startsWith(text)) return [];

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
            new FreebirdCompletionProvider()
        )
    );
}
