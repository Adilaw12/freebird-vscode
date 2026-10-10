import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { getProvider, BYOK_BACKENDS } from '../ai';
import { CloudProvider, getPremiumAllowance } from '../ai/cloud';
import { OllamaProvider } from '../ai/ollama';
import { GitService } from '../git/service';
import { Message } from '../ai/provider';
import { runAgentLoop, AgentEvent, stripToolBlocks } from '../agent/loop';
import { buildFileContext, resolveMentions, listWorkspaceFiles } from './contextBuilder';
import { LATEST_VERSION_KEY, isOlderVersion } from '../announcement';
import { getLicenseStatus, getPersistedLicenseHint, UPGRADE_URL, TEMPLATES_UPGRADE_URL, XENDIT_CHECKOUT_URL } from '../license/validator';
import { getTemplateWelcomeEndsAt } from '../agent/templateCatalog';
import { getCloudEditsRemaining, DAILY_CLOUD_LIMIT } from '../license/usage';
import { recordEditUsed, recordAgentRun, getUsageStats } from '../license/stats';
import {
    getAgentTrialRunsLeft, recordAgentTrialRun, markAgentTrialExhausted, AGENT_TRIAL_MAX_ITERATIONS
} from '../license/agentTrial';
import { readProjectMemory, clearProjectMemory, appendProjectMemory, MEMORY_RELATIVE_PATH } from '../agent/memory';
import { readDocument, isSpecialDocument } from '../agent/documents';
import { readProjectRules, RULES_RELATIVE_PATH } from '../agent/rules';
import { finalizeTurn, restoreCheckpoint, checkpointsRootFor } from '../agent/checkpoint';
import { trackEvent, getMachineId } from '../telemetry';
import { MERMAID_THEME_SCRIPT } from '../agent/mermaidTheme';
import { perfLog } from '../util/perfLog';
import { submitFeedback, canAutoPrompt, markPrompted, recordDismissed, recordResultDelivered, FeedbackSubmission } from '../feedback';
import { getTrialBannerState } from '../license/trialReminder';

const MAX_HISTORY_PAIRS = 20;

// System prompt for the free cloud/Ollama tier (no agent tools)
const FREE_SYSTEM: Message[] = [
    {
        role: 'user',
        content:
            'You are Freebird, a free AI coding assistant for VS Code. ' +
            'Help with writing, debugging, explaining, and improving code. ' +
            'Use markdown with language-tagged code blocks. Be concise but thorough.\n\n' +
            'For multi-file editing, codebase search, and terminal commands, the user can ' +
            'upgrade to Pro for unlimited cloud-powered agent mode.'
    },
    {
        role: 'assistant',
        content: 'Ready — ask me anything about your code.'
    }
];

// ── Simple response cache ────────────────────────────────────────────────────
const _responseCache = new Map<string, { response: string; ts: number }>();
const CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_CACHE_ENTRIES = 20;

function cacheKey(text: string, history: Message[]): string {
    const h = crypto.createHash('md5').update(text + history.length).digest('hex');
    return h;
}

function getCachedResponse(key: string): string | null {
    const entry = _responseCache.get(key);
    if (!entry) return null;
    if (Date.now() - entry.ts > CACHE_TTL_MS) {
        _responseCache.delete(key);
        return null;
    }
    return entry.response;
}

