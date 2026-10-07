// backend/test/gemini-text.test.js — lib/geminiText.js: reading Gemini stream chunks.
// Pure; run directly: `cd backend && node test/gemini-text.test.js`.

import { geminiChunkText, GEMINI_THINKING_HEADROOM } from '../lib/geminiText.js';

let passed = 0, failed = 0;
function check(label, cond) { if (cond) { passed++; console.log(`PASS — ${label}`); } else { failed++; console.log(`FAIL — ${label}`); } }
const chunk = parts => ({ candidates: [{ content: { parts } }] });

check('a single plain part is returned', geminiChunkText(chunk([{ text: 'hello' }])) === 'hello');
check('several parts are joined in order', geminiChunkText(chunk([{ text: 'a' }, { text: 'b' }, { text: 'c' }])) === 'abc');
check('thought parts are skipped, not forwarded as the answer', geminiChunkText(chunk([{ thought: true, text: 'let me think' }, { text: 'the answer' }])) === 'the answer');
check('a chunk that is only a thought gives nothing', geminiChunkText(chunk([{ thought: true, text: 'thinking' }])) === undefined);
check('the real text is not dropped when it is not parts[0]', geminiChunkText(chunk([{ thought: true, text: 'x' }, { thought: true, text: 'y' }, { text: 'real' }])) === 'real');
check('a chunk with no parts gives nothing', geminiChunkText({ candidates: [{ content: {} }] }) === undefined && geminiChunkText({}) === undefined && geminiChunkText(null) === undefined);
check('parts without text (e.g. function calls) are ignored', geminiChunkText(chunk([{ functionCall: { name: 'x' } }, { text: 'ok' }])) === 'ok');
check('there is real headroom for thinking tokens', GEMINI_THINKING_HEADROOM >= 2048);

console.log(`\n${passed}/${passed + failed} checks passed`);
process.exit(failed ? 1 : 0);
