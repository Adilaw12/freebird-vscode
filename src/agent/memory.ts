import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

// Project-level memory file — persisted notes the agent can read/write across sessions.
export const MEMORY_RELATIVE_PATH = '.freebird/memory.md';

const MAX_MEMORY_CHARS = 4_000;

export function readProjectMemory(): string {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) return '';

    const full = path.join(root, MEMORY_RELATIVE_PATH);
    try {
        const content = fs.readFileSync(full, 'utf8').trim();
        if (!content) return '';
        return content.length > MAX_MEMORY_CHARS
            ? content.slice(0, MAX_MEMORY_CHARS) + '\n… (truncated)'
            : content;
    } catch {
        return '';
    }
}

export function clearProjectMemory(): boolean {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) return false;

    const full = path.join(root, MEMORY_RELATIVE_PATH);
    try {
        fs.unlinkSync(full);
        return true;
    } catch {
        return false;
    }
}

/**
 * Appends one durable note to the memory file without any approval step, so the agent
 * can remember things as they come up instead of waiting to be asked. Skips exact
 * duplicates, and when the file outgrows what is loaded into context it drops the
 * OLDEST notes first (readProjectMemory only loads the head of the file, so unchecked
 * growth would silently hide the newest notes).
 */
export function appendProjectMemory(note: string): { ok: boolean; message: string } {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) return { ok: false, message: 'No workspace folder is open, so there is nowhere to save memory.' };

    const clean = note.replace(/\s+/g, ' ').trim().replace(/^[-*]\s*/, '');
    if (!clean) return { ok: false, message: 'remember requires a non-empty "note".' };

    const full = path.join(root, MEMORY_RELATIVE_PATH);
    let lines: string[] = [];
    try {
        lines = fs.readFileSync(full, 'utf8').split('\n').map(l => l.trimEnd()).filter(l => l.trim());
    } catch { /* first note */ }

    const bullet = `- ${clean}`;
    if (lines.some(l => l.toLowerCase() === bullet.toLowerCase())) {
        return { ok: true, message: 'Already in memory.' };
    }
    lines.push(bullet);

    const limit = MAX_MEMORY_CHARS - 200;
    let dropped = 0;
    while (lines.join('\n').length > limit && lines.length > 1) {
        const i = lines.findIndex(l => l.startsWith('- '));
        if (i < 0 || i === lines.length - 1) break;
        lines.splice(i, 1);
        dropped++;
    }

    try {
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, lines.join('\n') + '\n', 'utf8');
    } catch (err: any) {
        return { ok: false, message: `Could not save memory: ${err?.message ?? String(err)}` };
    }
    return { ok: true, message: `Saved to ${MEMORY_RELATIVE_PATH}${dropped ? ` (dropped ${dropped} oldest note${dropped === 1 ? '' : 's'} to stay within the size limit)` : ''}.` };
}
