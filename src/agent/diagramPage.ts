// Page builders for create_diagram (Mermaid) and create_drawing (SVG). No
// vscode import, so they can be unit-tested directly.
//
// Both pages share one viewer: the drawing is measured at its natural size,
// fitted to the preview pane, and can be zoomed (wheel / buttons / + -), panned
// (drag) and refitted (Fit / double-click / 0). The previous page let Mermaid
// shrink a wide diagram to the pane's width with no way to zoom, which left a
// 15-node layout at an unreadable size in a side-by-side preview.

import { MERMAID_THEME_SCRIPT } from './mermaidTheme';

export const escapeHtml = (s: string): string =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const VIEWER_CSS = `
    html, body { height: 100%; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #1e1e2e; color: #cdd6f4; margin: 0; display: flex; flex-direction: column; }
    header { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 10px 16px; flex-shrink: 0; }
    h1 { font-size: 1.1rem; margin: 0; color: #89b4fa; font-weight: 600; }
    .tools { display: flex; align-items: center; gap: 6px; font-size: 0.8rem; }
    .tools button { background: #313244; color: #cdd6f4; border: 1px solid #45475a; border-radius: 6px; padding: 3px 9px; cursor: pointer; font: inherit; }
    .tools button:hover { background: #45475a; }
    .tools button:focus-visible { outline: 2px solid #89b4fa; outline-offset: 1px; }
    #zl { min-width: 3.2em; text-align: center; opacity: 0.8; }
    #vp { flex: 1; position: relative; overflow: hidden; background: #181825; cursor: grab; touch-action: none; }
    #vp.dragging { cursor: grabbing; }
    /* Drawings are authored for paper (dark strokes, light fills), so show them on white. */
    #vp.paper { background: #fff; }
    #vp.paper + .hint, #vp.paper .hint { color: #1e1e2e; }
    #stage { position: absolute; left: 0; top: 0; transform-origin: 0 0; }
    #stage svg { display: block; }
    .hint { position: absolute; right: 12px; bottom: 8px; font-size: 0.72rem; opacity: 0.45; pointer-events: none; }
`;

const VIEWER_JS = `
(function () {
  var vp = document.getElementById('vp'), stage = document.getElementById('stage'), zl = document.getElementById('zl');
  var s = 1, tx = 0, ty = 0, nat = null, touched = false;
  function measure() {
    var svg = stage.querySelector('svg'); if (!svg) return null;
    var vb = svg.viewBox && svg.viewBox.baseVal, w, h;
    if (vb && vb.width && vb.height) { w = vb.width; h = vb.height; }
    else { var bb = svg.getBBox(); w = bb.x + bb.width; h = bb.y + bb.height; }
    svg.removeAttribute('style'); svg.setAttribute('width', w); svg.setAttribute('height', h);
    return { w: w, h: h };
  }
  function apply() { stage.style.transform = 'translate(' + tx + 'px,' + ty + 'px) scale(' + s + ')'; zl.textContent = Math.round(s * 100) + '%'; }
  function fit() {
    if (!nat) return;
    var pad = 24;
    s = Math.min((vp.clientWidth - pad * 2) / nat.w, (vp.clientHeight - pad * 2) / nat.h, 2);
    tx = (vp.clientWidth - nat.w * s) / 2; ty = (vp.clientHeight - nat.h * s) / 2; apply();
  }
  function zoomAt(f, cx, cy) {
    var ns = Math.max(0.1, Math.min(8, s * f)); touched = true;
    tx = cx - (cx - tx) * (ns / s); ty = cy - (cy - ty) * (ns / s); s = ns; apply();
  }
  function center() { return [vp.clientWidth / 2, vp.clientHeight / 2]; }
  function actual() { touched = true; var c = center(); zoomAt(1 / s, c[0], c[1]); }
  vp.addEventListener('wheel', function (e) {
    e.preventDefault(); var r = vp.getBoundingClientRect();
    zoomAt(e.deltaY < 0 ? 1.12 : 1 / 1.12, e.clientX - r.left, e.clientY - r.top);
  }, { passive: false });
  var drag = null;
  vp.addEventListener('pointerdown', function (e) { drag = { x: e.clientX, y: e.clientY, tx: tx, ty: ty }; vp.setPointerCapture(e.pointerId); vp.classList.add('dragging'); });
  vp.addEventListener('pointermove', function (e) { if (!drag) return; touched = true; tx = drag.tx + e.clientX - drag.x; ty = drag.ty + e.clientY - drag.y; apply(); });
  function endDrag() { drag = null; vp.classList.remove('dragging'); }
  vp.addEventListener('pointerup', endDrag); vp.addEventListener('pointercancel', endDrag);
  vp.addEventListener('dblclick', function () { touched = false; fit(); });
  document.getElementById('zi').onclick = function () { var c = center(); zoomAt(1.25, c[0], c[1]); };
  document.getElementById('zo').onclick = function () { var c = center(); zoomAt(0.8, c[0], c[1]); };
  document.getElementById('zf').onclick = function () { touched = false; fit(); };
  document.getElementById('z1').onclick = actual;
  document.addEventListener('keydown', function (e) {
    var c = center();
    if (e.key === '+' || e.key === '=') zoomAt(1.25, c[0], c[1]);
    else if (e.key === '-') zoomAt(0.8, c[0], c[1]);
    else if (e.key === '0') { touched = false; fit(); }
    else if (e.key === '1') actual();
  });
  window.addEventListener('resize', function () { if (!touched) fit(); });
  window.__viewerReady = function () { nat = measure(); fit(); };
  // Renders the drawing to a PNG (white background, capped at ~1600px) and posts it
  // to the extension, so create_drawing can show the model what it actually drew.
  // Only runs inside a VS Code webview; a no-op when the file is opened in a browser.
  window.__rasterize = function () {
    var svg = stage.querySelector('svg');
    if (!svg || !nat || typeof acquireVsCodeApi !== 'function') return;
    var api = window.__vsapi || (window.__vsapi = acquireVsCodeApi());
    var scale = Math.min(2, 1600 / Math.max(nat.w, nat.h));
    var xml = new XMLSerializer().serializeToString(svg);
    if (!/xmlns=/.test(xml.slice(0, 300))) xml = xml.replace('<svg', '<svg xmlns="http://www.w3.org/2000/svg"');
    var img = new Image();
    img.onload = function () {
      try {
        var c = document.createElement('canvas');
        c.width = Math.max(1, Math.round(nat.w * scale)); c.height = Math.max(1, Math.round(nat.h * scale));
        var ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
        ctx.drawImage(img, 0, 0, c.width, c.height);
        api.postMessage({ type: 'raster', png: c.toDataURL('image/png') });
      } catch (e) { api.postMessage({ type: 'raster-error', message: String(e && e.message || e) }); }
    };
    img.onerror = function () { api.postMessage({ type: 'raster-error', message: 'The SVG could not be rendered (malformed markup?)' }); };
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(xml);
  };
})();
`;