// "gemini-3.1-flash-lite" -> "Gemini 3.1 Flash Lite" — no hardcoded model->label
// table to keep in sync as GEMINI_MODEL_CANDIDATES / the backend LLM changes.
function formatModelLabel(model: string): string {
    return model.split('-').map(w => /^\d/.test(w) ? w : w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

function setCachedResponse(key: string, response: string): void {
    if (_responseCache.size >= MAX_CACHE_ENTRIES) {
        const oldest = _responseCache.keys().next().value;
        if (oldest !== undefined) _responseCache.delete(oldest);
    }
    _responseCache.set(key, { response, ts: Date.now() });
}

// ── Sidebar view provider ────────────────────────────────────────────────────

export class ChatViewProvider implements vscode.WebviewViewProvider {
    static readonly viewType = 'freebird.chatView';
    static current: ChatViewProvider | undefined;

    private view?: vscode.WebviewView;
    private readonly context: vscode.ExtensionContext;
    private readonly git: GitService;
    private history: Message[] = [];
    private readonly pendingApprovals = new Map<string, (approved: boolean) => void>();
    private rawBuffer = '';
    private sessionMessageCount = 0;
    private toolCallsThisRound = 0;
    private currentTurnId = '';
    private multiFileCtaShownThisSession = false;
    /** The last free-tier request, kept so the multi-file CTA's "run it as an agent" button can replay it. */
    private lastFreeRequest: { text: string; mentionContext: string } | undefined;
    // Set by useTemplate() right before populating the input with one of the
    // 3 free built-in templates; consumed (read-and-cleared) by the very next
    // handleMessage() call so it can't leak into a later, unrelated message.
    // Not verified against the actual sent text — matches this codebase's
    // existing loose trust level (e.g. quota is trusted from server headers).
    private pendingTemplateId: string | undefined;
    private readonly toolStartedAt = new Map<string, number>();
    /** Aborts the running turn when the Stop button is pressed. */
    private abortCtl: AbortController | undefined;
    /** "Approve all edits this chat" — file writes only; commands, pushes and downloads still ask. */
    private autoApproveEdits = false;
    private lastProgressLen = 0;
    /** What the transcript shows (user messages and assistant text) — kept so a reload can redraw the conversation. */
    private displayLog: { role: 'user' | 'assistant'; text: string }[] = [];
    private static readonly CHAT_KEY = 'freebird.savedChat';
    private static readonly CHAT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

    constructor(context: vscode.ExtensionContext, git: GitService) {
        this.context = context;
        this.git = git;
        ChatViewProvider.current = this;
    }

    resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken
    ): void {
        this.view = webviewView;
        this.loadSavedChat();
        const mediaRoot = vscode.Uri.joinPath(this.context.extensionUri, 'media');
        webviewView.webview.options = { enableScripts: true, localResourceRoots: [mediaRoot] };

        const mermaidUri = webviewView.webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'mermaid.min.js'));
        const html = fs.readFileSync(
            path.join(this.context.extensionPath, 'media', 'chat.html'), 'utf8'
        );
        webviewView.webview.html = html
            .replace(/\{\{CSP_SOURCE\}\}/g, webviewView.webview.cspSource)
            .replace(/\{\{MERMAID_URI\}\}/g, mermaidUri.toString())
            // Function replacer: the script contains `$` sequences a string replacement would mangle.
            .replace(/\{\{MERMAID_THEME_SCRIPT\}\}/g, () => MERMAID_THEME_SCRIPT);

        this.sendWorkspaceFiles();
        // The webview only exists once VS Code lazily resolves it (first time the
        // sidebar is shown) — any earlier post() from activate()'s refreshStatusBar()
        // silently dropped since `this.view` didn't exist yet. Send it now so the
        // upgrade banner/Pro badge reflect reality the moment the panel first opens,
        // instead of staying at their default hidden state until some other action
        // happens to call showLicenseStatus() again.
        this.showLicenseStatus();
        this.showUpdateNudge();

        webviewView.webview.onDidReceiveMessage(async (msg: any) => {
            switch (msg.type) {
                case 'send':
                    trackEvent('message_sent');
                    await this.handleMessage(msg.text, Array.isArray(msg.attachments) ? msg.attachments.map(String) : []);
                    break;
                case 'ready':
                    // The webview is now listening: resend what was posted before it could hear.
                    if (this.displayLog.length) this.post({ type: 'restore', items: this.displayLog });
                    this.showLicenseStatus();
                    this.showUpdateNudge();
                    this.sendWorkspaceFiles();
                    break;
                case 'update-open':
                    trackEvent('update_nudge_clicked');
                    vscode.env.openExternal(vscode.Uri.parse(this.listingUrl()));
                    break;
                case 'stop':
                    trackEvent('stop_clicked');
                    this.abortCtl?.abort();
                    // A pending approval card would otherwise keep the turn waiting forever.
                    for (const resolve of this.pendingApprovals.values()) resolve(false);
                    this.pendingApprovals.clear();
                    break;
                case 'attach-pick':
                    await this.pickAttachments();
                    break;
                case 'attach-uris':
                    this.attachUris(Array.isArray(msg.uris) ? msg.uris.map(String) : []);
                    break;
                case 'attach-upload':
                    this.saveUploadedFiles(Array.isArray(msg.files) ? msg.files : []);
                    break;
                case 'clear':
                    this.history = [];
                    this.displayLog = [];
                    this.autoApproveEdits = false;
                    this.persistChat();
                    this.post({ type: 'cleared' });
                    break;
                case 'approval-response': {
                    const resolve = this.pendingApprovals.get(msg.id);
                    if (msg.always === true) {
                        this.autoApproveEdits = true;
                        trackEvent('approve_all_edits');
                    }
                    if (resolve) {
                        resolve(msg.approved as boolean);
                        this.pendingApprovals.delete(msg.id);
                    }
                    break;
                }
                case 'quota-wall-shown':
                    // Funnel stage 1: user hit the quota wall and saw the prompt
                    trackEvent('quota_wall_shown');
                    break;
                case 'upgrade':
                    // Funnel stage 2: user clicked through to Stripe checkout
                    vscode.env.openExternal(vscode.Uri.parse(UPGRADE_URL));
                    trackEvent('upgrade_clicked');
                    break;
                case 'upgrade-local':
                    // Same funnel stage, Xendit path — Stripe doesn't support
                    // Indonesia/Vietnam's local e-wallet rails at all.
                    vscode.env.openExternal(vscode.Uri.parse(XENDIT_CHECKOUT_URL));
                    trackEvent('upgrade_clicked_local');
                    break;
                case 'upgrade-templates':
                    if (TEMPLATES_UPGRADE_URL) {
                        vscode.env.openExternal(vscode.Uri.parse(TEMPLATES_UPGRADE_URL));
                    } else {
                        vscode.window.showInformationMessage('Freebird Template Library purchasing isn\'t set up yet.');
                    }
                    trackEvent('template_upgrade_clicked');
                    break;
                case 'install-ollama':
                    vscode.env.openExternal(vscode.Uri.parse('https://ollama.com/download'));
                    trackEvent('ollama_install_clicked');
                    break;
                case 'activate-license':
                    vscode.commands.executeCommand('freebird.activateLicense');
                    break;
                case 'sign-in-github':
                    vscode.commands.executeCommand('freebird.signInWithGitHub');
                    break;
                case 'start-trial':
                    vscode.commands.executeCommand('freebird.startTrial');
                    break;
                case 'restore-checkpoint':
                    await this.handleRestoreCheckpoint(msg.id, msg.files as string[] | undefined);
                    break;
                case 'run-agent-trial':
                    trackEvent('agent_trial_cta_clicked');
                    if (this.lastFreeRequest) {
                        await this.runAgentTrial(this.lastFreeRequest.text, this.lastFreeRequest.mentionContext);
                    }
                    break;
                case 'feedback-submit': {
                    const ok = await submitFeedback(this.context, {
                        trigger: msg.trigger, rating: msg.rating, reason: msg.reason,
                        text: typeof msg.text === 'string' ? msg.text : undefined, context: msg.context
                    } as FeedbackSubmission);
                    this.post({ type: 'feedback-result', id: msg.id, ok });
                    break;
                }
                case 'feedback-dismiss':
                    // Only an unprompted ask counts as "ignored" — closing the
                    // form the user opened themselves says nothing about prompts.
                    if (msg.auto) await recordDismissed(this.context);
                    trackEvent('feedback_dismissed', msg.trigger);
                    break;
                case 'browse-templates':
                    trackEvent('templates_button_clicked');
                    vscode.commands.executeCommand('freebird.usePromptTemplate');
                    break;
            }
        });

        webviewView.onDidDispose(() => {
            for (const resolve of this.pendingApprovals.values()) resolve(false);
            this.pendingApprovals.clear();
        });
    }

    /** Opens the feedback card on demand (top-bar button, command palette, error toasts). */
    openFeedback(context?: string): void {
        this.post({ type: 'feedback-open', context });
    }

    /**
     * Unprompted ask, shown only after the task has finished and subject to the
     * global cap in feedback.ts. A failure bypasses the warm-up but not the cap.
     */
    private async maybePromptFeedback(kind: 'result' | 'failure', context?: string): Promise<void> {
        if (kind === 'result') await recordResultDelivered(this.context);
        if (!canAutoPrompt(this.context, kind)) return;
        await markPrompted(this.context);
        trackEvent('feedback_prompt_shown', kind);
        this.post({ type: 'feedback-prompt', kind, context });
    }

    /** What the welcome screen offers a free user right now: free Agent runs and the template window. */
    private welcomeOffers(): { agentRunsLeft: number; templateDaysLeft: number } {
        const byok = BYOK_BACKENDS.has(vscode.workspace.getConfiguration('freebird').get<string>('backend', 'cloud'));
        const endsAt = getTemplateWelcomeEndsAt(this.context);
        return {
            agentRunsLeft: getAgentTrialRunsLeft(this.context, byok),
            templateDaysLeft: endsAt === null ? 0 : Math.max(1, Math.ceil((endsAt - Date.now()) / 86_400_000))
        };
    }

    /** This install's listing page: the VS Code Marketplace for TenLabs, Open VSX for any other publisher namespace. */
    private listingUrl(): string {
        const { publisher, name } = this.context.extension.packageJSON as { publisher: string; name: string };
        return publisher === 'TenLabs'
            ? `https://marketplace.visualstudio.com/items?itemName=${publisher}.${name}`
            : `https://open-vsx.org/extension/${publisher}/${name}`;
    }

    /** Nudges users on an older release to update. Shown in the transcript each time the chat opens. */
    private showUpdateNudge(): void {
        const latest = this.context.globalState.get<string>(LATEST_VERSION_KEY);
        const current = this.context.extension.packageJSON.version as string;
        if (!latest || !isOlderVersion(current, latest)) return;
        trackEvent('update_nudge_shown');
        this.post({ type: 'update-nudge', current, latest });
    }

    async showLicenseStatus() {
        // Paint the last known-good state immediately. The real check below can take
        // seconds (network, 6s timeout), and until it returned the panel looked
        // unlicensed on every window open — which reads as "I have to activate again".
        const hint = getPersistedLicenseHint(this.context);
        if (hint) {
            this.post({ type: 'license-status', isPro: true, plan: hint.plan, email: hint.email, trialBannerMessage: null, ...this.welcomeOffers() });
        }

        const status = await getLicenseStatus(this.context);
        const licenseKey = vscode.workspace.getConfiguration('freebird').get<string>('licenseKey', '').trim().toUpperCase();
        const trialBanner = getTrialBannerState(this.context, status, licenseKey);
        this.post({
            type: 'license-status',
            isPro: status.isPro,
            plan: status.plan,
            email: status.email,
            trialBannerMessage: trialBanner?.message ?? null,
            ...this.welcomeOffers()
        });
        if (status.isPro) {
            this.post({ type: 'usage-stats', ...getUsageStats(this.context) });
        } else if (licenseKey && status.reason) {
            // A key is saved but not granting Pro. Say why — silently showing Free reads as "it forgot my licence".
            this.post({
                type: 'notice',
                text: status.reason === 'offline'
                    ? 'Could not reach the Freebird license server, so Pro is paused until you are back online. Your key is still saved.'
                    : 'Your saved license key is not active (it may have expired or been cancelled). Use "Freebird: Activate License" to enter a new key, or email support@ten-labs.com.au.'
            });
        }
    }

    /** One-time explainer, shown before the very first Agent-mode turn a user ever runs. */
    private async maybeShowAgentModeExplainer(): Promise<void> {
        const KEY = 'freebird.agentModeExplainerShown';
        if (this.context.globalState.get<boolean>(KEY)) return;
        await this.context.globalState.update(KEY, true);

        this.post({ type: 'assistant-start' });
        this.post({
            type: 'set-text',
            text:
                "**Two ways Freebird searches your code — worth knowing before your first request:**\n\n" +
                "- **`search_code`** — exact/keyword matches, like grep. Good when you know the literal text: *\"find files with 'payment' in the name.\"*\n" +
                "- **Semantic search** — finds code by *meaning*, not literal text. Good for: *\"find functions related to payment processing\"* — it'll surface relevant logic even if nothing is named \"payment.\"\n\n" +
                "The agent picks whichever fits your question automatically. Semantic search needs an index first — run **Freebird: Build Codebase Index** once per project for it to work."
        });
        this.post({ type: 'assistant-end' });
        trackEvent('agent_mode_explainer_shown');
    }

    triggerCommand(command: string) {
        if (command === 'commit') this.handleCommit();
    }

    focus() {
        if (this.view) {
            this.view.show(true);
        }
    }

    /** Populates the chat input with a prompt template's text for the user to edit before sending — does not send it. */
    useTemplate(text: string, templateId?: string) {
        this.pendingTemplateId = templateId;
        this.focus();
        this.post({ type: 'populate-input', text });
    }

    private async sendWorkspaceFiles() {
        try {
            const files = await listWorkspaceFiles(300);
            this.post({ type: 'workspace-files', files });
        } catch { /* no workspace open */ }
    }

    // ── Conversation persistence ─────────────────────────────────────────────
    // Per project (workspaceState), so reopening a folder or reloading the window brings the conversation
    // back instead of an empty chat. Stored text is capped so a long session cannot bloat VS Code's state.

    private loadSavedChat(): void {
        if (this.displayLog.length || this.history.length) return;
        const saved = this.context.workspaceState.get<{ history: Message[]; log: { role: 'user' | 'assistant'; text: string }[]; savedAt: number }>(ChatViewProvider.CHAT_KEY);
        if (!saved || Date.now() - saved.savedAt > ChatViewProvider.CHAT_MAX_AGE_MS) return;
        this.history = Array.isArray(saved.history) ? saved.history : [];
        this.displayLog = Array.isArray(saved.log) ? saved.log : [];
    }

    private persistChat(): void {
        const cap = (s: string, n: number) => (s.length > n ? s.slice(0, n) + '\n… (shortened)' : s);
        let log = this.displayLog.slice(-60).map(m => ({ role: m.role, text: cap(m.text, 8000) }));
        this.displayLog = log;
        const history = this.history.map(m => ({ role: m.role, content: cap(m.content, 6000) }));
        if (!log.length && !history.length) {
            void this.context.workspaceState.update(ChatViewProvider.CHAT_KEY, undefined);
            return;
        }
        while (log.length > 4 && JSON.stringify({ history, log }).length > 250_000) log = log.slice(2);
        void this.context.workspaceState.update(ChatViewProvider.CHAT_KEY, { history, log, savedAt: Date.now() });
    }

    // ── Attachments ──────────────────────────────────────────────────────────
    // Files the user attaches are copied into <workspace>/.freebird/uploads/ so the agent can open them with
    // read_file (images are shown to the model, Office/PDF files are text-extracted). Copying also fixes the
    // old failure where a file outside the workspace simply could not be read.

    private uploadsDir(): string | undefined {
        const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        return root ? path.join(root, '.freebird', 'uploads') : undefined;
    }

    private uniqueUploadName(dir: string, name: string): string {
        const safe = path.basename(name).replace(/[^\w.\- ()]/g, '_') || 'file';
        const ext = path.extname(safe);
        const stem = safe.slice(0, safe.length - ext.length);
        let candidate = safe;
        for (let n = 2; fs.existsSync(path.join(dir, candidate)); n++) candidate = `${stem}-${n}${ext}`;
        return candidate;
    }

    private reportAttachError(message: string) {
        this.post({ type: 'attach-error', message });
    }

    private async pickAttachments(): Promise<void> {
        if (!this.uploadsDir()) { this.reportAttachError('Open a folder first - Freebird saves attachments inside your workspace.'); return; }
        const picked = await vscode.window.showOpenDialog({
            canSelectMany: true,
            openLabel: 'Attach',
            title: 'Attach files for Freebird (images, PDF, Word, PowerPoint, Excel, text, code)'
        });
        if (picked?.length) this.copyIntoUploads(picked.map(u => u.fsPath));
    }

    /** Files dragged in from the VS Code Explorer arrive as file:// URIs rather than File objects. */
    private attachUris(uris: string[]): void {
        const paths: string[] = [];
        for (const u of uris.slice(0, 8)) {
            try { paths.push(vscode.Uri.parse(u).fsPath); } catch { /* skip unparsable */ }
        }
        this.copyIntoUploads(paths);
    }

    private copyIntoUploads(sources: string[]): void {
        const dir = this.uploadsDir();
        if (!dir) { this.reportAttachError('Open a folder first - Freebird saves attachments inside your workspace.'); return; }
        fs.mkdirSync(dir, { recursive: true });
        const added: { name: string; path: string }[] = [];
        for (const src of sources.slice(0, 8)) {
            try {
                const stat = fs.statSync(src);
                if (!stat.isFile()) { this.reportAttachError(`${path.basename(src)} is a folder - attach files, or mention a folder with @.`); continue; }
                if (stat.size > 25 * 1024 * 1024) { this.reportAttachError(`${path.basename(src)} is over 25 MB - too large to attach.`); continue; }
                const name = this.uniqueUploadName(dir, src);
                fs.copyFileSync(src, path.join(dir, name));
                added.push({ name, path: `.freebird/uploads/${name}` });
            } catch (err: any) {
                this.reportAttachError(`Could not attach ${path.basename(src)}: ${err?.message ?? err}`);
            }
        }
        if (added.length) { trackEvent('files_attached', String(added.length)); this.post({ type: 'attachments-added', files: added }); }
    }

    private saveUploadedFiles(files: { name?: string; data?: string }[]): void {
        const dir = this.uploadsDir();
        if (!dir) { this.reportAttachError('Open a folder first - Freebird saves attachments inside your workspace.'); return; }
        fs.mkdirSync(dir, { recursive: true });
        const added: { name: string; path: string }[] = [];
        for (const f of files.slice(0, 8)) {
            try {
                if (typeof f?.data !== 'string' || !f.data) continue;
                const buf = Buffer.from(f.data, 'base64');
                if (buf.length > 25 * 1024 * 1024) { this.reportAttachError(`${f.name ?? 'file'} is over 25 MB - too large to attach.`); continue; }
                const name = this.uniqueUploadName(dir, f.name || 'pasted-image.png');
                fs.writeFileSync(path.join(dir, name), buf);
                added.push({ name, path: `.freebird/uploads/${name}` });
            } catch (err: any) {
                this.reportAttachError(`Could not attach ${f?.name ?? 'file'}: ${err?.message ?? err}`);
            }
        }
        if (added.length) { trackEvent('files_attached', String(added.length)); this.post({ type: 'attachments-added', files: added }); }
    }

    /** Text appended to the user's message so the model knows what was attached and how to open it. */
    private describeAttachments(paths: string[], isPro: boolean): string {
        if (!paths.length) return '';
        const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (isPro) {
            return `\n\n[The user attached ${paths.length === 1 ? 'a file' : paths.length + ' files'}: ${paths.join(', ')}. ` +
                `Open ${paths.length === 1 ? 'it' : 'them'} with read_file first - images are shown to you directly, PDF/Word/PowerPoint/Excel files are text-extracted.]`;
        }
        // Free chat has no tools: inline what can be read as text, say plainly what cannot.
        let out = '';
        for (const p of paths) {
            const name = path.basename(p);
            try {
                const full = root ? path.join(root, p) : p;
                if (isSpecialDocument(full)) {
                    const doc = readDocument(full);
                    out += doc.kind === 'text'
                        ? `\n\n--- Attached file: ${name} ---\n${doc.text.slice(0, 12_000)}${doc.text.length > 12_000 ? '\n... (truncated)' : ''}`
                        : `\n\n[Attached image ${name}: looking at images needs Agent mode (Pro, or a free Agent run with /agent).]`;
                } else {
                    out += `\n\n--- Attached file: ${name} ---\n${fs.readFileSync(full, 'utf8').slice(0, 12_000)}`;
                }
            } catch (err: any) {
                out += `\n\n[Attached file ${name} could not be read: ${err?.message ?? err}]`;
            }
        }
        return out;
    }

    private async handleMessage(text: string, attachments: string[] = []) {
        const trimmed = text.trim();
        // Consumed exactly once per call, regardless of which branch below
        // actually runs — see the field's own comment for why.
        const templateId = this.pendingTemplateId;
        this.pendingTemplateId = undefined;

        if (trimmed === '/commit') { await this.handleCommit(); return; }
        if (trimmed === '/push')   { await this.handlePush();   return; }
        if (trimmed === '/status') { await this.handleStatus(); return; }
        if (trimmed === '/clear')  {
            this.history = [];
            this.displayLog = [];
            this.autoApproveEdits = false;
            this.persistChat();
            this.post({ type: 'cleared' });
            return;
        }
        if (/^\/remember\b/i.test(trimmed)) {
            const note = trimmed.replace(/^\/remember\s*/i, '');
            this.post({ type: 'user', text: trimmed });
            this.post({ type: 'assistant-start' });
            const r = note ? appendProjectMemory(note) : { ok: false, message: 'Usage: `/remember <something to keep across sessions>`' };
            this.post({ type: 'set-text', text: r.ok ? `Remembered. ${r.message}` : r.message });
            this.post({ type: 'assistant-end' });
            return;
        }
        if (trimmed === '/memory') {
            this.post({ type: 'user', text: '/memory' });
            this.post({ type: 'assistant-start' });
            const memory = readProjectMemory();
            this.post({
                type: 'set-text',
                text: memory
                    ? `**Project memory** (\`${MEMORY_RELATIVE_PATH}\`):\n\n${memory}`
                    : `No project memory yet. Ask Freebird (Pro) to remember something, and it'll save notes to \`${MEMORY_RELATIVE_PATH}\`.`
            });
            this.post({ type: 'assistant-end' });
            return;
        }
        if (trimmed === '/forget') {
            this.post({ type: 'user', text: '/forget' });
            const choice = await vscode.window.showWarningMessage(
                `Delete ${MEMORY_RELATIVE_PATH}? This clears everything Freebird remembers about this project.`,
                'Delete', 'Cancel'
            );
            this.post({ type: 'assistant-start' });
            this.post({
                type: 'set-text',
                text: choice === 'Delete'
                    ? (clearProjectMemory() ? 'Project memory cleared.' : 'No project memory to clear.')
                    : 'Cancelled.'
            });
            this.post({ type: 'assistant-end' });
            return;
        }
        if (trimmed === '/rules') {
            trackEvent('rules_viewed');
            this.post({ type: 'user', text: '/rules' });
            this.post({ type: 'assistant-start' });
            const rules = readProjectRules();
            this.post({
                type: 'set-text',
                text: rules
                    ? `**Project rules** (\`${RULES_RELATIVE_PATH}\`):\n\n${rules}`
                    : `No \`${RULES_RELATIVE_PATH}\` yet. Create it in your project root and Freebird will follow it in every chat and Agent-mode turn — coding conventions, style preferences, things to always/never do. Unlike \`${MEMORY_RELATIVE_PATH}\`, this file is yours: Freebird only reads it, never writes or deletes it.`
            });
            this.post({ type: 'assistant-end' });
            return;
        }
        if (trimmed === '/help') {
            this.post({ type: 'user', text: '/help' });
            this.post({ type: 'assistant-start' });
            const license = await getLicenseStatus(this.context);
            const helpLines = [
                '**Available commands:**',
                '',
                '`/commit` — AI-generate a git commit message',
                '`/push` — push current branch to remote',
                '`/status` — show git status',
                '`/rules` — show your project conventions from .freebird/rules.md',
                '`/remember <note>` — save a note to project memory right now',
                '`/memory` — show what Freebird remembers about this project',
                '`/forget` — clear project memory',
                '`/agent <request>` — run a task in Agent mode (free users get a few free runs)',
                '`/clear` — clear conversation history',
                '`/help` — show this message',
                '',
                '**@ mentions:**',
                'Type `@filename` to inject a file into your message.',
                'Example: `explain the logic in @src/utils/parser.ts`',
                '',
                '**Keyboard shortcuts:**',
                '`Ctrl+Alt+O` — open chat',
                '`Ctrl+Alt+K` — inline edit selected code',
                '',
            ];
            if (!license.isPro) {
                helpLines.push(
                    '**Free plan:**',
                    `${getCloudEditsRemaining(this.context)}/${DAILY_CLOUD_LIMIT} cloud edits left today (Gemini Flash) — resets daily.`,
                    `After cloud edits: falls back to local Ollama if available. Your own API key (BYOK) is always free and unmetered.`,
                    `Free Agent-mode runs left: ${getAgentTrialRunsLeft(this.context, BYOK_BACKENDS.has(vscode.workspace.getConfiguration('freebird').get<string>('backend', 'cloud')))} — try one with \`/agent <request>\`.`,
                    `[Upgrade to Pro](${UPGRADE_URL}) for unlimited cloud edits and unlimited Agent mode, or ` +
                    `[pay with local methods](${XENDIT_CHECKOUT_URL}) (Vietnam/Indonesia e-wallets).`,
                    ''
                );
            } else {
                const premium = getPremiumAllowance(this.context);
                helpLines.push(
                    '**Pro plan (Freebird Cloud):**',
                    premium
                        ? `${premium.remaining}/${premium.limit} premium Agent-mode requests left this month on Claude Sonnet 5 — after that, Agent mode continues on Claude Haiku.`
                        : 'Agent mode uses your monthly Claude Sonnet 5 allowance first, then continues on Claude Haiku.',
                    ''
                );
            }
            helpLines.push(
                '**Need help?**',
                'Billing or technical issues: [support@ten-labs.com.au](mailto:support@ten-labs.com.au)',
            );
            this.post({ type: 'set-text', text: helpLines.join('\n') });
            this.post({ type: 'assistant-end' });
            return;
        }

        // Echo the message first: the license check below can take seconds on a stale cache, and a chat that
        // doesn't acknowledge what you sent looks dead.
        const shownText = attachments.length ? `${trimmed}\n\nAttached: ${attachments.map(a => path.basename(a)).join(', ')}` : trimmed;
        this.post({ type: 'user', text: shownText });
        this.displayLog.push({ role: 'user', text: shownText });
        this.post({ type: 'status', text: 'Checking your plan…' });
        const mentioned = await resolveMentions(trimmed);
        const license = await getLicenseStatus(this.context);
        const cleanText = mentioned.cleanText + this.describeAttachments(attachments, license.isPro);
        const { mentionContext, resolvedCount } = mentioned;

        this.sessionMessageCount++;

        // "/agent <request>" — explicit Agent-mode request. Pro users already
        // get the agent loop on every message, so for them it just strips the
        // prefix; free users spend one of their free runs.
        const agentCmd = /^\/agent\b\s*/i;
        let requestText = cleanText;
        let explicitAgent = false;
        if (agentCmd.test(cleanText)) {
            explicitAgent = true;
            requestText = cleanText.replace(agentCmd, '').trim();
            if (!requestText) {
                this.post({ type: 'assistant-start' });
                this.post({ type: 'set-text', text: 'Usage: `/agent <what you want done>` — e.g. `/agent add input validation to @src/api/users.ts`.' });
                this.post({ type: 'assistant-end' });
                return;
            }
        }

        if (license.isPro) {
            trackEvent('pro_message');
            if (BYOK_BACKENDS.has(vscode.workspace.getConfiguration('freebird').get<string>('backend', 'cloud'))) {
                trackEvent('byok_message', vscode.workspace.getConfiguration('freebird').get<string>('backend', 'cloud'));
            }
            recordEditUsed(this.context);
            this.toolCallsThisRound = 0;
            await this.runProChat(requestText, mentionContext);
            // "Refactor" for the usage-analytics display is defined as an
            // Agent-mode turn that made at least one tool call — distinguishes
            // real multi-step work from a plain one-shot chat reply.
            if (this.toolCallsThisRound > 0) {
                recordAgentRun(this.context);
            }
            this.post({ type: 'usage-stats', ...getUsageStats(this.context) });

        } else {
            // Contextual Pro CTA: tied to the specific thing they just tried
            // (referencing 2+ files at once — real multi-file editing intent)
            // rather than a generic "Upgrade to Pro" shown out of context.
            // Once per session so it doesn't repeat on every message.
            if (explicitAgent) {
                await this.runAgentTrial(requestText, mentionContext);
                return;
            }
            this.lastFreeRequest = { text: cleanText, mentionContext };
            if (resolvedCount >= 2 && !this.multiFileCtaShownThisSession) {
                this.multiFileCtaShownThisSession = true;
                trackEvent('multifile_cta_shown');
                const byokNow = BYOK_BACKENDS.has(vscode.workspace.getConfiguration('freebird').get<string>('backend', 'cloud'));
                this.post({
                    type: 'multifile-cta',
                    fileCount: resolvedCount,
                    agentRunsLeft: getAgentTrialRunsLeft(this.context, byokNow)
                });
            }
            // Free tier — route by the backend the user actually configured.
            // Quota is enforced by the SERVER only (backend/api/chat.js,
            // 10/day). The old client-side 5-edit counter is gone: it
            // contradicted the advertised limit and pushed non-Ollama users
            // into a confusing Ollama-fallback path before the real quota
            // wall could ever show. Now the wall is the server's 429.
            const backend = vscode.workspace
                .getConfiguration('freebird')
                .get<string>('backend', 'cloud');
            // A configured BYOK backend is honoured for chat too: the call goes
            // straight to the user's own provider, so it is unmetered and must
            // never be counted against (or blocked by) the shared cloud quota.
            const mode: 'cloud' | 'ollama-then-cloud' | 'byok' =
                BYOK_BACKENDS.has(backend) ? 'byok'
                : backend === 'ollama' ? 'ollama-then-cloud'
                : 'cloud';
            if (mode === 'byok') trackEvent('byok_message', backend);

            this.toolCallsThisRound = 0;
            const served = await this.runFreeChat(cleanText, mentionContext, mode, templateId);

            if (served && mode === 'cloud') {
                // Count only successfully served edits, using the
                // server-reported remaining (X-Quota-Remaining header).
                trackEvent('cloud_edit_used');
                const remaining = getCloudEditsRemaining(this.context);
                this.post({ type: 'cloud-edit-used', remaining });

                if (remaining === 3) {
                    this.post({ type: 'upgrade-nudge', variant: 'running-low' });
                }
                if (this.toolCallsThisRound >= 3) {
                    this.post({ type: 'upgrade-nudge', variant: 'power-user' });
                }
                // Don't stack the ask on top of an upgrade nudge from the same turn.
                if (remaining !== 3 && this.toolCallsThisRound < 3) {
                    await this.maybePromptFeedback('result', 'cloud_edit');
                }
            } else if (served) {
                await this.maybePromptFeedback('result', mode === 'byok' ? 'byok_chat' : 'ollama_chat');
            }
        }
    }

    // ── Pro: full agentic loop ────────────────────────────────────────────────

    private async runProChat(text: string, mentionContext: string, trial?: { byok: boolean }) {
        const fileCtx = buildFileContext();
        const contextPrefix = [mentionContext, fileCtx].filter(Boolean).join('\n');
        const fullText = contextPrefix ? `${contextPrefix}\n\n${text}` : text;

        await this.maybeShowAgentModeExplainer();

        let changedFiles = false;
        let failureCode: string | undefined;
        this.abortCtl = new AbortController();
        this.lastProgressLen = 0;
        try {
            const newHistory = await runAgentLoop({
                userMessage: fullText,
                history: this.trimHistory(this.history),
                provider: getProvider(this.context, getMachineId()),
                git: this.git,
                context: this.context,
                sessionId: getMachineId(),
                // Free trial runs bill the capped server-side trial budget (cloud
                // only — BYOK runs are on the user's own key) and stop earlier.
                ...(trial && { agentTrial: !trial.byok, maxIterations: AGENT_TRIAL_MAX_ITERATIONS }),
                signal: this.abortCtl.signal,
                onEvent: (event: AgentEvent) => this.handleAgentEvent(event),
                onApprovalNeeded: (id, description, preview) => this.requestApproval(id, description, preview)
            });
            this.history = this.trimHistory(newHistory);

            const summary = finalizeTurn(checkpointsRootFor(this.context), this.currentTurnId);
            if (summary) {
                changedFiles = true;
                const isFirstEver = !this.context.globalState.get<boolean>('freebird.firstCheckpointSeen');
                if (isFirstEver) await this.context.globalState.update('freebird.firstCheckpointSeen', true);
                this.post({
                    type: 'checkpoint-ready',
                    id: summary.turnId,
                    files: summary.files,
                    unrevertable: summary.unrevertable,
                    isFirstEver
                });
            }
        } catch (err: any) {
            if (trial && err?.code === 'AGENT_TRIAL_EXHAUSTED') {
                // The server's budget is the source of truth (a reinstall or second
                // device won't have the local count) — sync and stop offering runs.
                await markAgentTrialExhausted(this.context);
                this.showAgentTrialExhausted();
                return;
            }
            trackEvent('api_error', err?.code || 'unknown');
            failureCode = err?.code || 'unknown';
            this.post({ type: 'assistant-start' });
            this.post({
                type: 'set-text',
                text: `**Error:** ${err.message}\n\nRun \`Freebird: Configure AI Backend\` to check your settings.`
            });
        }
        this.abortCtl = undefined;
        this.persistChat();
        this.post({ type: 'status', text: '' });
        this.post({ type: 'assistant-end' });
        // After the turn, not during it: a finished task that changed files is a real success.
        if (failureCode) await this.maybePromptFeedback('failure', failureCode);
        else if (changedFiles) await this.maybePromptFeedback('result', 'agent_run');
    }

    // ── Free-tier Agent-mode runs ─────────────────────────────────────────────

    /** Runs one free Agent-mode task for a free-tier user, within the free-run allowance. */
    private async runAgentTrial(text: string, mentionContext: string): Promise<void> {
        const byok = BYOK_BACKENDS.has(vscode.workspace.getConfiguration('freebird').get<string>('backend', 'cloud'));
        if (getAgentTrialRunsLeft(this.context, byok) <= 0) {
            this.showAgentTrialExhausted();
            return;
        }

        trackEvent('agent_trial_started', byok ? 'byok' : 'cloud');
        this.toolCallsThisRound = 0;
        await this.runProChat(text, mentionContext, { byok });

        // A run counts only if it actually used tools — a plain answer with no
        // tool calls isn't what the allowance is for, so it isn't charged.
        if (this.toolCallsThisRound > 0) {
            await recordAgentTrialRun(this.context);
            trackEvent('agent_trial_completed', byok ? 'byok' : 'cloud');
            this.post({ type: 'agent-trial-nudge', runsLeft: getAgentTrialRunsLeft(this.context, byok) });
        }
    }

    private showAgentTrialExhausted(): void {
        trackEvent('agent_trial_exhausted_shown');
        this.post({ type: 'assistant-start' });
        this.post({
            type: 'set-text',
            text: "You've used your free Agent-mode runs. Agent mode — multi-file edits, terminal, and a checkpoint to undo every turn — is part of Pro. You can try it free for 7 days, no card."
        });
        this.post({ type: 'assistant-end' });
        this.post({ type: 'agent-trial-nudge', runsLeft: 0 });
    }

    // ── Free tier: cloud (Gemini Flash) with Ollama fallback ─────────────────
    //
    // mode = 'cloud'            → use CloudProvider directly (has quota)
    // mode = 'ollama-then-cloud' → try Ollama first; if unreachable, use CloudProvider
    //                              (quota exhausted path — cloud here has no daily limit
    //                               since we only reach this after the 5 paid edits are gone,
    //                               but Gemini Flash is cheap enough to absorb the overflow)

    /** Returns true if a response was successfully served (used for edit accounting). */
    private async runFreeChat(
        text: string,
        mentionContext: string,
        mode: 'cloud' | 'ollama-then-cloud' | 'byok',
        templateId?: string
    ): Promise<boolean> {
        const fileContext  = buildFileContext();
        const contextParts = [mentionContext, fileContext].filter(Boolean).join('\n');
        const userContent  = contextParts ? `${contextParts}\n\n${text}` : text;

        // Cache check
        const key = cacheKey(userContent, this.history);
        const cached = getCachedResponse(key);
        if (cached) {
            this.post({ type: 'assistant-start' });
            this.post({ type: 'set-text', text: cached });
            this.history = this.trimHistory([
                ...this.history,
                { role: 'user', content: text },
                { role: 'assistant', content: cached }
            ]);
            this.post({ type: 'assistant-end' });
            return true;
        }

        const projectRules = readProjectRules();
        if (projectRules) trackEvent('rules_loaded');
        // Freebird Cloud caches a system message; BYOK keeps the prompt as user turns it has always had.
        const sysRole: 'system' | 'user' = mode === 'byok' ? 'user' : 'system';
        const messages: Message[] = [
            ...FREE_SYSTEM.map(m => (m.role === 'user' ? { ...m, role: sysRole } : m)) as Message[],
            ...(projectRules ? [{
                role: sysRole,
                content: `Project rules (${RULES_RELATIVE_PATH}) — the user's own conventions for this project. Follow these even when they conflict with your own defaults:\n${projectRules}`
            } as Message] : []),
            ...this.trimHistory(this.history),
            { role: 'user', content: userContent }
        ];

        this.post({ type: 'assistant-start' });
        let response = '';
        let served = true;
        let failureCode: string | undefined;
        let cloudProvider: CloudProvider | undefined;

        try {
            if (mode === 'ollama-then-cloud') {
                // Only reached when the user explicitly configured the
                // Ollama backend. Try their local Ollama first; if it is
                // unreachable, fall back to the normal quota'd cloud path
                // and tell them why — this event now genuinely means "an
                // Ollama user's Ollama was down", not "a cloud user ran
                // out of a hidden client-side counter".
                const ollamaAvailable = await this.tryOllama(messages, chunk => {
                    response += chunk;
                    this.post({ type: 'set-text', text: response });
                });

                if (!ollamaAvailable) {
                    trackEvent('ollama_not_reachable');
                    this.post({ type: 'ollama-fallback' });
                    cloudProvider = new CloudProvider(this.context, getMachineId());
                    await cloudProvider.stream(messages, chunk => {
                        response += chunk;
                        this.post({ type: 'set-text', text: response });
                    }, { templateId });
                    this.postModelTag();
                }
            } else if (mode === 'byok') {
                // The user's own key, called directly — no Freebird quota involved.
                await getProvider(this.context, getMachineId()).stream(messages, chunk => {
                    response += chunk;
                    this.post({ type: 'set-text', text: response });
                });
            } else {
                // mode = 'cloud' — use CloudProvider with normal quota
                cloudProvider = new CloudProvider(this.context, getMachineId());
                await cloudProvider.stream(messages, chunk => {
                    response += chunk;
                    this.post({ type: 'set-text', text: response });
                }, { templateId });
                this.postModelTag();
            }

            if (cloudProvider?.templateBonusUsed && templateId) {
                trackEvent('template_haiku_bonus_used', templateId);
                this.post({ type: 'upgrade-nudge', variant: 'template-bonus-used' });
            }

            if (response) setCachedResponse(key, response);

        } catch (err: any) {
            // Only count this as an "error" for genuinely unexpected failures —
            // QUOTA_EXCEEDED/AUTH_REQUIRED/IP_RATE_LIMITED are expected outcomes
            // (someone hit their daily cap, needs to sign in, etc.), each
            // already tracked under its own specific event below. Firing
            // api_error unconditionally here made completely normal quota hits
            // look like production errors in the dashboard.
            if (err?.code === 'AUTH_REQUIRED') {
                trackEvent('auth_required_shown');
                this.post({ type: 'auth-required' });
                return false;
            } else if (err?.code === 'QUOTA_EXCEEDED') {
                this.post({ type: 'quota-exceeded' });
                trackEvent('upgrade_prompt_shown');
                return false;
            } else if (err?.code === 'IP_RATE_LIMITED') {
                trackEvent('rate_limited');
                served = false;
                response =
                    `**Too many requests** — you've hit the fallback rate limit (20/hr).\n\n` +
                    `[Upgrade to Pro](${UPGRADE_URL}) (or [pay with local methods](${XENDIT_CHECKOUT_URL}) ` +
                    `for Vietnam/Indonesia) for unlimited access, or install ` +
                    `[Ollama](https://ollama.com) for unlimited free local AI.`;
            } else {
                trackEvent('api_error', err?.code || 'unknown');
                served = false;
                failureCode = err?.code || 'unknown';
                const errorNote =
                    `**Error:** ${err.message}\n\n` +
                    `Try running \`Freebird: Configure AI Backend\` to check your settings, ` +
                    `or [contact support](mailto:support@ten-labs.com.au).`;
                // A mid-stream abort/network error can fire after most of a real
                // answer already streamed in (e.g. a slow-but-working response
                // that hits the timeout) — append rather than overwrite, so a
                // mostly-good answer doesn't just vanish and get replaced by a
                // generic error with no trace it was ever there.
                response = response ? `${response}\n\n---\n${errorNote}` : errorNote;
            }
            this.post({ type: 'set-text', text: response });
        }

        this.history = this.trimHistory([
            ...this.history,
            { role: 'user', content: text },
            { role: 'assistant', content: response }
        ]);
        if (response.trim()) this.displayLog.push({ role: 'assistant', text: response });
        this.persistChat();

        this.post({ type: 'assistant-end' });
        if (failureCode) await this.maybePromptFeedback('failure', failureCode);
        return served && response.length > 0;
    }

    /** Tags the current assistant bubble with which cloud model actually answered — otherwise invisible to users. */
    private postModelTag() {
        const model = CloudProvider.getLastModelUsed(this.context);
        if (model) this.post({ type: 'model-tag', label: formatModelLabel(model) });
    }

    // Returns true if Ollama responded, false if unreachable
    private async tryOllama(
        messages: Message[],
        onChunk: (text: string) => void
    ): Promise<boolean> {
        try {
            const ollama = new OllamaProvider();
            await ollama.stream(messages, onChunk);
            return true;
        } catch {
            return false;
        }
    }

    private static readonly EDIT_APPROVALS = new Set(['write_file', 'edit_file', 'copy_file', 'create_presentation']);

    private requestApproval(id: string, description: string, preview: string): Promise<boolean> {
        const kind = id.slice(0, id.indexOf('-'));
        if (this.autoApproveEdits && ChatViewProvider.EDIT_APPROVALS.has(kind)) {
            this.post({ type: 'status', text: `Auto-approved: ${description}` });
            return Promise.resolve(true);
        }
        return new Promise<boolean>(resolve => {
            this.pendingApprovals.set(id, resolve);
            this.post({
                type: 'approval-request', id, description, preview,
                canApproveAll: ChatViewProvider.EDIT_APPROVALS.has(kind)
            });
            // The card sits at the bottom of the chat. If the sidebar is hidden or scrolled away the run looks
            // frozen, so say so outside the panel too.
            if (!this.view?.visible) {
                vscode.window.showInformationMessage(`Freebird is waiting for your approval: ${description}`, 'Open Freebird')
                    .then(choice => { if (choice) this.focus(); });
            }
        });
    }

    /** What a half-written tool call is doing, so a long file/deck write doesn't look like silence. */
    private progressFromPartialToolCall(buffer: string): string | undefined {
        const open = buffer.lastIndexOf('```tool');
        if (open < 0) return undefined;
        const tail = buffer.slice(open + 7);
        if (tail.includes('```')) return undefined; // already closed
        const action = tail.match(/"action"\s*:\s*"([a-z_]+)"/)?.[1];
        const target = tail.match(/"(?:path|title)"\s*:\s*"([^"]{1,80})"/)?.[1];
        const verb: Record<string, string> = {
            write_file: 'Writing', edit_file: 'Editing', create_presentation: 'Building presentation',
            create_drawing: 'Drawing', create_diagram: 'Creating diagram', create_floor_plan: 'Designing floor plan'
        };
        const size = tail.length >= 1000 ? ` - ${(tail.length / 1000).toFixed(1)}k characters so far` : '';
        return `${action ? (verb[action] ?? 'Preparing ' + action.replace(/_/g, ' ')) : 'Preparing a step'}${target ? ' ' + target : ''}${size}`;
    }

    private handleAgentEvent(event: AgentEvent) {
        switch (event.type) {
            case 'status':
                this.post({ type: 'status', text: event.text });
                break;
            case 'turn-start':
                this.currentTurnId = event.turnId;
                break;
            case 'iteration-start':
                this.rawBuffer = '';
                this.post({ type: 'assistant-start' });
                break;
            case 'text-chunk': {
                this.rawBuffer += event.text;
                this.post({ type: 'set-text', text: stripToolBlocks(this.rawBuffer) });
                const progress = this.progressFromPartialToolCall(this.rawBuffer);
                if (progress && this.rawBuffer.length - this.lastProgressLen >= 400) {
                    this.lastProgressLen = this.rawBuffer.length;
                    this.post({ type: 'status', text: progress });
                }
                break;
            }
            case 'response-complete': {
                const shown = stripToolBlocks(this.rawBuffer || event.rawText).trim();
                if (shown) this.displayLog.push({ role: 'assistant', text: shown });
                this.rawBuffer = '';
                break;
            }
            case 'tool-start':
                this.lastProgressLen = 0;
                this.post({ type: 'status', text: toolLabel(event.tool) });
                this.toolStartedAt.set(event.id, Date.now());
                this.toolCallsThisRound++;
                trackEvent(`tool_used_${event.tool.action}`);
                this.post({ type: 'tool-status', id: event.id, state: 'running', label: toolLabel(event.tool) });
                break;
            case 'tool-result': {
                perfLog(`tool     ${event.tool.action}  ${((Date.now() - (this.toolStartedAt.get(event.id) ?? Date.now())) / 1000).toFixed(1)}s  ${event.success ? 'ok' : 'FAILED'}`);
                this.toolStartedAt.delete(event.id);
                if (!event.success) trackEvent('tool_error', event.tool.action);
                // Related-location lists are short (max 6 lines) and meant to be read
                // in full — the generic 200-char preview cap would cut them mid-list.
                const cap = event.tool.action === 'flag_related_locations' ? Infinity : 200;
                this.post({
                    type: 'tool-update',
                    id: event.id,
                    state: event.success ? 'done' : 'error',
                    output: event.output.length > cap ? event.output.slice(0, cap) + '…' : event.output,
                    image: event.image
                });
                break;
            }
        }
    }

    // ── Checkpoints ──────────────────────────────────────────────────────────

    private async handleRestoreCheckpoint(turnId: string, files: string[] | undefined) {
        const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        const checkpointsRoot = checkpointsRootFor(this.context);
        if (!root || !checkpointsRoot) {
            this.post({ type: 'checkpoint-restored', id: turnId, restored: [], deleted: [], errors: ['No workspace open.'] });
            return;
        }

        const fileList = files && files.length ? files.join(', ') : 'the files from that turn';
        const choice = await vscode.window.showWarningMessage(
            `Restore ${fileList} to their state before this turn? Any manual edits made to these files since then will be overwritten.`,
            'Restore', 'Cancel'
        );
        if (choice !== 'Restore') return;

        const result = restoreCheckpoint(root, checkpointsRoot, turnId);
        this.post({ type: 'checkpoint-restored', id: turnId, ...result });
    }

    // ── Trim history ─────────────────────────────────────────────────────────

    private trimHistory(messages: Message[]): Message[] {
        const maxMessages = MAX_HISTORY_PAIRS * 2;
        if (messages.length <= maxMessages) return messages;
        return messages.slice(messages.length - maxMessages);
    }

    // ── Git commands ─────────────────────────────────────────────────────────

    private async handleCommit() {
        const diff = await this.git.getDiff();
        if (!diff) {
            this.post({ type: 'user', text: '/commit' });
            this.post({ type: 'assistant-start' });
            this.post({ type: 'set-text', text: 'No changes detected in the workspace.' });
            this.post({ type: 'assistant-end' });
            return;
        }

        this.post({ type: 'user', text: '/commit' });
        this.post({ type: 'assistant-start' });
        this.post({ type: 'set-text', text: 'Analyzing your changes…' });

        let commitMsg = '';
        try {
            // Use getProvider with context + sessionId so routing logic applies
            commitMsg = await getProvider(this.context, getMachineId()).complete([{
                role: 'user',
                content: `Write a concise conventional git commit message (imperative mood, max 72 chars subject line) for these changes. Reply with ONLY the commit message:\n\n${diff}`
            }]);
        } catch (err: any) {
            this.post({ type: 'set-text', text: `**Error:** ${err.message}` });
            this.post({ type: 'assistant-end' });
            return;
        }

        const trimmed = commitMsg.trim();
        this.post({ type: 'set-text', text: `Proposed commit:\n\n\`${trimmed}\`` });
        this.post({ type: 'assistant-end' });

        const choice = await vscode.window.showInformationMessage(
            `Proposed commit: "${trimmed}"`, 'Commit', 'Edit & Commit', 'Cancel'
        );
        if (choice === 'Commit') {
            try {
                await this.git.commit(trimmed);
                this.post({ type: 'assistant-start' });
                this.post({ type: 'set-text', text: `**Committed:** ${trimmed}` });
                this.post({ type: 'assistant-end' });
            } catch (err: any) { vscode.window.showErrorMessage(`Commit failed: ${err.message}`); }
        } else if (choice === 'Edit & Commit') {
            const edited = await vscode.window.showInputBox({ value: trimmed, prompt: 'Edit commit message' });
            if (edited) {
                try {
                    await this.git.commit(edited);
                    this.post({ type: 'assistant-start' });
                    this.post({ type: 'set-text', text: `**Committed:** ${edited}` });
                    this.post({ type: 'assistant-end' });
                } catch (err: any) { vscode.window.showErrorMessage(`Commit failed: ${err.message}`); }
            }
        }
    }

    private async handlePush() {
        this.post({ type: 'user', text: '/push' });
        this.post({ type: 'assistant-start' });
        try {
            await this.git.push();
            this.post({ type: 'set-text', text: '**Pushed** to remote successfully.' });
        } catch (err: any) {
            this.post({ type: 'set-text', text: `**Push failed:** ${err.message}` });
        }
        this.post({ type: 'assistant-end' });
    }

    private async handleStatus() {
        this.post({ type: 'user', text: '/status' });
        this.post({ type: 'assistant-start' });
        try {
            this.post({ type: 'set-text', text: `**Git status:**\n\n${await this.git.getStatus()}` });
        } catch (err: any) {
            this.post({ type: 'set-text', text: `**Error:** ${err.message}` });
        }
        this.post({ type: 'assistant-end' });
    }

    private post(msg: object) {
        this.view?.webview.postMessage(msg);
    }
}

