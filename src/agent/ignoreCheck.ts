import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import ignore, { Ignore } from 'ignore';

// Always active, not user-configurable to disable — a safety net for the
// most common secret/credential file shapes, independent of whatever the
// workspace's own .gitignore does or doesn't cover.
const ALWAYS_EXCLUDE = [
    '.env',
    '.env.*',
    '*.pem',
    '*.key',
    '*.p12',
    '*.pfx',
    'id_rsa',
    'id_rsa.*',
    'id_ecdsa',
    'id_ecdsa.*',
    'id_ed25519',
    'id_ed25519.*',
    '.git/**'
];

function buildIgnoreForWorkspace(workspaceRoot: string): Ignore {
    const ig = ignore().add(ALWAYS_EXCLUDE);
    const config = vscode.workspace.getConfiguration('freebird');

    if (config.get<boolean>('agent.respectGitignore', true)) {
        const gitignorePath = path.join(workspaceRoot, '.gitignore');
        if (fs.existsSync(gitignorePath)) {
            ig.add(fs.readFileSync(gitignorePath, 'utf8'));
        }
    }

    const customName = config.get<string>('agent.ignoreFile', '.freebirdignore');
    if (customName) {
        const customPath = path.join(workspaceRoot, customName);
        if (fs.existsSync(customPath)) {
            ig.add(fs.readFileSync(customPath, 'utf8'));
        }
    }

    return ig;
}

/** relPath is workspace-relative, may use either slash direction. */
export function isPathIgnored(workspaceRoot: string, relPath: string): boolean {
    const normalized = relPath.split(path.sep).join('/').replace(/^\/+/, '');
    if (!normalized) return false;
    return buildIgnoreForWorkspace(workspaceRoot).ignores(normalized);
}

export function ignoreBlockMessage(relPath: string, mode: 'read' | 'write'): string {
    return `Blocked: "${relPath}" is excluded by .gitignore/.freebirdignore (or a built-in sensitive-file pattern) and cannot be ${mode === 'read' ? 'read' : 'written to'} by Freebird.`;
}
