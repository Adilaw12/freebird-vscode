import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as https from 'https';
import * as http from 'http';
import { exec, ExecException } from 'child_process';
import { GitService } from '../git/service';
import { previewHtmlFile } from './preview';
import { ToolSchema } from '../ai/provider';

export interface ToolCall {
    action: string;
    [key: string]: unknown;
}

export interface ToolResult {
    success: boolean;
    output: string;
}

// ── Native tool schemas (for Anthropic/OpenAI/DeepSeek/Qwen) ─────────────────

export const NATIVE_TOOL_SCHEMAS: ToolSchema[] = [
    {
        name: 'read_file',
        description: 'Read the contents of a file in the workspace.',
        input_schema: {
            type: 'object',
            properties: { path: { type: 'string', description: 'Workspace-relative file path' } },
            required: ['path']
        }
    },
    {
        name: 'list_files',
        description: 'List files in the workspace matching a glob pattern.',
        input_schema: {
            type: 'object',
            properties: { pattern: { type: 'string', description: 'Glob pattern (default: **/*)', default: '**/*' } }
        }
    },
    {
        name: 'search_code',
        description: 'Search for a regex pattern across workspace files. Returns matching lines with file paths and line numbers.',
        input_schema: {
            type: 'object',
            properties: {
                query: { type: 'string', description: 'Regex pattern to search for' },
                filePattern: { type: 'string', description: 'Glob to filter files (default: **/*)', default: '**/*' }
            },
            required: ['query']
        }
    },
    {
        name: 'write_file',
        description: 'Create a new file or overwrite an existing file. Requires user approval.',
        input_schema: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'Workspace-relative file path' },
                content: { type: 'string', description: 'Full file content to write' }
            },
            required: ['path', 'content']
        }
    },
    {
        name: 'edit_file',
        description: 'Make a targeted edit to an existing file by replacing a specific string. Requires user approval. Shows a diff view.',
        input_schema: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'Workspace-relative file path' },
                oldStr: { type: 'string', description: 'Exact text to find and replace' },
                newStr: { type: 'string', description: 'Replacement text' }
            },
            required: ['path', 'oldStr', 'newStr']
        }
    },
    {
        name: 'preview_html',
        description: 'Open a live preview of an HTML file in a VS Code tab.',
        input_schema: {
            type: 'object',
            properties: { path: { type: 'string', description: 'Workspace-relative path to HTML file' } },
            required: ['path']
        }
    },
    {
        name: 'run_command',
        description: 'Run a shell command in the workspace root. Requires user approval.',
        input_schema: {
            type: 'object',
            properties: { command: { type: 'string', description: 'Shell command to execute' } },
            required: ['command']
        }
    },
    {
        name: 'git_status',
        description: 'Show the current git repository status (branch, staged, unstaged counts).',
        input_schema: { type: 'object', properties: {} }
    },
    {
        name: 'git_push',
        description: 'Push the current branch to the remote. Requires user approval.',
        input_schema: { type: 'object', properties: {} }
    },
    {
        name: 'download_file',
        description: 'Download a file from a URL and save it to the workspace. Requires user approval.',
        input_schema: {
            type: 'object',
            properties: {
                url: { type: 'string', description: 'URL to download from (http/https)' },
                path: { type: 'string', description: 'Workspace-relative path where to save the file' }
            },
            required: ['url', 'path']
        }
    },
    {
        name: 'create_diagram',
        description: 'Create a diagram using Mermaid syntax. Generates an HTML file with the rendered diagram and opens a live preview. Supports flowcharts, sequence diagrams, class diagrams, ER diagrams, Gantt charts, pie charts, and more.',
        input_schema: {
            type: 'object',
            properties: {
                title: { type: 'string', description: 'Diagram title (used for the filename)' },
                mermaid: { type: 'string', description: 'Mermaid diagram definition (e.g. "graph TD; A-->B;")' },
                path: { type: 'string', description: 'Workspace-relative path to save the HTML file (default: diagrams/<title>.html)' }
            },
            required: ['title', 'mermaid']
        }
    },
    {
        name: 'copy_file',
        description: 'Copy a file from one location to another within the workspace. Requires user approval if the destination already exists.',
        input_schema: {
            type: 'object',
            properties: {
                source: { type: 'string', description: 'Workspace-relative path of the source file' },
                destination: { type: 'string', description: 'Workspace-relative path for the copy' }
            },
            required: ['source', 'destination']
        }
    }
];

