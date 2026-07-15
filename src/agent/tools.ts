import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as https from 'https';
import * as http from 'http';
import * as dns from 'dns';
import * as net from 'net';
import { exec, ExecException } from 'child_process';
import { GitService } from '../git/service';
import { previewHtmlFile } from './preview';
import { ToolSchema } from '../ai/provider';
import { searchCodebaseSemantic } from '../index/indexer';
import * as checkpoint from './checkpoint';

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
        description: 'Search for a regex pattern across workspace files. Returns matching lines with file paths and line numbers. Use this for exact strings, symbol names, or regex patterns.',
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
        name: 'search_codebase_semantic',
        description: 'Search the codebase by meaning rather than exact text — finds conceptually related code even when the query words don\'t appear literally (e.g. "where do we handle auth expiry" finds the right code even if it never says the word "expiry"). Prefer this over search_code when you\'re looking for a concept, behavior, or "where is X handled" rather than a known exact string/symbol name. Builds a local index on first use (may take a few seconds on a large repo).',
        input_schema: {
            type: 'object',
            properties: {
                query: { type: 'string', description: 'Natural-language description of what you\'re looking for' },
                topK: { type: 'number', description: 'How many results to return (default 8)', default: 8 }
            },
            required: ['query']
        }
    },
    {
        name: 'fetch_url',
        description: 'Fetch a webpage and return its readable text content (HTML tags/scripts/styles stripped). Use this to look up documentation, read an article, or check a URL the user gave you. Not for downloading files (use download_file) or arbitrary APIs expecting non-HTML responses.',
        input_schema: {
            type: 'object',
            properties: { url: { type: 'string', description: 'http(s) URL to fetch' } },
            required: ['url']
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
- search_code   {"action":"search_code","query":"myFunc","filePattern":"*.ts"}                    grep across files (exact text/regex)
- search_codebase_semantic {"action":"search_codebase_semantic","query":"how does auth expiry work"}  search by meaning, not exact text — use for concepts/behavior, not known symbol names
- fetch_url     {"action":"fetch_url","url":"https://example.com/docs"}                           fetch a webpage's readable text (docs, articles, a URL the user gave you)
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
- Use search_code for exact strings/symbol names; use search_codebase_semantic for concepts or "where is X handled" when you don't know the exact wording
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
- Use search_code for exact strings/symbol names; use search_codebase_semantic for concepts or "where is X handled" when you don't know the exact wording.
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
const MAX_FETCH_URL_CHARS = 8_000;
const MAX_FETCH_URL_BYTES = 5 * 1024 * 1024; // 5 MB — this is for reading text, not saving arbitrary files
const MAX_FETCH_REDIRECTS = 3;

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
    onApprovalNeeded: ApprovalFn,
    context: vscode.ExtensionContext,
    sessionId: string,
    turnId: string
): Promise<ToolResult> {
    try {
        switch (tool.action) {
            case 'read_file':      return await readFileTool(tool);
            case 'list_files':     return await listFilesTool(tool);
            case 'search_code':    return await searchCodeTool(tool);
            case 'search_codebase_semantic': return await searchCodebaseSemanticTool(tool, context, sessionId);
            case 'fetch_url':      return await fetchUrlTool(tool);
            case 'write_file':     return await writeFileTool(tool, onApprovalNeeded, turnId);
            case 'edit_file':      return await editFileTool(tool, onApprovalNeeded, turnId);
            case 'preview_html':   return await previewHtmlTool(tool);
            case 'run_command':    return await runCommandTool(tool, onApprovalNeeded, turnId);
            case 'download_file':  return await downloadFileTool(tool, onApprovalNeeded, turnId);
            case 'create_diagram': return await createDiagramTool(tool);
            case 'copy_file':      return await copyFileTool(tool, onApprovalNeeded, turnId);
            case 'git_status':     return { success: true, output: await git.getStatus() };
            case 'git_push':       return await gitPushTool(git, onApprovalNeeded, turnId);
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

async function searchCodebaseSemanticTool(
    tool: ToolCall,
    context: vscode.ExtensionContext,
    sessionId: string
): Promise<ToolResult> {
    const query = String(tool.query ?? '');
    if (!query) return { success: false, output: 'search_codebase_semantic requires "query".' };
    const topK = typeof tool.topK === 'number' ? tool.topK : 8;

    const results = await searchCodebaseSemantic(context, sessionId, query, topK);
    if (results.length === 0) {
        return { success: true, output: 'No semantically relevant results found (or the workspace has no indexable files yet).' };
    }

    const formatted = results.map(r =>
        `${r.filePath}:${r.startLine + 1}-${r.endLine + 1} (relevance ${(r.score * 100).toFixed(0)}%)\n${truncate(r.text, 800)}`
    ).join('\n\n---\n\n');

    return { success: true, output: formatted };
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

// ── fetch_url ─────────────────────────────────────────────────────────────
//
// Resolves the hostname and rejects private/loopback/link-local IPs before
// connecting, to stop the agent being tricked into hitting internal services
// (localhost, cloud metadata endpoints, LAN devices) via a model-supplied URL.
// Each redirect hop is re-validated the same way, since a public URL
// redirecting to an internal address is the more realistic version of this.
// This doesn't defend against DNS rebinding between the check and the actual
// connect (a TOCTOU window) — full protection would mean connecting by IP
// with manual SNI/Host handling, which is more machinery than this feature's
// risk level (fetching docs pages for an AI assistant) currently justifies.

export function isPrivateAddress(ip: string): boolean {
    if (ip === '::1' || ip === '0.0.0.0') return true;
    if (ip.startsWith('::ffff:')) ip = ip.slice(7);

    // IPv6 unique-local / link-local
    if (ip.includes(':')) {
        const lower = ip.toLowerCase();
        return lower.startsWith('fc') || lower.startsWith('fd') || lower.startsWith('fe80');
    }

    const parts = ip.split('.').map(Number);
    if (parts.length !== 4 || parts.some(n => Number.isNaN(n))) return true; // malformed — fail closed

    const [a, b] = parts;
    if (a === 127) return true;                          // loopback
    if (a === 10) return true;                            // 10.0.0.0/8
    if (a === 172 && b >= 16 && b <= 31) return true;      // 172.16.0.0/12
    if (a === 192 && b === 168) return true;               // 192.168.0.0/16
    if (a === 169 && b === 254) return true;               // link-local + cloud metadata (169.254.169.254)
    if (a === 0) return true;                              // "this network"
    return false;
}

export function stripHtmlToText(html: string): string {
    let text = html
        .replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, ' ')
        .replace(/<!--[\s\S]*?-->/g, ' ')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, '\n')
        .replace(/<[^>]+>/g, ' ');

    text = text
        .replace(/&nbsp;/gi, ' ')
        .replace(/&amp;/gi, '&')
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&quot;/gi, '"')
        .replace(/&#39;/gi, "'");

    return text
        .split('\n')
        .map(line => line.replace(/[ \t]+/g, ' ').trim())
        .filter(Boolean)
        .join('\n');
}

// Hooks the actual DNS resolution Node performs when opening the socket —
// not a separate upfront lookup — so there's no gap between "checked" and
// "connected" for a DNS-rebinding attack to land in.
function safeLookup(
    hostname: string,
    options: dns.LookupOptions,
    callback: (err: NodeJS.ErrnoException | null, address: string | dns.LookupAddress[], family?: number) => void
): void {
    dns.lookup(hostname, options, (err, address, family) => {
        const ip = Array.isArray(address) ? address[0]?.address : address;
        if (!err && ip && isPrivateAddress(ip)) {
            callback(new Error(`Refusing to connect to ${hostname} — resolves to a private/internal address.`), '');
            return;
        }
        callback(err, address, family);
    });
}

async function fetchUrlOnce(url: string): Promise<{ body: string; redirectTo?: string }> {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
        throw new Error('Only http/https URLs are supported.');
    }

    // Node never invokes a custom `lookup` function when the host is already a literal
    // IP (nothing to resolve) — so a URL like http://169.254.169.254/ would otherwise
    // connect straight through the safeLookup guard below. Check literal IPs directly;
    // it's a plain equality check against the address the request will actually use,
    // not a separate resolution, so there's no rebinding window to race here.
    const hostname = parsed.hostname.replace(/^\[|\]$/g, ''); // strip [] from literal IPv6 hosts
    if (net.isIP(hostname) && isPrivateAddress(hostname)) {
        throw new Error(`Refusing to connect to ${hostname} — a private/internal address.`);
    }

    const protocol = parsed.protocol === 'https:' ? https : http;

    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Request timed out (15s exceeded).')), 15_000);

        const request = protocol.get(url, { timeout: 15_000, lookup: safeLookup }, response => {
            clearTimeout(timeout);

            if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
                response.resume();
                resolve({ body: '', redirectTo: new URL(response.headers.location, url).toString() });
                return;
            }

            if (!response.statusCode || response.statusCode >= 400) {
                reject(new Error(`HTTP ${response.statusCode}: ${response.statusMessage}`));
                return;
            }

            let size = 0;
            const chunks: Buffer[] = [];
            response.on('data', (chunk: Buffer) => {
                size += chunk.length;
                if (size > MAX_FETCH_URL_BYTES) {
                    request.destroy();
                    reject(new Error(`Response too large (limit ${MAX_FETCH_URL_BYTES} bytes).`));
                    return;
                }
                chunks.push(chunk);
            });
            response.on('end', () => resolve({ body: Buffer.concat(chunks).toString('utf8') }));
            response.on('error', reject);
        });

        request.on('error', err => { clearTimeout(timeout); reject(err); });
        request.on('timeout', () => request.destroy());
    });
}

