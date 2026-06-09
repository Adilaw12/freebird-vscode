import * as vscode from 'vscode';
import { getProvider } from '../ai';

export function registerInlineEdit(context: vscode.ExtensionContext) {
    context.subscriptions.push(
        vscode.commands.registerCommand('openpilot.inlineEdit', inlineEdit)
    );
}

async function inlineEdit() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;

    const selection = editor.selection;
    const selectedText = editor.document.getText(selection);

    if (!selectedText.trim()) {
        vscode.window.showWarningMessage('Select some code first, then press Ctrl+Alt+K to edit it with AI.');
        return;
    }

    const lang = editor.document.languageId;
    const fileName = vscode.workspace.asRelativePath(editor.document.fileName);

    const instruction = await vscode.window.showInputBox({
        prompt: 'What should OpenPilot do with this code?',
        placeHolder: 'e.g. "add error handling", "convert to async/await", "add TypeScript types"',
        title: 'OpenPilot: Inline Edit'
    });

    if (!instruction) return;

    const provider = getProvider();

    await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'OpenPilot: Rewriting…', cancellable: true },
        async (_progress, token) => {
            const prompt = `You are editing code in \`${fileName}\` (${lang}).

Original code:
\`\`\`${lang}
${selectedText}
\`\`\`

Instruction: ${instruction}

Return ONLY the rewritten code — no explanation, no markdown fences, no preamble. Raw code only.`;

            let result = '';

            try {
                await provider.stream([{ role: 'user', content: prompt }], chunk => {
                    if (!token.isCancellationRequested) result += chunk;
                });
            } catch (err: any) {
                vscode.window.showErrorMessage(`OpenPilot: ${err.message}`);
                return;
            }

            if (token.isCancellationRequested || !result.trim()) return;

            result = stripFences(result);

            await editor.edit(builder => builder.replace(selection, result));

            vscode.window.showInformationMessage(`OpenPilot applied: "${instruction}"`, 'Undo').then(choice => {
                if (choice === 'Undo') vscode.commands.executeCommand('undo');
            });
        }
    );
}

function stripFences(text: string): string {
    const match = text.trim().match(/^```[\w]*\n?([\s\S]*?)\n?```$/);
    return match ? match[1] : text;
}
