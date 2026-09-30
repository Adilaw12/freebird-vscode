// scripts/test-cerebras.js — one-off: confirms the real Cerebras API
// response shape matches what lib/cerebrasModel.js + api/chat.js's SSE
// parsing assume. Not part of the app. Run:
//   CEREBRAS_API_KEY=... node scripts/test-cerebras.js

const CEREBRAS_URL = 'https://api.cerebras.ai/v1/chat/completions';
const apiKey = process.env.CEREBRAS_API_KEY;
if (!apiKey) { console.error('CEREBRAS_API_KEY not set'); process.exit(1); }

async function run() {
    const res = await fetch(CEREBRAS_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        body: JSON.stringify({
            model: 'gpt-oss-120b',
            max_tokens: 128,
            temperature: 0.2,
            stream: true,
            reasoning_effort: 'low',
            messages: [
                { role: 'user', content:
                    'You are a code-completion engine for utils.py (python). Given the code ' +
                    'before and after <CURSOR>, output ONLY the text to insert at <CURSOR> — ' +
                    'no explanation, no markdown fences, no repeating surrounding code. If ' +
                    'nothing useful belongs there, output nothing.\n\n' +
                    'def calculate_average(numbers):\n    total = sum(numbers)\n    count = len(numbers)\n    if count == 0:\n        return 0\n    return <CURSOR>\n' }
            ]
        })
    });

    console.log('HTTP status:', res.status);
    if (!res.ok) {
        console.error('Error body:', await res.text());
        process.exit(1);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let fullText = '';
    let rawChunkCount = 0;
    let firstRawChunk = null;

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const raw = decoder.decode(value);
        for (const line of raw.split('\n')) {
            const trimmed = line.trim();
            if (!trimmed.startsWith('data:')) continue;
            const jsonStr = trimmed.slice(5).trim();
            if (jsonStr === '[DONE]') continue;
            try {
                const parsed = JSON.parse(jsonStr);
                rawChunkCount++;
                if (!firstRawChunk) firstRawChunk = parsed;
                console.log(`chunk ${rawChunkCount}:`, JSON.stringify(parsed?.choices?.[0]));
                const text = parsed?.choices?.[0]?.delta?.content;
                if (text) fullText += text;
            } catch (e) {
                console.error('Failed to parse SSE line:', jsonStr.slice(0, 200));
            }
        }
    }

    console.log('Chunks received:', rawChunkCount);
    console.log('First raw chunk (for shape verification):', JSON.stringify(firstRawChunk, null, 2));
    console.log('Assembled completion text:', JSON.stringify(fullText));
    console.log(fullText.length > 0 ? 'PASS: delta.content parsing extracted real text' : 'FAIL: no text extracted — parsing assumption may be wrong');
}

run().catch((e) => { console.error('Test crashed:', e); process.exit(1); });
