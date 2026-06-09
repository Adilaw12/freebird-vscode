import * as vscode from 'vscode';

const MAX_FILE_CHARS = 8000;
const CONTEXT_LINES = 60;

export function buildFileContext(): string {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return '';

    const doc = editor.document;
    const selection = editor.selection;
    const lang = doc.languageId;
    const fileName = vscode.workspace.asRelativePath(doc.fileName);
    let context = `**File:** \`${fileName}\` (${lang})\n\n`;

    if (!selection.isEmpty) {
        const selected = doc.getText(selection);
        context += `**Selected code** (lines ${selection.start.line + 1}–${selection.end.line + 1}):\n\`\`\`${lang}\n${selected}\n\`\`\`\n`;
        return context;
    }

    const full = doc.getText();
    if (full.length <= MAX_FILE_CHARS) {
        context += `\`\`\`${lang}\n${full}\n\`\`\`\n`;
    } else {
        const cursor = selection.active.line;
        const start = Math.max(0, cursor - CONTEXT_LINES);
        const end = Math.min(doc.lineCount - 1, cursor + CONTEXT_LINES);
        const range = new vscode.Range(start, 0, end, doc.lineAt(end).text.length);
        context += `**Excerpt** (lines ${start + 1}–${end + 1} of ${doc.lineCount}):\n\`\`\`${lang}\n${doc.getText(range)}\n\`\`\`\n`;
    }

    return context;
}
