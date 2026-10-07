#!/usr/bin/env node
// eval/floorplan/run.js — scores Freebird's floor-plan flow against a fixed set of briefs.
//
//   FB_KEY=<licence key> node eval/floorplan/run.js [--model pro|fast] [--only id,id] [--repeat N] [--timeout S] [--out file]
//
// What it does: for each brief it runs the REAL agent loop (the compiled out/ code, so run
// `npm run compile` first) against the live Freebird backend, then re-reads the plan the run saved,
// re-validates it with the same validator the tool uses, and checks it against the brief's
// expectations. The point is a number you can compare before and after a change — a prompt edit, a
// new rule, a different model — instead of judging single runs by eye.
//
//   --model pro   (default) the product path: Sonnet, low effort. Spends the licence's monthly Pro
//                 allowance (about 8 requests per brief) — don't run the full set casually.
//   --model fast  the Haiku path: no Pro allowance, much less reliable on this task.
//
// Results go to eval/floorplan/results/ (git-ignored). Compare two runs with compare.js.

const path = require('path');
const fs = require('fs');
const os = require('os');

const root = path.resolve(__dirname, '..', '..');
const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf('--' + name); return i >= 0 ? args[i + 1] : def; };
const model = opt('model', 'pro');
const only = opt('only', '') ? opt('only').split(',') : null;
const repeat = Number(opt('repeat', '1'));
const timeoutS = Number(opt('timeout', '300'));

if (!process.env.FB_KEY) { console.error('Set FB_KEY to a Freebird licence key (it is used for this run only and is not written anywhere).'); process.exit(1); }
if (!['pro', 'fast'].includes(model)) { console.error('--model must be pro or fast'); process.exit(1); }
if (!fs.existsSync(path.join(root, 'out', 'agent', 'loop.js'))) { console.error('out/ is missing — run `npm run compile` first.'); process.exit(1); }

const vscode = require(path.join(root, 'test', 'bootstrap.js'));
const { makeFakeContext } = require(path.join(root, 'test', 'helpers.js'));
const { parsePlan, validatePlan } = require(path.join(root, 'out', 'architecture', 'plan.js'));

// The preview needs a real webview; the tool only opens it, so stub it.
const previewPath = path.join(root, 'out', 'agent', 'preview.js');
require.cache[require.resolve(previewPath)] = { id: previewPath, filename: previewPath, loaded: true,
    exports: { previewHtmlFile() {}, previewHtmlFileWithRaster: async () => ({ error: 'headless run' }) } };
const { runAgentLoop } = require(path.join(root, 'out', 'agent', 'loop.js'));
const { CloudProvider } = require(path.join(root, 'out', 'ai', 'cloud.js'));

if (model === 'fast') {
    const original = CloudProvider.prototype.stream;
    CloudProvider.prototype.stream = function (m, c, opts) { return original.call(this, m, c, { ...opts, premium: false }); };
}

const briefs = JSON.parse(fs.readFileSync(path.join(__dirname, 'briefs.json'), 'utf8')).filter(b => !only || only.includes(b.id));
if (!briefs.length) { console.error('No briefs matched --only.'); process.exit(1); }

const countType = (plan, types) => plan.rooms.filter(r => types.includes(r.type)).length;

function check(plan, validation, expect = {}) {
    const problems = [];
    if (expect.buildingType && plan.brief.buildingType !== expect.buildingType) problems.push(`building type is ${plan.brief.buildingType}, expected ${expect.buildingType}`);
    if (expect.bedrooms !== undefined) {
        const n = countType(plan, ['bedroom', 'master_bedroom']);
        if (n !== expect.bedrooms) problems.push(`${n} bedrooms, expected ${expect.bedrooms}`);
    }
    for (const [type, n] of Object.entries(expect.roomCounts ?? {})) {
        const have = countType(plan, [type]);
        if (have !== n) problems.push(`${have} ${type} rooms, expected ${n}`);
    }
    for (const type of expect.mustInclude ?? []) if (!countType(plan, [type])) problems.push(`no ${type} room`);
    if (expect.area) {
        const a = validation.internalArea;
        if (a < expect.area[0] || a > expect.area[1]) problems.push(`internal area ${a.toFixed(0)} m² outside ${expect.area[0]}–${expect.area[1]} m²`);
    }
    return problems;
}

