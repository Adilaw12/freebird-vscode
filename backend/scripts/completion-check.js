// scripts/completion-check.js — runs real tab-completion prompts through the
// live chat endpoint and reports how often it comes back empty, how fast it
// replies, and what it wrote, so the cloud completion model can be judged on
// your own code before completions are turned on for anyone.
//
// Usage:
//   node scripts/completion-check.js cases.json [--out results.json]
//
// cases.json is an array of { "file", "language", "prefix", "suffix" }, where
// prefix is the code before the cursor and suffix is the code after it. See
// scripts/completion-cases.example.json. Use real code from your own editing.
//
// Environment:
//   FREEBIRD_URL          default https://freebird-backend.vercel.app
//   FREEBIRD_LICENSE_KEY  optional; set it to test the Pro path (paid completions)
//
// Results include the completions themselves, so keep --out files out of git.
// Requires Node 18+ (built-in fetch).

import { readFileSync, writeFileSync } from 'fs';
import { randomUUID } from 'crypto';

// Matches the system prompt and user message the extension sends for tab
// completions (src/inline/completionProvider.ts), so the results are comparable.
const COMPLETION_SYSTEM_PROMPT =
    'You are a code-completion engine. Reply with ONLY the text to insert at <CURSOR>: no explanation, no markdown fences, ' +
    'never repeat surrounding code. Always give your best short continuation (finish the current line, or write the next ' +
    'line or two). Output nothing only if the file is clearly complete.';

const BASE_URL = process.env.FREEBIRD_URL || 'https://freebird-backend.vercel.app';
const LICENSE_KEY = process.env.FREEBIRD_LICENSE_KEY || undefined;
const PAUSE_MS = 400; // one request at a time, roughly like typing

const args = process.argv.slice(2);
const casesPath = args.find(a => !a.startsWith('--'));
const outIndex = args.indexOf('--out');
const outPath = outIndex >= 0 ? args[outIndex + 1] : null;

if (!casesPath) {
    console.error('Usage: node scripts/completion-check.js cases.json [--out results.json]');
    process.exit(1);
}

const cases = JSON.parse(readFileSync(casesPath, 'utf8'));
if (!Array.isArray(cases) || cases.length === 0) {
    console.error('cases.json must be a non-empty array of { file, language, prefix, suffix }.');
    process.exit(1);
}

const sessionId = randomUUID();
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function runCase(c) {
    const body = {
        messages: [
            { role: 'system', content: COMPLETION_SYSTEM_PROMPT },
            { role: 'user', content: `File: ${c.file} (${c.language})\n\n${c.prefix}<CURSOR>${c.suffix}` }
        ],
        sessionId,
        licenseKey: LICENSE_KEY,
        maxTokens: 128,
        isTabCompletion: true
    };

    const started = Date.now();
    let firstChunkAt = null;
    try {
        const res = await fetch(`${BASE_URL}/api/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(30_000)
        });
        if (!res.ok) {
            const errText = await res.text().catch(() => '');
            return { ok: false, status: res.status, error: errText.slice(0, 200), totalMs: Date.now() - started };
        }
        let text = '';
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (firstChunkAt === null) firstChunkAt = Date.now();
            text += decoder.decode(value, { stream: true });
        }
        const totalMs = Date.now() - started;
        const modelUsed = res.headers.get('X-Model-Used') || 'unknown';
        return {
            ok: true,
            status: res.status,
            modelUsed,
            text,
            empty: text.trim() === '',
            ttfbMs: firstChunkAt === null ? null : firstChunkAt - started,
            totalMs
        };
    } catch (err) {
        return { ok: false, error: err?.message || String(err), totalMs: Date.now() - started };
    }
}

function percentile(values, p) {
    if (values.length === 0) return null;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

const results = [];
for (let i = 0; i < cases.length; i++) {
    const c = cases[i];
    const r = await runCase(c);
    results.push({ file: c.file, language: c.language, ...r });
    const label = `${i + 1}/${cases.length} ${c.file}`;
    if (!r.ok) {
        console.log(`ERROR  ${label}  status=${r.status ?? '-'}  ${r.error}`);
    } else if (r.empty) {
        console.log(`EMPTY  ${label}  model=${r.modelUsed}  total=${r.totalMs}ms`);
    } else {
        console.log(`OK     ${label}  model=${r.modelUsed}  ttfb=${r.ttfbMs}ms  total=${r.totalMs}ms`);
    }
    await sleep(PAUSE_MS);
}

const ok = results.filter(r => r.ok);
const empty = ok.filter(r => r.empty);
const totals = ok.map(r => r.totalMs);
const ttfbs = ok.map(r => r.ttfbMs).filter(v => v !== null);
const models = [...new Set(ok.map(r => r.modelUsed))];

console.log('\n--- summary ---');
console.log(`cases:          ${results.length}`);
console.log(`errors:         ${results.length - ok.length}`);
console.log(`empty replies:  ${empty.length} of ${ok.length} (${ok.length ? Math.round((100 * empty.length) / ok.length) : 0}%)`);
console.log(`models seen:    ${models.join(', ') || 'none'}`);
console.log(`ttfb p50/p95:   ${percentile(ttfbs, 50)}ms / ${percentile(ttfbs, 95)}ms`);
console.log(`total p50/p95:  ${percentile(totals, 50)}ms / ${percentile(totals, 95)}ms`);
console.log('\nNow read the non-empty completions yourself: the numbers say whether it replies, not whether the code is any good.');

if (outPath) {
    writeFileSync(outPath, JSON.stringify(results, null, 2));
    console.log(`Full results written to ${outPath}`);
}