// ── Text-parsed tool prompt (for Ollama fallback) ────────────────────────────

export const TOOL_SYSTEM_PROMPT = `
You have access to tools to read and modify the codebase. To invoke a tool write a fenced code block with language "tool":

\`\`\`tool
{"action": "action_name", ...params}
\`\`\`

AVAILABLE TOOLS:
- read_file     {"action":"read_file","path":"src/main.ts"}                                       read a file
- list_files    {"action":"list_files","pattern":"**/*.ts"}                                       list files by glob
- search_code   {"action":"search_code","query":"myFunc","filePattern":"*.ts"}                    grep across files
- write_file    {"action":"write_file","path":"src/new.ts","content":"..."}                       create / overwrite
- edit_file     {"action":"edit_file","path":"src/x.ts","oldStr":"exact","newStr":"replacement"}  targeted edit
- preview_html  {"action":"preview_html","path":"index.html"}                                    open a live preview tab
- run_command   {"action":"run_command","command":"npm test"}                                     run in terminal
- download_file  {"action":"download_file","url":"https://example.com/file.zip","path":"files/file.zip"} download from web
- create_diagram {"action":"create_diagram","title":"Auth Flow","mermaid":"graph TD; A-->B;"}     create & preview a Mermaid diagram
- copy_file      {"action":"copy_file","source":"src/old.ts","destination":"src/new.ts"}           copy a file
- git_status     {"action":"git_status"}                                                          repo status
- git_push       {"action":"git_push"}                                                            push to remote

GUIDELINES:
- For tasks that need multiple steps or touch several files, start your reply with a short plan — a numbered list of 2-5 steps — before making any tool calls, so the user knows what you're about to do. Skip the plan for simple one-step requests (answering a question, reading or editing a single file).
- Always read files before editing — never assume their contents
- Use edit_file for targeted changes; write_file only for new files or complete rewrites
- edit_file matches oldStr exactly when possible; if that fails it falls back to a whitespace-insensitive line match, so minor spacing differences are OK — but still copy oldStr from the file as closely as you can
- After creating or editing an HTML file, call preview_html on it so the user can see the rendered page in a tab inside VS Code — don't tell them to install a separate live-server extension
- All paths are relative to the workspace root
- When the user asks you to build, create, make, scaffold, or set up something (e.g. "make a website", "create a script that..."), use write_file to create the actual files in their workspace — don't just print example code in chat. Only show inline snippets when they ask for an explanation, example, or something not meant to be saved.
- When creating a website, write every file the HTML references (e.g. style.css, script.js, image placeholders) — never leave a <link> or <script> pointing at a file you didn't create
- To remember things across sessions (project conventions, architecture decisions, user preferences, in-progress work), write short bullet notes to .freebird/memory.md using write_file or edit_file. It's automatically loaded into your context next time — keep it concise and up to date, don't let it grow unbounded.
- After all changes are done, write a short summary of what you did
`;

export const NATIVE_TOOL_GUIDELINES = `GUIDELINES:
- For tasks that need multiple steps or touch several files, start your reply with a short plan before making any tool calls.
- Always read files before editing — never assume their contents.
- Use edit_file for targeted changes; write_file only for new files or complete rewrites.
- All paths are relative to the workspace root.
- When the user asks you to build/create something, use write_file to create actual files — don't just print code.
- When creating a website, write every file the HTML references.
- To remember things across sessions, write notes to .freebird/memory.md.
- After all changes, write a short summary.`;

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

// Convert a NativeToolCall (from cloud provider) into our internal ToolCall format
export function nativeToToolCall(name: string, input: Record<string, unknown>): ToolCall {
    return { action: name, ...input };
}

// ── Workspace tree cache ──────────────────────────────────────────────────────
let _workspaceTreeCache: string | null = null;
let _cacheWatcher: vscode.FileSystemWatcher | undefined;

