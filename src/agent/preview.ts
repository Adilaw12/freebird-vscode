import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

let _panel: vscode.WebviewPanel | undefined;
let _lastFile: string | undefined;
let _saveListener: vscode.Disposable | undefined;

export interface PreviewRaster {
    image?: { mimeType: string; base64: string };
    error?: string;
}
// Resolver for the one create_drawing call currently waiting on the page to
// rasterise itself (see window.__rasterize in diagramPage.ts).
let _rasterWaiter: ((r: PreviewRaster) => void) | undefined;
const MAX_RASTER_BYTES = 6 * 1024 * 1024;
const PNG_PREFIX = 'data:image/png;base64,';

function onPanelMessage(msg: any): void {
    if (!_rasterWaiter) return; // an unsolicited re-render (e.g. after a file save) — nobody is waiting
    if (msg?.type === 'raster' && typeof msg.png === 'string' && msg.png.startsWith(PNG_PREFIX)) {
        const base64 = msg.png.slice(PNG_PREFIX.length);
        _rasterWaiter(base64.length * 0.75 > MAX_RASTER_BYTES
            ? { error: 'Rendered image was unexpectedly large — skipping visual check.' }
            : { image: { mimeType: 'image/png', base64 } });
    } else if (msg?.type === 'raster-error') {
        _rasterWaiter({ error: typeof msg.message === 'string' ? msg.message.slice(0, 300) : 'render failed' });
    }
}

/**
 * Opens the preview, then waits for the drawing page to send back a rendered PNG
 * so the model can look at what it drew. The browser engine does the rendering
 * (system fonts included), so there is no rasteriser dependency to ship.
 */
export function previewHtmlFileWithRaster(fullPath: string, timeoutMs = 8000): Promise<PreviewRaster> {
    return new Promise(resolve => {
        const timer = setTimeout(() => { _rasterWaiter = undefined; resolve({ error: 'timed out waiting for the preview to render' }); }, timeoutMs);
        _rasterWaiter = r => { clearTimeout(timer); _rasterWaiter = undefined; resolve(r); };
        previewHtmlFile(fullPath);
    });
}

// Opens (or reuses) a webview tab rendering the given HTML file. Relative
// <link>/<script>/<img> URLs are rewritten to webview URIs so local CSS/JS/images
// load correctly. Re-renders automatically whenever any file is saved, so editing
// the HTML/CSS and hitting save refreshes the preview — no Live Server needed.
export function previewHtmlFile(fullPath: string): void {
    if (!_panel) {
        const roots = (vscode.workspace.workspaceFolders ?? []).map(f => f.uri);
        _panel = vscode.window.createWebviewPanel(
            'freebird.preview',
            'Freebird Preview',
            vscode.ViewColumn.Beside,
            { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: roots }
        );
        _panel.webview.onDidReceiveMessage(onPanelMessage);
        _panel.onDidDispose(() => {
            _panel = undefined;
            _lastFile = undefined;
            _saveListener?.dispose();
            _saveListener = undefined;
        });
        _saveListener = vscode.workspace.onDidSaveTextDocument(() => {
            if (_panel && _lastFile) render(_panel, _lastFile);
        });
    }

    _lastFile = fullPath;
    _panel.title = `Preview: ${path.basename(fullPath)}`;
    render(_panel, fullPath);
    _panel.reveal(vscode.ViewColumn.Beside, true);
}

function render(panel: vscode.WebviewPanel, fullPath: string): void {
    const html = fs.readFileSync(fullPath, 'utf8');
    const dir = vscode.Uri.file(path.dirname(fullPath));
    panel.webview.html = rewriteResourceUris(html, panel.webview, dir);
}

// Rewrites relative src/href attributes to webview-accessible URIs.
function rewriteResourceUris(html: string, webview: vscode.Webview, baseDir: vscode.Uri): string {
    return html.replace(/(src|href)=(["'])([^"']*)\2/gi, (match, attr, quote, relPath) => {
        if (!relPath || /^(https?:|\/\/|data:|#|mailto:|tel:|vscode-webview:)/i.test(relPath)) {
            return match;
        }
        try {
            const uri = webview.asWebviewUri(vscode.Uri.joinPath(baseDir, relPath));
            return `${attr}=${quote}${uri}${quote}`;
        } catch {
            return match;
        }
    });
}
