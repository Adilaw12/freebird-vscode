import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { exec, ExecException } from 'child_process';
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
- When the user asks you to build, create, make, scaffold, or set up something (e.g. "make a website", "create a script that..."), use write_file to create the actual files in their workspace — don't just print example code in chat. Only show inline snippets when they ask for an explanation, example, or something not meant to be saved.
- To remember things across sessions (project conventions, architecture decisions, user preferences, in-progress work), write short bullet notes to .freebird/memory.md using write_file or edit_file. It's automatically loaded into your context next time — keep it concise and up to date, don't let it grow unbounded.
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

// ── Tool execution ─────────────────────────────────────────────────────────

const EXCLUDE_GLOB = '{**/node_modules/**,**/.git/**,**/dist/**,**/out/**,**/build/**}';
const MAX_READ_CHARS = 50_000;
const MAX_SEARCH_MATCHES = 200;
const MAX_TOOL_OUTPUT_CHARS = 4_000;
const COMMAND_TIMEOUT_MS = 60_000;

export type ApprovalFn = (id: string, description: string, preview: string) => Promise<boolean>;

function approvalId(action: string): string {
    return `${action}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function truncate(text: string, max: number): string {
    return text.length > max ? `${text.slice(0, max)}\n… (truncated)` : text;
}

function getWorkspaceRoot(): string {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) throw new Error('No workspace folder is open.');
    return root;
}

// Resolves a workspace-relative path and rejects attempts to escape the workspace root
function resolveWorkspacePath(relPath: string): string {
    const root = path.resolve(getWorkspaceRoot());
    const full = path.resolve(root, relPath);
    if (full !== root && !full.startsWith(root + path.sep)) {
        throw new Error(`Path "${relPath}" is outside the workspace.`);
    }
    return full;
}

export async function executeToolCall(
    tool: ToolCall,
    git: GitService,
    onApprovalNeeded: ApprovalFn
): Promise<ToolResult> {
    try {
        switch (tool.action) {
            case 'read_file':   return await readFileTool(tool);
            case 'list_files':  return await listFilesTool(tool);
            case 'search_code': return await searchCodeTool(tool);
            case 'write_file':  return await writeFileTool(tool, onApprovalNeeded);
            case 'edit_file':   return await editFileTool(tool, onApprovalNeeded);
            case 'run_command': return await runCommandTool(tool, onApprovalNeeded);
            case 'git_status':  return { success: true, output: await git.getStatus() };
            case 'git_push':    return await gitPushTool(git, onApprovalNeeded);
            default:
                return { success: false, output: `Unknown tool action: "${tool.action}"` };
        }
    } catch (err: any) {
        return { success: false, output: err?.message ?? String(err) };
    }
}

async function readFileTool(tool: ToolCall): Promise<ToolResult> {
    const relPath = String(tool.path ?? '');
    if (!relPath) return { success: false, output: 'read_file requires "path".' };

    const full = resolveWorkspacePath(relPath);
    const content = fs.readFileSync(full, 'utf8');
    return { success: true, output: truncate(content, MAX_READ_CHARS) };
}

async function listFilesTool(tool: ToolCall): Promise<ToolResult> {
    const pattern = String(tool.pattern ?? '**/*');
    const uris = await vscode.workspace.findFiles(pattern, EXCLUDE_GLOB, 500);
    const files = uris.map(u => vscode.workspace.asRelativePath(u)).sort();
    return { success: true, output: files.length ? files.join('\n') : 'No files matched.' };
}

async function searchCodeTool(tool: ToolCall): Promise<ToolResult> {
    const query = String(tool.query ?? '');
    if (!query) return { success: false, output: 'search_code requires "query".' };

    const filePattern = String(tool.filePattern ?? '**/*');
    const uris = await vscode.workspace.findFiles(filePattern, EXCLUDE_GLOB, 1000);

    const matches: string[] = [];
    for (const uri of uris) {
        if (matches.length >= MAX_SEARCH_MATCHES) break;

        let text: string;
        try {
            text = fs.readFileSync(uri.fsPath, 'utf8');
        } catch {
            continue; // unreadable or binary
        }
        if (text.includes('\0')) continue; // skip binary files

        const rel = vscode.workspace.asRelativePath(uri);
        const lines = text.split('\n');
        for (let i = 0; i < lines.length && matches.length < MAX_SEARCH_MATCHES; i++) {
            if (lines[i].includes(query)) {
                matches.push(`${rel}:${i + 1}: ${lines[i].trim()}`);
            }
        }
    }

    return { success: true, output: matches.length ? matches.join('\n') : 'No matches found.' };
}

async function writeFileTool(tool: ToolCall, onApprovalNeeded: ApprovalFn): Promise<ToolResult> {
    const relPath = String(tool.path ?? '');
    const content = String(tool.content ?? '');
    if (!relPath) return { success: false, output: 'write_file requires "path".' };

    const full = resolveWorkspacePath(relPath);
    const exists = fs.existsSync(full);

    const approved = await onApprovalNeeded(
        approvalId('write_file'),
        `${exists ? 'Overwrite' : 'Create'} ${relPath}`,
        truncate(content, 2000)
    );
    if (!approved) return { success: false, output: 'User rejected this change.' };

    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, 'utf8');
    return { success: true, output: `Wrote ${relPath} (${content.length} bytes).` };
}

async function editFileTool(tool: ToolCall, onApprovalNeeded: ApprovalFn): Promise<ToolResult> {
    const relPath = String(tool.path ?? '');
    const oldStr  = String(tool.oldStr ?? '');
    const newStr  = String(tool.newStr ?? '');
    if (!relPath || !oldStr) return { success: false, output: 'edit_file requires "path" and "oldStr".' };

    const full = resolveWorkspacePath(relPath);
    const content = fs.readFileSync(full, 'utf8');
    const idx = content.indexOf(oldStr);
    if (idx === -1) {
        return { success: false, output: `oldStr not found in ${relPath}. Read the file first and copy the text to match exactly.` };
    }

    const updated = content.slice(0, idx) + newStr + content.slice(idx + oldStr.length);

    const approved = await onApprovalNeeded(
        approvalId('edit_file'),
        `Edit ${relPath}`,
        truncate(`- ${oldStr}\n+ ${newStr}`, 2000)
    );
    if (!approved) return { success: false, output: 'User rejected this change.' };

    fs.writeFileSync(full, updated, 'utf8');
    return { success: true, output: `Edited ${relPath}.` };
}

async function runCommandTool(tool: ToolCall, onApprovalNeeded: ApprovalFn): Promise<ToolResult> {
    const command = String(tool.command ?? '');
    if (!command) return { success: false, output: 'run_command requires "command".' };

    const approved = await onApprovalNeeded(approvalId('run_command'), 'Run command', command);
    if (!approved) return { success: false, output: 'User rejected running this command.' };

    const root = getWorkspaceRoot();
    return new Promise<ToolResult>(resolve => {
        exec(command, { cwd: root, timeout: COMMAND_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
            (err: ExecException | null, stdout: string, stderr: string) => {
                const combined = truncate(`${stdout}${stderr}`.trim() || '(no output)', MAX_TOOL_OUTPUT_CHARS);
                if (err) {
                    resolve({ success: false, output: `${combined}\n\n[exit code ${err.code ?? 'unknown'}]` });
                } else {
                    resolve({ success: true, output: combined });
                }
            });
    });
}

async function gitPushTool(git: GitService, onApprovalNeeded: ApprovalFn): Promise<ToolResult> {
    const approved = await onApprovalNeeded(approvalId('git_push'), 'Push to remote', 'git push');
    if (!approved) return { success: false, output: 'User rejected the push.' };

    await git.push();
    return { success: true, output: 'Pushed to remote.' };
}
