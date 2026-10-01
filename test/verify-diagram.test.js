// test/verify-diagram.test.js — tests the verify_diagram tool (renders a
// Mermaid diagram via mermaid.ink and attaches the image) via
// executeToolCall, mocking global.fetch so no real network call is made.
// git/context/sessionId/turnId are irrelevant to this tool and passed as
// dummy values — same approach as other tool tests that don't exercise
// those parameters.

require('./bootstrap');
const path = require('path');
const { suite, checkAsync } = require('./helpers');

const OUT = path.join(__dirname, '..', 'out');
const { executeToolCall } = require(path.join(OUT, 'agent/tools.js'));

const DUMMY_GIT = {};
const DUMMY_APPROVAL = async () => true;
const DUMMY_CONTEXT = {};

function call(tool) {
    return executeToolCall(tool, DUMMY_GIT, DUMMY_APPROVAL, DUMMY_CONTEXT, 'test-session', 'test-turn');
}

async function run() {
    const originalFetch = global.fetch;

    suite('verify_diagram requires mermaid source');
    await checkAsync('fails cleanly with no mermaid source', async () => {
        const result = await call({ action: 'verify_diagram' });
        return result.success === false && /requires/i.test(result.output);
    });

    suite('verify_diagram: mermaid.ink renders successfully');
    try {
        global.fetch = async () => ({
            ok: true,
            status: 200,
            headers: { get: (h) => (h === 'content-type' ? 'image/png' : null) },
            arrayBuffer: async () => new TextEncoder().encode('fake-png-bytes').buffer
        });

        await checkAsync('reports success', async () => {
            const result = await call({ action: 'verify_diagram', mermaid: 'graph TD; A-->B;' });
            return result.success === true;
        });

        await checkAsync('attaches a non-empty base64 image', async () => {
            const result = await call({ action: 'verify_diagram', mermaid: 'graph TD; A-->B;' });
            return !!result.image && result.image.mimeType === 'image/png' && result.image.base64.length > 0;
        });
    } finally {
        global.fetch = originalFetch;
    }

    suite('verify_diagram: mermaid.ink rejects (likely a syntax error)');
    try {
        global.fetch = async () => ({
            ok: false,
            status: 400,
            headers: { get: () => null },
            text: async () => 'Parse error on line 1'
        });

        await checkAsync('reports failure, not success', async () => {
            const result = await call({ action: 'verify_diagram', mermaid: 'graph TD; A--invalid-->>>B' });
            return result.success === false;
        });

        await checkAsync('message points at a likely syntax error and suggests retrying', async () => {
            const result = await call({ action: 'verify_diagram', mermaid: 'graph TD; A--invalid-->>>B' });
            return /syntax error/i.test(result.output) && /create_diagram again/i.test(result.output);
        });

        await checkAsync('does not attach an image on failure', async () => {
            const result = await call({ action: 'verify_diagram', mermaid: 'bad' });
            return result.image === undefined;
        });
    } finally {
        global.fetch = originalFetch;
    }

    suite('verify_diagram: mermaid.ink unreachable — degrades without blocking the turn');
    try {
        global.fetch = async () => { throw new Error('ECONNREFUSED'); };

        await checkAsync('reports failure but explains the diagram file still exists', async () => {
            const result = await call({ action: 'verify_diagram', mermaid: 'graph TD; A-->B;' });
            return result.success === false &&
                /still created/i.test(result.output) &&
                /proceeding/i.test(result.output);
        });
    } finally {
        global.fetch = originalFetch;
    }

    suite('verify_diagram: oversized response is skipped gracefully, not buffered unbounded');
    try {
        const bigBuffer = new Uint8Array(6 * 1024 * 1024); // over the 5MB cap
        global.fetch = async () => ({
            ok: true,
            status: 200,
            headers: { get: (h) => (h === 'content-type' ? 'image/png' : null) },
            arrayBuffer: async () => bigBuffer.buffer
        });

        await checkAsync('fails gracefully instead of attaching a huge image', async () => {
            const result = await call({ action: 'verify_diagram', mermaid: 'graph TD; A-->B;' });
            return result.success === false && result.image === undefined;
        });
    } finally {
        global.fetch = originalFetch;
    }
}

module.exports = { run };

if (require.main === module) {
    const { summary } = require('./helpers');
    run().then(() => process.exit(summary() ? 0 : 1));
}
