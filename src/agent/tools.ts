import * as vscode from 'vscode';
import * as path from 'path';
import { GitService } from '../git/service';

export interface ToolCall {
    action: string;
    [key: string]: unknown;
}

export interface ToolResult {
    success: boolean;
    output: string;
}

export const TOOL_SYSTEM_PROMPT = `
You have access to tools to read and modify the codebase. To invoke a tool write a fenced code block with language "tool":

\`\`\`tool
{"action": "action_name", ...params}
\`\`\`

AVAILABLE TOOLS:
- read_file   {"action":"read_file","path":"src/main.ts"}                                        read a file
- list_files  {"action":"list_files","pattern":"**/*.ts"}                                        list files by glob
- search_code {"action":"search_code","query":"myFunc","filePattern":"*.ts"}                     grep across files
- write_file  {"action":"write_file","path":"src/new.ts","content":"..."}                        create / overwrite
- edit_file   {"action":"edit_file","path":"src/x.ts","oldStr":"exact","newStr":"replacement"}   targeted edit
- run_command {"action":"run_command","command":"npm test"}                                       run in terminal
- git_status  {"action":"git_status"}                                                            repo status
- git_push    {"action":"git_push"}                                                              push to remote

GUIDELINES:
- Always read files before editing — never assume their contents
- Use edit_file for targeted changes; write_file only for new files or complete rewrites
- edit_file requires oldStr to match the file exactly (whitespace, indentation and all)
- All paths are relative to the workspace root
- After all changes are done, write a short summary of what you did
`;

export function parseToolCalls(text: string): ToolCall[] {
    const results: ToolCall[] = [];
    const regex = /```tool\s*\n([\s\S]*?)```/g;
    let match;
    while ((match = regex.exec(text)) !== null) {
        try {
            const parsed = JSON.parse(match[1].trim());
            if (typeof parsed.action === 'string') results.push(parsed);
        } catch { /* skip malformed JSON */ }
    }
    return results;
}