export function initWorkspaceTreeCache(context: vscode.ExtensionContext): void {
    getWorkspaceTree();
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
            case 'read_file':      return await readFileTool(tool);
            case 'list_files':     return await listFilesTool(tool);
            case 'search_code':    return await searchCodeTool(tool);
            case 'write_file':     return await writeFileTool(tool, onApprovalNeeded);
            case 'edit_file':      return await editFileTool(tool, onApprovalNeeded);
            case 'preview_html':   return await previewHtmlTool(tool);
            case 'run_command':    return await runCommandTool(tool, onApprovalNeeded);
            case 'download_file':  return await downloadFileTool(tool, onApprovalNeeded);
            case 'create_diagram': return await createDiagramTool(tool);
            case 'copy_file':      return await copyFileTool(tool, onApprovalNeeded);
            case 'git_status':     return { success: true, output: await git.getStatus() };
            case 'git_push':       return await gitPushTool(git, onApprovalNeeded);
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

    // Try VS Code's built-in text search first (uses ripgrep under the hood)
    try {
        const results = await ripgrepSearch(query, filePattern);
        if (results !== null) return { success: true, output: results };
    } catch { /* fall through to manual search */ }

    // Fallback: manual file-by-file search with regex support
    const uris = await vscode.workspace.findFiles(filePattern, EXCLUDE_GLOB, 1000);
    let regex: RegExp;
    try {
        regex = new RegExp(query, 'g');
    } catch {
        regex = new RegExp(escapeRegex(query), 'g');
    }

    const matches: string[] = [];
    for (const uri of uris) {
        if (matches.length >= MAX_SEARCH_MATCHES) break;

        let text: string;
        try {
            text = fs.readFileSync(uri.fsPath, 'utf8');
        } catch {
            continue;
        }
        if (text.includes('\0')) continue;

        const rel = vscode.workspace.asRelativePath(uri);
        const lines = text.split('\n');
        for (let i = 0; i < lines.length && matches.length < MAX_SEARCH_MATCHES; i++) {
            if (regex.test(lines[i])) {
                matches.push(`${rel}:${i + 1}: ${lines[i].trim()}`);
            }
            regex.lastIndex = 0;
        }
    }

    return { success: true, output: matches.length ? matches.join('\n') : 'No matches found.' };
}

async function ripgrepSearch(query: string, filePattern: string): Promise<string | null> {
    const root = getWorkspaceRoot();
    return new Promise<string | null>((resolve) => {
        const globArg = filePattern !== '**/*' ? `--glob "${filePattern}"` : '';
        const cmd = `rg --line-number --max-count 200 --no-heading --color never ${globArg} -- "${query.replace(/"/g, '\\"')}"`;
        exec(cmd, { cwd: root, timeout: 10_000, maxBuffer: 512 * 1024 },
            (err, stdout) => {
                if (err && !stdout) { resolve(null); return; }
                const output = stdout.trim();
                resolve(output ? truncate(output, MAX_TOOL_OUTPUT_CHARS) : 'No matches found.');
            }
        );
    });
}