function toolLabel(tool: { action: string; [key: string]: unknown }): string {
    switch (tool.action) {
        case 'read_file':      return `Reading ${tool.path}`;
        case 'list_files':     return `Listing files (${tool.pattern || '**/*'})`;
        case 'search_code':    return `Searching for "${tool.query}"`;
        case 'write_file':     return `Writing ${tool.path}`;
        case 'edit_file':      return `Editing ${tool.path}`;
        case 'run_command':    return `Running: ${tool.command}`;
        case 'download_file':  return `Downloading ${tool.url}`;
        case 'create_diagram': return `Creating diagram: ${tool.title}`;
        case 'create_drawing': return `Drawing: ${tool.title}`;
        case 'create_floor_plan': return `Designing floor plan: ${tool.title}`;
        case 'architecture_reference': return `Consulting design references${tool.query ? `: ${tool.query}` : ''}`;
        case 'copy_file':      return `Copying ${tool.source} → ${tool.destination}`;
        case 'create_presentation': return `Building presentation: ${tool.path ?? tool.title}`;
        case 'remember':       return `Saving to memory: ${String(tool.note ?? '').slice(0, 80)}`;
        case 'git_status':     return 'Checking git status';
        case 'git_push':       return 'Pushing to remote';
        case 'flag_related_locations': return 'Checking for related locations';
        default:               return tool.action;
    }
}