async function runBrief(brief) {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-eval-'));
    vscode.workspace.workspaceFolders = [{ uri: { fsPath: workspace }, name: 'eval', index: 0 }];
    vscode.__setMockConfig({ 'freebird.licenseKey': process.env.FB_KEY, 'freebird.backend': 'cloud' });

    const ctx = makeFakeContext();
    ctx.extension = { packageJSON: { version: 'eval' } };
    const provider = new CloudProvider(ctx, 'eval-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6));

    const t0 = Date.now();
    let attempts = 0, rejected = 0, requests = 0, error = null, firstPlanAt = null, savedAt = null, toolErrors = 0;
    const loop = runAgentLoop({
        userMessage: brief.prompt, history: [], provider, git: {}, context: ctx, sessionId: 'eval', maxIterations: 14,
        onApprovalNeeded: async () => true,
        onEvent: e => {
            if (e.type === 'iteration-start') requests++;
            else if (e.type === 'tool-start' && e.tool.action === 'create_floor_plan') { attempts++; if (firstPlanAt === null) firstPlanAt = (Date.now() - t0) / 1000; }
            else if (e.type === 'tool-result') {
                if (!e.success) toolErrors++;
                if (e.tool.action === 'create_floor_plan') {
                    if (String(e.output).startsWith('NOT DRAWN')) rejected++;
                    else if (e.success && savedAt === null) savedAt = (Date.now() - t0) / 1000;
                }
            }
        }
    }).catch(err => { error = (err.code ? err.code + ': ' : '') + err.message; });

    const timer = new Promise(resolve => setTimeout(() => resolve('timeout'), timeoutS * 1000));
    const outcome = await Promise.race([loop.then(() => 'done'), timer]);
    if (outcome === 'timeout') error = `timed out after ${timeoutS}s`;
    const seconds = (Date.now() - t0) / 1000;

    // Read back the plan that was actually saved and judge it independently of the model's say-so.
    const result = { id: brief.id, model, success: false, seconds: +seconds.toFixed(1), requests, attempts, rejected, toolErrors, error,
        timeToFirstPlan: firstPlanAt === null ? null : +firstPlanAt.toFixed(1), timeToValidPlan: savedAt === null ? null : +savedAt.toFixed(1),
        warnings: [], notes: 0, problems: [], rooms: 0, internalArea: 0 };
    try {
        const dir = path.join(workspace, 'diagrams');
        const file = fs.existsSync(dir) ? fs.readdirSync(dir).find(f => f.endsWith('.plan.json')) : undefined;
        if (file) {
            const parsed = parsePlan(JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')));
            if (parsed.plan) {
                const v = validatePlan(parsed.plan);
                result.success = v.errors.length === 0;
                result.warnings = v.warnings;
                result.notes = v.notes.length;
                result.rooms = parsed.plan.rooms.length;
                result.internalArea = +v.internalArea.toFixed(1);
                result.problems = check(parsed.plan, v, brief.expect);
            }
        }
    } catch (err) { result.error = (result.error ? result.error + '; ' : '') + 'could not read saved plan: ' + err.message; }
    result.pass = result.success && result.problems.length === 0;
    return result;
}

(async () => {
    const results = [];
    console.log(`Floor-plan eval — model: ${model}, briefs: ${briefs.length}${repeat > 1 ? ' × ' + repeat : ''}, timeout ${timeoutS}s each\n`);
    for (let r = 0; r < repeat; r++) {
        for (const brief of briefs) {
            const res = await runBrief(brief);
            results.push(res);
            const status = res.pass ? 'PASS' : res.success ? 'WEAK' : 'FAIL';
            console.log(`${status}  ${brief.id.padEnd(20)} ${String(res.seconds).padStart(6)}s  req ${String(res.requests).padStart(2)}  plans ${res.attempts} (${res.rejected} rejected)  warnings ${res.warnings.length}` +
                (res.problems.length ? `\n      brief: ${res.problems.join('; ')}` : '') + (res.error ? `\n      error: ${res.error}` : ''));
        }
    }
    const n = results.length, pass = results.filter(r => r.pass).length, ok = results.filter(r => r.success).length;
    const mean = a => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
    const times = results.filter(r => r.timeToValidPlan !== null).map(r => r.timeToValidPlan);
    const summary = {
        model, runs: n, passRate: +(pass / n).toFixed(2), validRate: +(ok / n).toFixed(2),
        meanSecondsToValidPlan: +mean(times).toFixed(1), meanRequests: +mean(results.map(r => r.requests)).toFixed(1),
        meanRejectedPlans: +mean(results.map(r => r.rejected)).toFixed(1), meanWarnings: +mean(results.map(r => r.warnings.length)).toFixed(1)
    };
    console.log('\nSummary:', JSON.stringify(summary));
    const outFile = opt('out', path.join(__dirname, 'results', `${new Date().toISOString().replace(/[:.]/g, '-')}-${model}.json`));
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.writeFileSync(outFile, JSON.stringify({ when: new Date().toISOString(), summary, results }, null, 2));
    console.log('Saved', path.relative(root, outFile));
    process.exit(0);
})();
