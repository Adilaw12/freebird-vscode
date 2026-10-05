import * as vscode from 'vscode';
import { trackEvent } from './telemetry';

const LAST_SEEN_KEY = 'freebird.whatsNewLastSeenVersion';
const WALKTHROUGH_SHOWN_KEY = 'freebird.walkthroughShown';
const CHANGELOG_URL = 'https://github.com/Adilaw12/freebird-vscode/blob/master/CHANGELOG.md';

interface Highlight {
    title: string;
    body: string;
    /** Path relative to the extension root, e.g. 'media/foo.png'. Optional. */
    image?: string;
    /** Optional command id rendered as a button under the highlight. */
    command?: { id: string; label: string };
}

interface ReleaseNotes {
    heading: string;
    highlights: Highlight[];
}

// Curated notes, keyed by "major.minor". Patch releases never open this page —
// add an entry here only when a minor/major release has something worth
// showing. A minor with no entry here is silently skipped.
const RELEASE_NOTES: Record<string, ReleaseNotes> = {
    '0.14': {
        heading: 'What’s new in Freebird 0.14',
        highlights: [
            {
                title: 'Try Agent mode free',
                body: 'You get 3 free Agent-mode runs (5 on your own API key) — no trial to start. Type /agent followed by what you want done, or use the Run as agent button when you reference several files. Every run has a checkpoint, so you can undo it in one click.',
            },
            {
                title: 'Every prompt template, free for 7 days',
                body: 'The whole Template Library is unlocked for your first week — migrations, audits, reviews, docs, DevOps and more.',
                command: { id: 'freebird.usePromptTemplate', label: 'Browse templates' },
            },
            {
                title: 'Your API keys are now stored securely',
                body: 'Keys live in VS Code’s secure storage — one per provider, never in settings.json. Existing keys are moved automatically.',
                command: { id: 'freebird.setApiKey', label: 'Set API key' },
            },
            {
                title: 'Your own key now works in chat, too',
                body: 'Chat with a BYOK provider goes straight to your own account and never counts against the free daily limit. Streaming is also more reliable: responses no longer lose text when a network chunk splits mid-line.',
            },
        ],
    },
    '0.13': {
        heading: 'What’s new in Freebird 0.13',
        highlights: [
            {
                title: 'Try Pro free for 7 days — no sign-in',
                body: 'The trial no longer asks you to sign in with GitHub. One click starts it.',
                command: { id: 'freebird.startTrial', label: 'Start free trial' },
            },
            {
                title: 'Agent mode checks its own diagrams',
                body: 'Mermaid diagrams are now rendered and visually verified before Agent mode tells you they’re done, so a broken layout gets fixed instead of shipped.',
                image: 'media/Mermaid diagram_.jpeg',
            },
            {
                title: 'Faster tab completions on the free tier',
                body: 'Completions try a much faster inference backend first and fall back automatically, so they feel quicker without any setup.',
            },
            {
                title: 'Keep files out of the agent’s reach',
                body: 'Every agent tool now respects your .gitignore, plus an optional .freebirdignore for exclusions that don’t belong in git.',
            },
        ],
    },
};

function minorOf(version: string): string {
    const [major, minor] = version.split('.');
    return `${major}.${minor}`;
}

/**
 * Opens the What's New page once after an update that changes the major or
 * minor version. Never shows on a brand-new install (the onboarding
 * walkthrough covers that), on patch releases, or when the user has turned
 * `freebird.showWhatsNew` off. Must run BEFORE the walkthrough block sets its
 * own flag, since that flag is how we tell an existing user from a new one.
 */
export function maybeShowWhatsNew(context: vscode.ExtensionContext): void {
    const current = context.extension.packageJSON.version as string;
    const lastSeen = context.globalState.get<string>(LAST_SEEN_KEY);
    const isExistingUser = !!context.globalState.get<boolean>(WALKTHROUGH_SHOWN_KEY);

    context.globalState.update(LAST_SEEN_KEY, current);

    if (lastSeen === undefined && !isExistingUser) return; // fresh install
    if (lastSeen !== undefined && minorOf(lastSeen) === minorOf(current)) return;
    if (!vscode.workspace.getConfiguration('freebird').get<boolean>('showWhatsNew', true)) return;

    showWhatsNew(context, true);
}