function escapeRegex(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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

function normalizeLine(line: string): string {
    return line.trim().replace(/\s+/g, ' ');
}

function findFuzzyMatch(content: string, oldStr: string): { start: number; end: number } | null {
    const oldLines = oldStr.split('\n');
    const normalizedOld = oldLines.map(normalizeLine);
    if (normalizedOld.every(l => l === '')) return null;

    const contentLines = content.split('\n');
    for (let i = 0; i <= contentLines.length - oldLines.length; i++) {
        let matched = true;
        for (let j = 0; j < oldLines.length; j++) {
            if (normalizeLine(contentLines[i + j]) !== normalizedOld[j]) {
                matched = false;
                break;
            }
        }
        if (matched) {
            const start = contentLines.slice(0, i).join('\n').length + (i === 0 ? 0 : 1);
            const matchedText = contentLines.slice(i, i + oldLines.length).join('\n');
            return { start, end: start + matchedText.length };
        }
    }
    return null;
}

async function editFileTool(tool: ToolCall, onApprovalNeeded: ApprovalFn): Promise<ToolResult> {
    const relPath = String(tool.path ?? '');
    const oldStr  = String(tool.oldStr ?? '');
    const newStr  = String(tool.newStr ?? '');
    if (!relPath || !oldStr) return { success: false, output: 'edit_file requires "path" and "oldStr".' };

    const full = resolveWorkspacePath(relPath);
    const content = fs.readFileSync(full, 'utf8');

    let start = content.indexOf(oldStr);
    let end = start === -1 ? -1 : start + oldStr.length;

    if (start === -1) {
        const fuzzy = findFuzzyMatch(content, oldStr);
        if (!fuzzy) {
            return { success: false, output: `oldStr not found in ${relPath}. Read the file first and copy the text to match exactly.` };
        }
        start = fuzzy.start;
        end = fuzzy.end;
    }

    const matchedText = content.slice(start, end);
    const updated = content.slice(0, start) + newStr + content.slice(end);

    // Show VS Code diff view for approval
    const approved = await showDiffApproval(full, content, updated, relPath, onApprovalNeeded);
    if (!approved) return { success: false, output: 'User rejected this change.' };

    fs.writeFileSync(full, updated, 'utf8');
    return { success: true, output: `Edited ${relPath}.` };
}

async function showDiffApproval(
    fullPath: string,
    originalContent: string,
    updatedContent: string,
    relPath: string,
    onApprovalNeeded: ApprovalFn
): Promise<boolean> {
    try {
        const root = getWorkspaceRoot();
        const tempDir = path.join(root, '.freebird', '.tmp');
        fs.mkdirSync(tempDir, { recursive: true });

        const origFile = path.join(tempDir, `orig_${path.basename(fullPath)}`);
        const newFile = path.join(tempDir, `new_${path.basename(fullPath)}`);

        fs.writeFileSync(origFile, originalContent, 'utf8');
        fs.writeFileSync(newFile, updatedContent, 'utf8');

        const origUri = vscode.Uri.file(origFile);
        const newUri = vscode.Uri.file(newFile);

        await vscode.commands.executeCommand('vscode.diff', origUri, newUri, `${relPath} — Freebird Edit`);

        const approved = await onApprovalNeeded(
            approvalId('edit_file'),
            `Edit ${relPath}`,
            '(see diff view)'
        );

        // Cleanup temp files
        try { fs.unlinkSync(origFile); } catch { /* ok */ }
        try { fs.unlinkSync(newFile); } catch { /* ok */ }
        try { fs.rmdirSync(tempDir); } catch { /* ok if not empty */ }

        return approved;
    } catch {
        // Fallback to text-based approval if diff view fails
        const preview = truncate(`- ${originalContent.slice(0, 500)}\n+ ${updatedContent.slice(0, 500)}`, 2000);
        return onApprovalNeeded(approvalId('edit_file'), `Edit ${relPath}`, preview);
    }
}

async function previewHtmlTool(tool: ToolCall): Promise<ToolResult> {
    const relPath = String(tool.path ?? '');
    if (!relPath) return { success: false, output: 'preview_html requires "path".' };

    const full = resolveWorkspacePath(relPath);
    if (!fs.existsSync(full)) {
        return { success: false, output: `${relPath} does not exist.` };
    }

    previewHtmlFile(full);
    return { success: true, output: `Opened a live preview of ${relPath}. It refreshes automatically when files are saved.` };
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

async function downloadFileTool(tool: ToolCall, onApprovalNeeded: ApprovalFn): Promise<ToolResult> {
    const url = String(tool.url ?? '');
    const relPath = String(tool.path ?? '');
    if (!url || !relPath) return { success: false, output: 'download_file requires "url" and "path".' };

    // Validate URL
    let parsedUrl: URL;
    try {
        parsedUrl = new URL(url);
    } catch {
        return { success: false, output: `Invalid URL: ${url}` };
    }

    if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
        return { success: false, output: `Only http/https URLs are supported.` };
    }

    const approved = await onApprovalNeeded(
        approvalId('download_file'),
        `Download ${url}`,
        `Save to: ${relPath}`
    );
    if (!approved) return { success: false, output: 'User rejected this download.' };

    const full = resolveWorkspacePath(relPath);
    const exists = fs.existsSync(full);

    return new Promise<ToolResult>(resolve => {
        const protocol = parsedUrl.protocol === 'https:' ? https : http;
        const timeout = setTimeout(() => {
            resolve({ success: false, output: 'Download timeout (30s exceeded).' });
        }, 30_000);

        const request = protocol.get(url, { timeout: 30_000 }, (response) => {
            clearTimeout(timeout);

            // Handle redirects
            if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
                const redirectUrl = response.headers.location;
                downloadFileTool({ ...tool, url: redirectUrl }, onApprovalNeeded).then(resolve);
                return;
            }

            if (!response.statusCode || response.statusCode !== 200) {
                resolve({ success: false, output: `HTTP ${response.statusCode}: ${response.statusMessage}` });
                return;
            }

            const contentLength = parseInt(response.headers['content-length'] || '0', 10);
            const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100 MB limit

            if (contentLength > MAX_FILE_SIZE) {
                resolve({ success: false, output: `File too large (${contentLength} bytes, limit is ${MAX_FILE_SIZE}).` });
                return;
            }

            try {
                fs.mkdirSync(path.dirname(full), { recursive: true });
                const writeStream = fs.createWriteStream(full);

                response.pipe(writeStream);

                writeStream.on('finish', () => {
                    writeStream.close();
                    const stats = fs.statSync(full);
                    resolve({
                        success: true,
                        output: `Downloaded ${relPath} (${stats.size} bytes)${exists ? ' and replaced existing file.' : '.'}`
                    });
                });

                writeStream.on('error', (err) => {
                    try { fs.unlinkSync(full); } catch { /* ok */ }
                    resolve({ success: false, output: `Write error: ${err.message}` });
                });
            } catch (err: any) {
                resolve({ success: false, output: `Error saving file: ${err?.message ?? String(err)}` });
            }
        });

        request.on('error', (err: any) => {
            clearTimeout(timeout);
            resolve({ success: false, output: `Download error: ${err?.message ?? String(err)}` });
        });
    });
}

