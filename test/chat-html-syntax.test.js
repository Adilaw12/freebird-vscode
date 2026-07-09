// test/chat-html-syntax.test.js
//
// Regression test for the bug that killed the entire chat panel for ~12
// days (v0.6.10 through v0.7.4): an unescaped apostrophe inside a
// single-quoted JS string broke the parse of media/chat.html's inline
// <script> block. Because it's ONE script tag, a syntax error ANYWHERE in
// it kills every event handler silently — no console error unless webview
// dev tools happen to be open. This test makes that class of bug fail the
// build instead of shipping silently again.

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { suite, check, summary } = require('./helpers');

function run() {
    suite('media/chat.html inline script must parse without a syntax error');

    const htmlPath = path.join(__dirname, '..', 'media', 'chat.html');
    const html = fs.readFileSync(htmlPath, 'utf8');

    const scripts = [...html.matchAll(/<script(?:\s+[^>]*)?>([\s\S]*?)<\/script>/g)];
    check('media/chat.html contains at least one inline <script> block', scripts.length > 0);

    scripts.forEach((match, i) => {
        const code = match[1];
        let error = null;
        try {
            // Compiling (not running) is enough to catch syntax errors —
            // this is exactly what killed the webview: a SyntaxError means
            // NOTHING in the block executes, not just the broken line.
            new vm.Script(code, { filename: `chat.html#inline-script-${i}` });
        } catch (err) {
            error = err;
        }
        check(
            `inline script block #${i} parses without a syntax error` + (error ? ` (${error.message})` : ''),
            error === null
        );
    });
}

module.exports = { run };

if (require.main === module) {
    run();
    process.exit(summary() ? 0 : 1);
}