export function showWhatsNew(context: vscode.ExtensionContext, automatic = false): void {
    const current = context.extension.packageJSON.version as string;
    const notes = RELEASE_NOTES[minorOf(current)];
    if (!notes) {
        if (!automatic) vscode.env.openExternal(vscode.Uri.parse(CHANGELOG_URL));
        return;
    }

    trackEvent(automatic ? 'whats_new_shown' : 'whats_new_opened');

    const panel = vscode.window.createWebviewPanel(
        'freebirdWhatsNew',
        `Freebird ${current} — What’s New`,
        vscode.ViewColumn.Active,
        {
            enableScripts: true,
            localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')],
        }
    );

    const imageUri = (rel: string) =>
        panel.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, ...rel.split('/'))).toString();
    panel.webview.html = render(panel.webview.cspSource, current, notes, imageUri);

    const allowedCommands = new Set(notes.highlights.map(h => h.command?.id).filter(Boolean));
    panel.webview.onDidReceiveMessage(async (msg) => {
        if (msg?.type === 'command' && allowedCommands.has(msg.id)) {
            trackEvent('whats_new_cta_clicked');
            vscode.commands.executeCommand(msg.id);
        } else if (msg?.type === 'changelog') {
            vscode.env.openExternal(vscode.Uri.parse(CHANGELOG_URL));
        } else if (msg?.type === 'setShow' && typeof msg.value === 'boolean') {
            await vscode.workspace.getConfiguration('freebird').update('showWhatsNew', msg.value, vscode.ConfigurationTarget.Global);
        }
    });
}

const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

function render(cspSource: string, version: string, notes: ReleaseNotes, imageUri: (rel: string) => string): string {
    const showing = vscode.workspace.getConfiguration('freebird').get<boolean>('showWhatsNew', true);
    const items = notes.highlights.map((h, i) => `
        <section id="h${i}">
            <h2>${esc(h.title)}</h2>
            <p>${esc(h.body)}</p>
            ${h.image ? `<img src="${imageUri(h.image)}" alt="${esc(h.title)}">` : ''}
            ${h.command ? `<button data-cmd="${esc(h.command.id)}">${esc(h.command.label)}</button>` : ''}
        </section>`).join('');

    const toc = notes.highlights.map((h, i) => `<a data-target="h${i}">${esc(h.title)}</a>`).join('');

    return `<!DOCTYPE html>
<html><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${cspSource}; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); margin: 0; padding: 24px 20px 48px; line-height: 1.55; }
  .layout { display: flex; gap: 40px; max-width: 1040px; margin: 0 auto; }
  nav { position: sticky; top: 24px; align-self: flex-start; width: 200px; flex-shrink: 0; font-size: 0.9em; }
  nav h3 { margin: 0 0 10px; font-size: 0.8em; letter-spacing: 0.06em; text-transform: uppercase; color: var(--vscode-descriptionForeground); }
  nav a { display: block; padding: 4px 0; }
  main { min-width: 0; max-width: 760px; flex: 1; }
  @media (max-width: 760px) { nav { display: none; } }
  h1 { font-weight: 500; border-bottom: 1px solid var(--vscode-panel-border); padding-bottom: 12px; }
  h2 { font-size: 1.15em; margin: 28px 0 6px; }
  p { margin: 0 0 10px; color: var(--vscode-descriptionForeground); }
  img { max-width: 100%; border-radius: 6px; border: 1px solid var(--vscode-panel-border); margin: 6px 0 4px; }
  button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: 0; padding: 6px 14px; border-radius: 2px; cursor: pointer; }
  button:hover { background: var(--vscode-button-hoverBackground); }
  a { color: var(--vscode-textLink-foreground); cursor: pointer; }
  label { display: block; margin-top: 36px; font-size: 0.9em; }
</style></head>
<body>
<div class="layout">
  <nav><h3>In this update</h3>${toc}<a id="changelog-nav">Full changelog</a></nav>
  <main>
  <h1>${esc(notes.heading)}</h1>
  ${items}
  <p style="margin-top:32px"><a id="changelog">View the full changelog</a> (v${esc(version)})</p>
  <label><input type="checkbox" id="show" ${showing ? 'checked' : ''}> Show release notes after an update</label>
  </main>
</div>
<script>
  const vscode = acquireVsCodeApi();
  document.querySelectorAll('button[data-cmd]').forEach(b => b.addEventListener('click', () => vscode.postMessage({ type: 'command', id: b.dataset.cmd })));
  ['changelog', 'changelog-nav'].forEach(id => document.getElementById(id).addEventListener('click', () => vscode.postMessage({ type: 'changelog' })));
  document.querySelectorAll('nav a[data-target]').forEach(a => a.addEventListener('click', () => document.getElementById(a.dataset.target).scrollIntoView({ behavior: 'smooth' })));
  document.getElementById('show').addEventListener('change', e => vscode.postMessage({ type: 'setShow', value: e.target.checked }));
</script>
</body></html>`;
}
