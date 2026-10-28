// backend/test/cerebras-stream.test.js — lib/cerebrasStream.js and lib/completionStats.js.
// Pure; run directly: `cd backend && node test/cerebras-stream.test.js`.

import { readCerebrasCompletion, emptyReason } from '../lib/cerebrasStream.js';
import { recordCompletionOutcomes } from '../lib/completionStats.js';

let passed = 0, failed = 0;
function check(label, cond) { if (cond) { passed++; console.log(`PASS — ${label}`); } else { failed++; console.log(`FAIL — ${label}`); } }

const enc = new TextEncoder();
/** A Response whose body arrives in the given raw string chunks. */
function sse(...chunks) {
    return new Response(new ReadableStream({
        start(controller) { for (const c of chunks) controller.enqueue(enc.encode(c)); controller.close(); }
    }));
}
const data = obj => `data: ${JSON.stringify(obj)}\n\n`;
const delta = (d, finish = null) => data({ choices: [{ delta: d, finish_reason: finish }] });

// ── readCerebrasCompletion ──────────────────────────────────────────────────
{
    const r = await readCerebrasCompletion(sse(delta({ content: 'foo' }), delta({ content: 'bar' }, 'stop'), 'data: [DONE]\n\n'));
    check('content deltas are joined in order', r.text === 'foobar');
    check('the finish reason is captured', r.finishReason === 'stop');
    check('no reasoning is reported when none streamed', r.sawReasoning === false);
}
{
    const r = await readCerebrasCompletion(sse(delta({ reasoning: 'thinking' }), delta({ reasoning: ' more' }), delta({}, 'length'), 'data: [DONE]\n\n'));
    check('a reasoning-only stream gives no text (the empty-completion failure)', r.text === '');
    check('reasoning-only stream is flagged as having reasoned', r.sawReasoning === true);
    check('length finish is captured for the reasoning-only stream', r.finishReason === 'length');
    check('the empty reason names finish and reasoning', emptyReason(r) === 'length+reasoning');
}
{
    const r = await readCerebrasCompletion(sse(delta({ reasoning: 'plan' }), delta({ content: 'answer' }, 'stop')));
    check('text after reasoning is kept', r.text === 'answer' && r.sawReasoning === true);
}
{
    // A network chunk can end in the middle of a data line; both halves must still be read.
    const line = delta({ content: 'split-line' }, 'stop');
    const r = await readCerebrasCompletion(sse(line.slice(0, 20), line.slice(20)));
    check('a line split across two chunks is not lost', r.text === 'split-line');
}
{
    const r = await readCerebrasCompletion(sse('data: {not json}\n\n', ': keep-alive\n\n', delta({ content: 'ok' }, 'stop')));
    check('malformed and comment lines are skipped', r.text === 'ok');
}
{
    const r = await readCerebrasCompletion(sse(delta({ content: null }), delta({ content: '' }, 'stop')));
    check('null and empty content give no text', r.text === '');
}
{
    const r = await readCerebrasCompletion(sse(delta({ content: '  \n' }, 'stop')));
    check('whitespace-only text is returned as-is for the caller to trim', r.text === '  \n');
}
{
    const r = await readCerebrasCompletion(sse());
    check('an empty body gives empty text and no finish reason', r.text === '' && r.finishReason === null);
    check('the empty reason with nothing is "none"', emptyReason(r) === 'none');
}
check('the empty reason is bounded and safe as a hash field', /^[a-z_]{1,16}$/i.test(emptyReason({ finishReason: 'a weird/finish reason!!! that is far too long', sawReasoning: false })));

// ── recordCompletionOutcomes ────────────────────────────────────────────────
function fakeRedis({ failExec = false } = {}) {
    const calls = [];
    return {
        calls,
        pipeline() {
            const p = {
                hincrby(key, field, n) { calls.push(['hincrby', key, field, n]); return p; },
                expire(key, ttl) { calls.push(['expire', key, ttl]); return p; },
                async exec() { if (failExec) throw new Error('redis down'); calls.push(['exec']); }
            };
            return p;
        }
    };
}
{
    const redis = fakeRedis();
    await recordCompletionOutcomes(redis, '2026-10-15', ['cerebras:empty', 'cerebras:empty:length+reasoning', 'gemini:after_cerebras_fail']);
    const incs = redis.calls.filter(c => c[0] === 'hincrby');
    check('one increment per field on the day key', incs.length === 3 && incs.every(c => c[1] === 'telemetry:completions:2026-10-15' && c[3] === 1));
    check('the key gets a TTL and the pipeline runs', redis.calls.some(c => c[0] === 'expire') && redis.calls.some(c => c[0] === 'exec'));
}
{
    const redis = fakeRedis();
    await recordCompletionOutcomes(redis, '2026-10-15', []);
    check('no fields means no Redis call', redis.calls.length === 0);
}
{
    let threw = false;
    try { await recordCompletionOutcomes(fakeRedis({ failExec: true }), '2026-10-15', ['cerebras:ok']); } catch { threw = true; }
    check('a Redis failure never breaks the completion', threw === false);
}

console.log(`\n${passed}/${passed + failed} checks passed`);
process.exit(failed ? 1 : 0);
