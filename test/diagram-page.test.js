// test/diagram-page.test.js — out/agent/diagramPage.js (the shared zoom/pan
// viewer for create_diagram and create_drawing, plus the SVG safety check) and
// the create_drawing tool's validation paths via executeToolCall.
//
// checkSvg gates model-written SVG that is then rendered in a webview that runs
// scripts, so the rejection cases are the part that matters.

require('./bootstrap');
const path = require('path');
const { suite, check, checkAsync } = require('./helpers');

const OUT = path.join(__dirname, '..', 'out');
const { mermaidPage, svgPage, checkSvg, escapeHtml } = require(path.join(OUT, 'agent/diagramPage.js'));
const { MERMAID_THEME_SCRIPT } = require(path.join(OUT, 'agent/mermaidTheme.js'));
const vm = require('vm');
const { executeToolCall, NATIVE_TOOL_SCHEMAS } = require(path.join(OUT, 'agent/tools.js'));

const GOOD = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 300"><rect x="10" y="10" width="380" height="280" fill="none" stroke="#000"/><text x="20" y="40">Kitchen 4.2 x 3.6 m</text></svg>';

async function run() {
    suite('checkSvg: accepts a plain, complete SVG');
    check('a normal floor-plan style svg passes', checkSvg(GOOD) === null);
    check('an xml declaration and leading comment are fine', checkSvg('<?xml version="1.0"?>\n<!-- plan -->\n' + GOOD) === null);

    suite('checkSvg: rejects anything that could run script or is not an svg');
    check('<script> rejected', checkSvg('<svg viewBox="0 0 1 1"><script>alert(1)</script></svg>') !== null);
    check('onload handler rejected', checkSvg('<svg viewBox="0 0 1 1" onload="alert(1)"></svg>') !== null);
    check('onclick on a child rejected', checkSvg('<svg viewBox="0 0 1 1"><rect onclick="x()"/></svg>') !== null);
    check('javascript: URL rejected', checkSvg('<svg viewBox="0 0 1 1"><a href="javascript:alert(1)"><rect/></a></svg>') !== null);
    check('foreignObject rejected', checkSvg('<svg viewBox="0 0 1 1"><foreignObject><div/></foreignObject></svg>') !== null);
    check('entity declaration rejected', checkSvg('<!DOCTYPE svg [<!ENTITY x "y">]><svg viewBox="0 0 1 1"/>') !== null);
    check('html that is not an svg rejected', checkSvg('<div>hello</div>') !== null);
    check('an unclosed svg rejected', checkSvg('<svg viewBox="0 0 1 1"><rect/>') !== null);
    check('text containing "on" in words is not mistaken for a handler', checkSvg(GOOD.replace('Kitchen', 'Conservatory one=two')) === null);

    suite('pages: both share the zoom/pan viewer');
    const sp = svgPage('Ground <Floor>', GOOD);
    check('svg page embeds the drawing', sp.includes('Kitchen 4.2 x 3.6 m'));
    check('title is escaped', sp.includes('Ground &lt;Floor&gt;') && !sp.includes('<title>Ground <Floor>'));
    check('has zoom controls and fit-on-load', ['id="zi"', 'id="zo"', 'id="zf"', 'id="z1"', 'window.__viewerReady();'].every(s => sp.includes(s)));
    const mp = mermaidPage('Auth', 'graph TD; A-->B;');
    check('svg page is shown on white paper, mermaid page is not', sp.includes('class="paper"') && !mermaidPage('x', 'graph TD; A-->B;').includes('class="paper"'));
    check('svg page rasterises itself for the model (and only inside a webview)', sp.includes('window.__rasterize();') && sp.includes("typeof acquireVsCodeApi !== 'function'"));
    check('raster is a white-background PNG posted back to the extension', sp.includes("fillStyle = '#fff'") && sp.includes("type: 'raster'") && sp.includes("type: 'raster-error'"));
    check('mermaid page embeds the source', mp.includes('graph TD; A-->B;'));
    check('mermaid is not auto-started, so the viewer can measure after render', mp.includes('startOnLoad: false') && mp.includes('mermaid.run('));
    check('mermaid page uses the same viewer', mp.includes('id="vp"') && mp.includes('__viewerReady'));
    check('escapeHtml neutralises markup', escapeHtml('<a&b>') === '&lt;a&amp;b&gt;');

    suite('mermaid house style: one script shared by the chat view and the preview page');
    check('theme script parses', (() => { try { new vm.Script(MERMAID_THEME_SCRIPT); return true; } catch { return false; } })());
    function initWith(mode, bodyClasses) {
        let captured = null;
        const ctx = { document: { body: { classList: { contains: c => bodyClasses.includes(c) } } }, mermaid: { initialize: cfg => { captured = cfg; } }, Object };
        vm.createContext(ctx);
        vm.runInContext(MERMAID_THEME_SCRIPT + '; freebirdMermaidInit(' + (mode ? JSON.stringify(mode) : '') + ');', ctx);
        return captured;
    }
    const dark = initWith('dark', []);
    check('uses the base theme with a custom palette, not the stock dark theme', dark.theme === 'base' && dark.themeVariables.primaryBorderColor === '#89b4fa');
    check('keeps the strict security level', dark.securityLevel === 'strict');
    check('forced dark mode is dark', dark.themeVariables.darkMode === true);
    check('forced light mode is light', initWith('light', []).themeVariables.darkMode === false);
    check('follows a light VS Code theme when no mode is forced', initWith(undefined, ['vscode-light']).themeVariables.darkMode === false);
    check('follows a dark VS Code theme when no mode is forced', initWith(undefined, ['vscode-dark']).themeVariables.darkMode === true);
    check('edge labels get a readable background, not a grey chip', dark.themeVariables.edgeLabelBackground === '#1e1e2e');
    check('preview page initialises with the shared style', mp.includes("freebirdMermaidInit('dark')") && mp.includes('function freebirdMermaidInit'));

    suite('create_drawing tool: schema and validation');
    check('create_drawing is offered as a native tool', NATIVE_TOOL_SCHEMAS.some(t => t.name === 'create_drawing'));
    const diag = NATIVE_TOOL_SCHEMAS.find(t => t.name === 'create_diagram');
    check('create_diagram steers floor plans away from Mermaid', /floor plan/i.test(diag.description) && /create_drawing/.test(diag.description));
    const call = tool => executeToolCall(tool, {}, async () => true, {}, 'test-session', 'test-turn');
    await checkAsync('requires title and svg', async () => {
        const r = await call({ action: 'create_drawing', title: 'x' });
        return r.success === false && /requires/i.test(r.output);
    });
    await checkAsync('rejects an unsafe svg before touching disk', async () => {
        const r = await call({ action: 'create_drawing', title: 'x', svg: '<svg viewBox="0 0 1 1"><script>1</script></svg>' });
        return r.success === false && /must not contain/i.test(r.output) && /create_drawing again/i.test(r.output);
    });
    await checkAsync('rejects non-svg input', async () => {
        const r = await call({ action: 'create_drawing', title: 'x', svg: 'graph TD; A-->B;' });
        return r.success === false && /complete <svg>/i.test(r.output);
    });
}

module.exports = { run };
