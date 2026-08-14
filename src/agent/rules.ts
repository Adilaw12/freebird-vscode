import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

// Project-level rules file — user-authored conventions, loaded into both
// chat and Agent-mode system prompts. Unlike memory.md (agent-written,
// opportunistic notes — see ./memory.ts), Freebird never writes to or
// deletes this file; it's the user's own standing instructions, so callers
// should surface it to the model ahead of project memory when both are present.
export const RULES_RELATIVE_PATH = '.freebird/rules.md';

const MAX_RULES_CHARS = 6_000;

export function readProjectRules(): string {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) return '';

    const full = path.join(root, RULES_RELATIVE_PATH);
    try {
        const content = fs.readFileSync(full, 'utf8').trim();
        if (!content) return '';
        return content.length > MAX_RULES_CHARS
            ? content.slice(0, MAX_RULES_CHARS) + '\n… (truncated — keep rules.md focused)'
            : content;
    } catch {
        return '';
    }
}