function shell(title: string, content: string, scripts: string, paper = false): string {
    const t = escapeHtml(title);
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${t}</title>
  <style>${VIEWER_CSS}</style>
</head>
<body>
  <header>
    <h1>${t}</h1>
    <div class="tools" role="toolbar" aria-label="Zoom">
      <button id="zo" title="Zoom out (-)" aria-label="Zoom out">&minus;</button>
      <span id="zl" aria-live="polite">100%</span>
      <button id="zi" title="Zoom in (+)" aria-label="Zoom in">+</button>
      <button id="zf" title="Fit to window (0 or double-click)">Fit</button>
      <button id="z1" title="Actual size (1)">100%</button>
    </div>
  </header>
  <main id="vp"${paper ? ' class="paper"' : ''}><div id="stage">${content}</div><span class="hint">Scroll to zoom &middot; drag to pan &middot; double-click to fit</span></main>
  <script>${VIEWER_JS}<\/script>
${scripts}
</body>
</html>`;
}

export function mermaidPage(title: string, mermaid: string): string {
    return shell(
        title,
        `<div class="mermaid">\n${mermaid}\n  </div>`,
        `  <script src="https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js"><\/script>
  <script>
    ${MERMAID_THEME_SCRIPT}
    freebirdMermaidInit('dark');
    mermaid.run({ querySelector: '.mermaid' }).then(function () { window.__viewerReady(); }, function () { window.__viewerReady(); });
  <\/script>`
    );
}

export function svgPage(title: string, svg: string): string {
    return shell(title, svg, `  <script>window.__viewerReady(); window.__rasterize();<\/script>`, true);
}

/**
 * Returns a problem description if the SVG is unusable or unsafe, else null.
 * The preview webview runs scripts, so model-written SVG must not carry any.
 */
export function checkSvg(svg: string): string | null {
    const s = svg.trim();
    if (!/^(<\?xml[^>]*\?>\s*)?(<!--[\s\S]*?-->\s*)*<svg[\s>]/i.test(s) || !/<\/svg>\s*$/i.test(s)) {
        return 'must be a single complete <svg>…</svg> element';
    }
    if (/<script|<foreignObject|<iframe|<object|<embed|<!ENTITY|<!DOCTYPE/i.test(s)) {
        return 'must not contain <script>, <foreignObject>, <iframe>, <object>, <embed> or entity declarations';
    }
    if (/<[^>]*\son[a-z]+\s*=|javascript:|data:text\/html/i.test(s)) {
        return 'must not contain event handlers or javascript: URLs';
    }
    return null;
}