async function createDiagramTool(tool: ToolCall): Promise<ToolResult> {
    const title = String(tool.title ?? '').trim();
    const mermaid = String(tool.mermaid ?? '').trim();
    if (!title || !mermaid) return { success: false, output: 'create_diagram requires "title" and "mermaid".' };

    const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
    const relPath = String(tool.path ?? '') || `diagrams/${slug}.html`;
    const full = resolveWorkspacePath(relPath);

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #1e1e2e; color: #cdd6f4; display: flex; flex-direction: column; align-items: center; padding: 2rem; margin: 0; }
    h1 { font-size: 1.4rem; margin-bottom: 1.5rem; color: #89b4fa; }
    .mermaid { background: #181825; border-radius: 8px; padding: 1.5rem; max-width: 100%; overflow-x: auto; }
  </style>
</head>
<body>
  <h1>${title.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</h1>
  <div class="mermaid">
${mermaid}
  </div>
  <script src="https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js"><\/script>
  <script>mermaid.initialize({ startOnLoad: true, theme: 'dark' });<\/script>
</body>
</html>`;

    try {
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, html, 'utf8');
        previewHtmlFile(full);
        return { success: true, output: `Diagram saved to ${relPath} and opened in preview.` };
    } catch (err: any) {
        return { success: false, output: `Error creating diagram: ${err?.message ?? String(err)}` };
    }
}

async function copyFileTool(tool: ToolCall, onApprovalNeeded: ApprovalFn): Promise<ToolResult> {
    const source = String(tool.source ?? '').trim();
    const destination = String(tool.destination ?? '').trim();
    if (!source || !destination) return { success: false, output: 'copy_file requires "source" and "destination".' };

    const srcFull = resolveWorkspacePath(source);
    const dstFull = resolveWorkspacePath(destination);

    if (!fs.existsSync(srcFull)) return { success: false, output: `Source file not found: ${source}` };
    if (!fs.statSync(srcFull).isFile()) return { success: false, output: `Source is not a file: ${source}` };

    if (fs.existsSync(dstFull)) {
        const approved = await onApprovalNeeded(
            approvalId('copy_file'),
            `Overwrite ${destination}`,
            `Copy ${source} → ${destination} (destination already exists)`
        );
        if (!approved) return { success: false, output: 'User rejected the overwrite.' };
    }

    try {
        fs.mkdirSync(path.dirname(dstFull), { recursive: true });
        fs.copyFileSync(srcFull, dstFull);
        return { success: true, output: `Copied ${source} → ${destination}` };
    } catch (err: any) {
        return { success: false, output: `Error copying file: ${err?.message ?? String(err)}` };
    }
}

async function gitPushTool(git: GitService, onApprovalNeeded: ApprovalFn): Promise<ToolResult> {
    const approved = await onApprovalNeeded(approvalId('git_push'), 'Push to remote', 'git push');
    if (!approved) return { success: false, output: 'User rejected the push.' };

    await git.push();
    return { success: true, output: 'Pushed to remote.' };
}
