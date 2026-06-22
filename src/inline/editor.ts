import * as vscode from 'vscode';
import { getProvider } from '../ai';
import { getLicenseStatus, UPGRADE_URL } from '../license/validator';
import { getSessionId } from '../telemetry';
import { stripFences } from '../util/text';

let _extensionContext: vscode.ExtensionContext;

export function registerInlineEdit(context: vscode.ExtensionContext) {
    _extensionContext = context;
    context.subscriptions.push(
        vscode.commands.registerCommand('freebird._inlineEditInternal', inlineEdit)
    );
}

async function inlineEdit() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;

    const selection    = editor.selection;
    const selectedText = editor.document.getText(selection);

    if (!selectedText.trim()) {
        vscode.window.showWarningMessage('Select some code first, then use Freebird: Edit with AI.');
        return;
    }

    const lang     = editor.document.languageId;
    const fileName = vscode.workspace.asRelativePath(editor.document.fileName);

    // Also grab a few lines of surrounding context so the AI understands scope
    const surroundStart = Math.max(0, selection.start.line - 10);
    const surroundEnd   = Math.min(editor.document.lineCount - 1, selection.end.line + 10);
    const beforeRange   = new vscode.Range(surroundStart, 0, selection.start.line, 0);
    const afterRange    = new vscode.Range(selection.end.line + 1, 0, surroundEnd, editor.document.lineAt(surroundEnd).text.length);
    const beforeContext = editor.document.getText(beforeRange);
    const afterContext  = editor.document.getText(afterRange);

    const instruction = await vscode.window.showInputBox({
        prompt: 'What should Freebird do with this code?',
        placeHolder: 'e.g. "add error handling", "convert to async/await", "add TypeScript types"',
        title: 'Freebird: Inline Edit'
    });
    if (!instruction) return;

    const provider = getProvider(_extensionContext, getSessionId());

    await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Freebird: Rewriting…', cancellable: true },
        async (_progress, token) => {
            const prompt = `You are editing code in \`${fileName}\` (${lang}).

Surrounding context (for reference only — do not include in output):
\`\`\`${lang}
${beforeContext}// <-- EDIT STARTS HERE
${afterContext}
\`\`\`

Code to edit:
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
                vscode.window.showErrorMessage(`Freebird: ${err.message}`);
                return;
            }

            if (token.isCancellationRequested || !result.trim()) return;

            result = stripFences(result);

            await editor.edit(builder => builder.replace(selection, result));

            vscode.window.showInformationMessage(
                `Freebird applied: "${instruction}"`, 'Undo', 'Open Chat'
            ).then(choice => {
                if (choice === 'Undo') vscode.commands.executeCommand('undo');
                if (choice === 'Open Chat') vscode.commands.executeCommand('freebird.openChat');
            });
        }
    );
}