export function stripToolBlocks(text: string): string {
    let result = text.replace(/```tool\s*\n[\s\S]*?```/g, '');
    result = result.replace(/```tool[\s\S]*$/, '');
    return result.trim();
}

// ── Workspace tree cache ──────────────────────────────────────────────────────
// One scan per VS Code session; invalidated when files are created/deleted.
let _workspaceTreeCache: string | null = null;
let _cacheWatcher: vscode.FileSystemWatcher | undefined;

export function initWorkspaceTreeCache(context: vscode.ExtensionContext): void {
    // Warm the cache immediately in the background — don't block activation
    getWorkspaceTree();

    // Invalidate cache on file create/delete (not on every save — too noisy)
    _cacheWatcher = vscode.workspace.createFileSystemWatcher('**/*', false, true, false);
    _cacheWatcher.onDidCreate(() => { _workspaceTreeCache = null; });
    _cacheWatcher.onDidDelete(() => { _workspaceTreeCache = null; });
    context.subscriptions.push(_cacheWatcher);
}

export async function getWorkspaceTree(): Promise<string> {
    if (_workspaceTreeCache !== null) return _workspaceTreeCache;
    try {
        const uris = await vscode.workspace.findFiles(
            '**/*',
            '{**/node_modules/**,**/.git/**,**/dist/**,**/out/**,**/build/**}',
            500
        );
        _workspaceTreeCache = uris
            .map(u => vscode.workspace.asRelativePath(u))
            .filter(p => !p.startsWith('.'))
            .sort()
            .join('\n');
        return _workspaceTreeCache;
    } catch {
        return '';
    }
}

export async function executeToolCall(
    tool: ToolCall,
    git: GitService,
    onApprovalNeeded: (id: string, description: string, preview: string) => Promise<boolean>
): Promise<ToolResult> {
    const folders = vscode.workspace.workspaceFolders;
    const root = folders?.[0]?.uri.fsPath;
    if (!root) return { success: false, output: 'No workspace folder open.' };

    switch (tool.action) {

        case 'read_file': {
            if (!tool.path) return { success: false, output: 'Missing path.' };
            try {
                const uri = vscode.Uri.file(path.join(root, tool.path as string));
                const bytes = await vscode.workspace.fs.readFile(uri);
                const content = Buffer.from(bytes).toString('utf8');
                return {
                    success: true,
                    output: content.length > 50000
                        ? content.slice(0, 50000) + '\n\n[... truncated at 50 000 chars ...]'
                        : content
                };
            } catch (err: any) {
                return { success: false, output: `Cannot read ${tool.path}: ${err.message}` };
            }
        }

        case 'list_files': {
            try {
                const pattern = (tool.pattern as string) || '**/*';
                const uris = await vscode.workspace.findFiles(
                    pattern, '{**/node_modules/**,**/.git/**}', 300
                );
                const paths = uris.map(u => vscode.workspace.asRelativePath(u)).sort();
                return { success: true, output: paths.join('\n') || '(no files matched)' };
            } catch (err: any) {
                return { success: false, output: `list_files error: ${err.message}` };
            }
        }

        case 'search_code': {
            if (!tool.query) return { success: false, output: 'Missing query.' };
            try {
                const globPattern = tool.filePattern
                    ? new vscode.RelativePattern(root, tool.filePattern as string)
                    : '**/*';
                const uris = await vscode.workspace.findFiles(
                    globPattern, '{**/node_modules/**,**/.git/**}', 500
                );
                const query = (tool.query as string).toLowerCase();
                const hits: string[] = [];
                for (const uri of uris) {
                    if (hits.length >= 100) break;
                    try {
                        const bytes = await vscode.workspace.fs.readFile(uri);
                        const lines = Buffer.from(bytes).toString('utf8').split('\n');
                        const rel = vscode.workspace.asRelativePath(uri);
                        lines.forEach((line, i) => {
                            if (line.toLowerCase().includes(query))
                                hits.push(`${rel}:${i + 1}: ${line.trimEnd()}`);
                        });
                    } catch { /* skip binary/unreadable */ }
                }
                return { success: true, output: hits.length ? hits.join('\n') : 'No matches found.' };
            } catch (err: any) {
                return { success: false, output: `search_code error: ${err.message}` };
            }
        }

        case 'write_file': {
            if (!tool.path || tool.content === undefined)
                return { success: false, output: 'Missing path or content.' };
            const contentStr = tool.content as string;
            const id = `write-${Date.now()}`;
            const preview = contentStr.length > 600
                ? contentStr.slice(0, 600) + '\n...(truncated)'
                : contentStr;
            const ok = await onApprovalNeeded(id, `Write file: ${tool.path}`, preview);
            if (!ok) return { success: false, output: 'Rejected by user.' };
            try {
                const uri = vscode.Uri.file(path.join(root, tool.path as string));
                await vscode.workspace.fs.writeFile(uri, Buffer.from(contentStr, 'utf8'));
                const doc = await vscode.workspace.openTextDocument(uri);
                await vscode.window.showTextDocument(doc, { preview: true, preserveFocus: true });
                return { success: true, output: `Written: ${tool.path}` };
            } catch (err: any) {
                return { success: false, output: `Write failed: ${err.message}` };
            }
        }

        case 'edit_file': {
            if (!tool.path || !tool.oldStr || tool.newStr === undefined)
                return { success: false, output: 'Missing path, oldStr, or newStr.' };
            const filePath = tool.path as string;
            const oldStr = tool.oldStr as string;
            const newStr = tool.newStr as string;
            try {
                const uri = vscode.Uri.file(path.join(root, filePath));
                const bytes = await vscode.workspace.fs.readFile(uri);
                const original = Buffer.from(bytes).toString('utf8');
                if (!original.includes(oldStr)) {
                    return {
                        success: false,
                        output: `edit_file failed: exact text not found in ${filePath}.\nMake sure oldStr matches exactly — including whitespace and indentation.`
                    };
                }
                const id = `edit-${Date.now()}`;
                const ok = await onApprovalNeeded(
                    id, `Edit: ${filePath}`,
                    `BEFORE:\n${oldStr.slice(0, 400)}\n\nAFTER:\n${newStr.slice(0, 400)}`
                );
                if (!ok) return { success: false, output: 'Rejected by user.' };
                // Use a replacer function so $-signs in newStr are not treated as patterns
                const updated = original.replace(oldStr, () => newStr);
                await vscode.workspace.fs.writeFile(uri, Buffer.from(updated, 'utf8'));
                const doc = await vscode.workspace.openTextDocument(uri);
                await vscode.window.showTextDocument(doc, { preview: true, preserveFocus: true });
                return { success: true, output: `Edited: ${filePath}` };
            } catch (err: any) {
                return { success: false, output: `edit_file error: ${err.message}` };
            }
        }

        case 'run_command': {
            if (!tool.command) return { success: false, output: 'Missing command.' };
            const id = `cmd-${Date.now()}`;
            const ok = await onApprovalNeeded(id, 'Run command', tool.command as string);
            if (!ok) return { success: false, output: 'Rejected by user.' };
            const terminal = vscode.window.activeTerminal ?? vscode.window.createTerminal('OpenPilot');
            terminal.show(true);
            terminal.sendText(tool.command as string);
            return { success: true, output: `Sent to terminal: ${tool.command}` };
        }

        case 'git_status': {
            try {
                return { success: true, output: await git.getStatus() };
            } catch (err: any) {
                return { success: false, output: `git status failed: ${err.message}` };
            }
        }

        case 'git_push': {
            const id = `push-${Date.now()}`;
            const ok = await onApprovalNeeded(id, 'Push to remote', 'git push');
            if (!ok) return { success: false, output: 'Rejected by user.' };
            try {
                await git.push();
                return { success: true, output: 'Pushed successfully.' };
            } catch (err: any) {
                return { success: false, output: `Push failed: ${err.message}` };
            }
        }

        default:
            return { success: false, output: `Unknown action: "${tool.action}"` };
    }
}
