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
