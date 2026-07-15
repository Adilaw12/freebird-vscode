// test/run.js — runs the full test suite. Compile first: `npm run compile`
// must have been run so out/ reflects the current source before testing it
// (this suite tests the compiled output, not the .ts source, so it's
// testing exactly what ships).
//
// Usage: npm test

const path = require('path');
const fs = require('fs');

const outDir = path.join(__dirname, '..', 'out');
if (!fs.existsSync(outDir)) {
    console.error('out/ not found — run `npm run compile` first (or just `npm test`, which does this for you).');
    process.exit(1);
}

const { summary } = require('./helpers');

const suites = [
    require('./chat-html-syntax.test.js'),
    require('./byok-gate.test.js'),
    require('./license-status.test.js'),
    require('./chunker.test.js'),
    require('./vector-math.test.js'),
    require('./index-store.test.js'),
    require('./gemini-fallback.test.js'),
    require('./quota-race.test.js'),
    require('./checkpoint.test.js'),
    require('./fetch-url.test.js')
];

(async () => {
    for (const s of suites) {
        await s.run();
    }
    const ok = summary();
    process.exit(ok ? 0 : 1);
})();
