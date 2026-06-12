import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

const MAX_FILE_CHARS   = 8_000;
const CONTEXT_LINES    = 60;
const MAX_MENTION_CHARS = 12_000; // total budget for all @-mentioned files

// ── Active-file context (used for both free and pro first message) ────────────

export function buildFileContext(): string {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return '';

    const doc      = editor.document;
    const selection = editor.selection;
    const lang     = doc.languageId;
    const fileName = vscode.workspace.asRelativePath(doc.fileName);
    let context    = `**Active file:** \`${fileName}\` (${lang})\n\n`;

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
        const start  = Math.max(0, cursor - CONTEXT_LINES);
        const end    = Math.min(doc.lineCount - 1, cursor + CONTEXT_LINES);
        const range  = new vscode.Range(start, 0, end, doc.lineAt(end).text.length);
        context += `**Excerpt** (lines ${start + 1}–${end + 1} of ${doc.lineCount}):\n\`\`\`${lang}\n${doc.getText(range)}\n\`\`\`\n`;
    }

    return context;
}

// ── @ mention resolution ──────────────────────────────────────────────────────
// Parses "@filename" tokens from user message and injects file contents.
// Returns { cleanText, mentionContext } where cleanText has @tokens removed.

export interface MentionResult {
    cleanText: string;
    mentionContext: string;
}

export async function resolveMentions(text: string): Promise<MentionResult> {
    const mentionRe = /@([\w./\\-]+)/g;
    const matches   = [...text.matchAll(mentionRe)];
    if (matches.length === 0) return { cleanText: text, mentionContext: '' };

    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceRoot) return { cleanText: text, mentionContext: '' };

    let mentionContext  = '';
    let totalChars      = 0;
    const resolved: string[] = [];

    for (const match of matches) {
        const mention  = match[1];
        const fullPath = path.isAbsolute(mention)
            ? mention
            : path.join(workspaceRoot, mention);

        try {
            const stat = fs.statSync(fullPath);
            if (!stat.isFile()) continue;

            const content = fs.readFileSync(fullPath, 'utf8');
            const ext     = path.extname(fullPath).slice(1) || 'text';
            const rel     = vscode.workspace.asRelativePath(fullPath);
            const budget  = Math.min(MAX_FILE_CHARS, MAX_MENTION_CHARS - totalChars);

            if (budget <= 0) break;

            const truncated = content.length > budget
                ? content.slice(0, budget) + '\n… (truncated)'
                : content;

            mentionContext += `**@${rel}:**\n\`\`\`${ext}\n${truncated}\n\`\`\`\n\n`;
            totalChars     += truncated.length;
            resolved.push(match[0]);
        } catch {
            // File not found — leave the @mention in the text so AI can see it
        }
    }

    // Remove resolved @mentions from the user-facing text to keep it clean
    let cleanText = text;
    for (const r of resolved) cleanText = cleanText.replace(r, '').trim();

    return { cleanText, mentionContext };
}

// ── Workspace file list (for autocomplete suggestions) ────────────────────────

export async function listWorkspaceFiles(maxFiles = 200): Promise<string[]> {
    const uris = await vscode.workspace.findFiles(
        '**/*.{ts,js,tsx,jsx,py,go,rs,java,cs,cpp,c,h,json,md,yaml,yml,toml,env}',
        '{**/node_modules/**,**/.git/**,**/dist/**,**/build/**,**/__pycache__/**}',
        maxFiles
    );
    return uris.map(u => vscode.workspace.asRelativePath(u));
}