async function fetchUrlTool(tool: ToolCall): Promise<ToolResult> {
    const url = String(tool.url ?? '').trim();
    if (!url) return { success: false, output: 'fetch_url requires "url".' };

    let current = url;
    try {
        for (let hop = 0; hop <= MAX_FETCH_REDIRECTS; hop++) {
            const { body, redirectTo } = await fetchUrlOnce(current);
            if (redirectTo) {
                if (hop === MAX_FETCH_REDIRECTS) {
                    return { success: false, output: `Too many redirects (>${MAX_FETCH_REDIRECTS}).` };
                }
                current = redirectTo;
                continue;
            }
            const text = truncate(stripHtmlToText(body), MAX_FETCH_URL_CHARS);
            return { success: true, output: text || '(page had no readable text content)' };
        }
        return { success: false, output: 'Too many redirects.' };
    } catch (err: any) {
        return { success: false, output: `Error fetching ${current}: ${err?.message ?? String(err)}` };
    }
}

async function writeFileTool(tool: ToolCall, onApprovalNeeded: ApprovalFn, turnId: string): Promise<ToolResult> {
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

    checkpoint.recordPreState(turnId, relPath, {
        existed: exists,
        content: exists ? fs.readFileSync(full).toString('base64') : undefined
    });

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

async function editFileTool(tool: ToolCall, onApprovalNeeded: ApprovalFn, turnId: string): Promise<ToolResult> {
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

    checkpoint.recordPreState(turnId, relPath, { existed: true, content: Buffer.from(content, 'utf8').toString('base64') });

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

async function runCommandTool(tool: ToolCall, onApprovalNeeded: ApprovalFn, turnId: string): Promise<ToolResult> {
    const command = String(tool.command ?? '');
    if (!command) return { success: false, output: 'run_command requires "command".' };

    const approved = await onApprovalNeeded(approvalId('run_command'), 'Run command', command);
    if (!approved) return { success: false, output: 'User rejected running this command.' };

    checkpoint.markTurnUnrevertable(turnId);

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

async function downloadFileTool(tool: ToolCall, onApprovalNeeded: ApprovalFn, turnId: string): Promise<ToolResult> {
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

    checkpoint.recordPreState(turnId, relPath, {
        existed: exists,
        content: exists ? fs.readFileSync(full).toString('base64') : undefined
    });

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
                downloadFileTool({ ...tool, url: redirectUrl }, onApprovalNeeded, turnId).then(resolve);
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

async function copyFileTool(tool: ToolCall, onApprovalNeeded: ApprovalFn, turnId: string): Promise<ToolResult> {
    const source = String(tool.source ?? '').trim();
    const destination = String(tool.destination ?? '').trim();
    if (!source || !destination) return { success: false, output: 'copy_file requires "source" and "destination".' };

    const srcFull = resolveWorkspacePath(source);
    const dstFull = resolveWorkspacePath(destination);

    if (!fs.existsSync(srcFull)) return { success: false, output: `Source file not found: ${source}` };
    if (!fs.statSync(srcFull).isFile()) return { success: false, output: `Source is not a file: ${source}` };

    const dstExists = fs.existsSync(dstFull);
    if (dstExists) {
        const approved = await onApprovalNeeded(
            approvalId('copy_file'),
            `Overwrite ${destination}`,
            `Copy ${source} → ${destination} (destination already exists)`
        );
        if (!approved) return { success: false, output: 'User rejected the overwrite.' };
    }

    checkpoint.recordPreState(turnId, destination, {
        existed: dstExists,
        content: dstExists ? fs.readFileSync(dstFull).toString('base64') : undefined
    });

    try {
        fs.mkdirSync(path.dirname(dstFull), { recursive: true });
        fs.copyFileSync(srcFull, dstFull);
        return { success: true, output: `Copied ${source} → ${destination}` };
    } catch (err: any) {
        return { success: false, output: `Error copying file: ${err?.message ?? String(err)}` };
    }
}

async function gitPushTool(git: GitService, onApprovalNeeded: ApprovalFn, turnId: string): Promise<ToolResult> {
    const approved = await onApprovalNeeded(approvalId('git_push'), 'Push to remote', 'git push');
    if (!approved) return { success: false, output: 'User rejected the push.' };

    checkpoint.markTurnUnrevertable(turnId);

    await git.push();
    return { success: true, output: 'Pushed to remote.' };
}
