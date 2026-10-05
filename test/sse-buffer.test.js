// test/sse-buffer.test.js — regression test for streamed-response parsing.
//
// Network chunks don't respect SSE line boundaries. Providers used to decode
// each chunk on its own and split on '\n', so any `data: {...}` line cut in two
// was dropped entirely — lost text, and tool-call JSON fragments lost so the
// call silently fell back to an empty `{}` input. These tests feed responses
// split at every possible byte offset and require identical output.

const vscodeMock = require('./bootstrap');
const path = require('path');
const { suite, check, summary } = require('./helpers');

const OUT = path.join(__dirname, '..', 'out');
const { LineBuffer, sseData } = require(path.join(OUT, 'ai/sse.js'));
const { AnthropicProvider } = require(path.join(OUT, 'ai/anthropic.js'));
const { OpenAIProvider } = require(path.join(OUT, 'ai/openai.js'));

const enc = new TextEncoder();

/** A Response whose body arrives in the given chunk sizes. */
function chunkedResponse(text, sizes) {
    const bytes = enc.encode(text);
    let offset = 0;
    let i = 0;
    const body = new ReadableStream({
        pull(controller) {
            if (offset >= bytes.length) { controller.close(); return; }
            const size = sizes[i++ % sizes.length];
            controller.enqueue(bytes.slice(offset, offset + size));
            offset += size;
        }
    });
    return new Response(body);
}

const ANTHROPIC_SSE = [
    'event: content_block_start',
    'data: {"type":"content_block_start","content_block":{"type":"text"}}',
    '',
    'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hello "}}',
    '',
    'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"wörld"}}',
    '',
    'data: {"type":"content_block_start","content_block":{"type":"tool_use","id":"t1","name":"write_file"}}',
    '',
    'data: {"type":"content_block_delta","delta":{"type":"input_json_delta","partial_json":"{\\"path\\":\\"a.ts\\","}}',
    '',
    'data: {"type":"content_block_delta","delta":{"type":"input_json_delta","partial_json":"\\"content\\":\\"x\\"}"}}',
    '',
    'data: {"type":"content_block_stop"}',
    '',
    'data: [DONE]',
    ''
].join('\n');

const OPENAI_SSE = [
    'data: {"choices":[{"delta":{"content":"Hello "}}]}',
    '',
    'data: {"choices":[{"delta":{"content":"wörld"}}]}',
    '',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"write_file","arguments":"{\\"path\\":\\"a.ts\\","}}]}}]}',
    '',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"content\\":\\"x\\"}"}}]}}]}',
    '',
    'data: [DONE]',
    ''
].join('\n');

async function withFetch(response, fn) {
    const real = global.fetch;
    global.fetch = async () => response;
    try { return await fn(); } finally { global.fetch = real; }
}

async function run() {
    suite('LineBuffer — partial lines carry over');
    {
        const b = new LineBuffer();
        check('no complete line yet', b.push(enc.encode('data: {"a"')).length === 0);
        const lines = b.push(enc.encode(':1}\ndata: {"b":2}\nda'));
        check('both completed lines emitted', lines.length === 2 && lines[0] === 'data: {"a":1}' && lines[1] === 'data: {"b":2}');
        check('trailing partial flushed at end', b.flush().join('') === 'da');
    }

    suite('LineBuffer — multi-byte characters split across chunks');
    {
        const bytes = enc.encode('data: héllo wörld ✓\n');
        let ok = true;
        for (let cut = 1; cut < bytes.length; cut++) {
            const b = new LineBuffer();
            const got = [...b.push(bytes.slice(0, cut)), ...b.push(bytes.slice(cut))];
            if (got.length !== 1 || got[0] !== 'data: héllo wörld ✓') { ok = false; break; }
        }
        check('every possible split point decodes the same line', ok);
    }

    suite('sseData — identical output at every chunk size');
    {
        let ok = true;
        for (const size of [1, 2, 3, 5, 7, 13, 64, 10_000]) {
            const got = [];
            for await (const d of sseData(chunkedResponse(ANTHROPIC_SSE, [size]))) got.push(d);
            if (got.length !== 8 || got[got.length - 1] !== '[DONE]') { ok = false; break; }
        }
        check('8 data payloads regardless of chunking', ok);
    }

    suite('AnthropicProvider.stream — no text lost at any chunk size');
    {
        vscodeMock.__setMockConfig({ 'freebird.apiKey': 'sk-test' });
        let ok = true;
        for (const size of [1, 2, 3, 5, 7, 13, 64, 10_000]) {
            let text = '';
            await withFetch(chunkedResponse(ANTHROPIC_SSE, [size]), () =>
                new AnthropicProvider().stream([{ role: 'user', content: 'hi' }], c => { text += c; }));
            if (text !== 'Hello wörld') { ok = false; break; }
        }
        check('"Hello wörld" reassembled for every chunk size', ok);
    }

    suite('AnthropicProvider.streamWithTools — tool input survives chunking');
    {
        let ok = true;
        for (const size of [1, 2, 3, 5, 7, 13, 64, 10_000]) {
            const r = await withFetch(chunkedResponse(ANTHROPIC_SSE, [size]), () =>
                new AnthropicProvider().streamWithTools([{ role: 'user', content: 'hi' }], [], () => {}));
            const input = r.toolCalls[0]?.input;
            if (r.text !== 'Hello wörld' || !input || input.path !== 'a.ts' || input.content !== 'x') { ok = false; break; }
        }
        check('tool call keeps its full JSON arguments (not an empty {})', ok);
    }

    suite('OpenAIProvider.streamWithTools — tool arguments survive chunking');
    {
        let ok = true;
        for (const size of [1, 2, 3, 5, 7, 13, 64, 10_000]) {
            const r = await withFetch(chunkedResponse(OPENAI_SSE, [size]), () =>
                new OpenAIProvider().streamWithTools([{ role: 'user', content: 'hi' }], [], () => {}));
            const input = r.toolCalls[0]?.input;
            if (r.text !== 'Hello wörld' || !input || input.path !== 'a.ts' || input.content !== 'x') { ok = false; break; }
        }
        check('tool call keeps its full JSON arguments (not an empty {})', ok);
    }

    suite('backend createLineSplitter — same guarantees');
    {
        const modPath = path.join(__dirname, '..', 'backend', 'lib', 'sseLines.js');
        const { createLineSplitter } = await import(`file://${modPath}`);
        const bytes = enc.encode('data: {"x":"é"}\ndata: {"y":2}\n');
        let ok = true;
        for (let cut = 1; cut < bytes.length; cut++) {
            const s = createLineSplitter();
            const got = [...s.push(bytes.slice(0, cut)), ...s.push(bytes.slice(cut)), ...s.flush()];
            if (got.length !== 2 || got[0] !== 'data: {"x":"é"}' || got[1] !== 'data: {"y":2}') { ok = false; break; }
        }
        check('every possible split point yields the same two lines', ok);
        const s2 = createLineSplitter();
        check('unterminated final line is returned by flush()', s2.push(enc.encode('data: {"z":3}')).length === 0 && s2.flush()[0] === 'data: {"z":3}');
    }
}

module.exports = { run };

if (require.main === module) {
    run().then(() => process.exit(summary() ? 0 : 1));
}
