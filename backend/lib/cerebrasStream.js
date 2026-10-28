// backend/lib/cerebrasStream.js — reads a whole Cerebras tab-completion stream before anything is sent on.
//
// gpt-oss-120b is a reasoning model: it streams reasoning tokens (delta.reasoning) before the answer
// (delta.content), and reasoning tokens count against the output cap. When the cap runs out first, the
// stream ends with HTTP 200, finish_reason "length" and no content at all. Forwarding the stream as it
// arrives turned that into an empty completion for the user, and because the response was "ok" the Gemini
// fallback never ran. Completions are short (a few hundred tokens at thousands of tokens per second), so
// reading the whole stream first costs almost nothing and lets the caller fall back when it is empty.

import { createLineSplitter } from './sseLines.js';

/**
 * Reads an OpenAI-compatible streaming response to the end.
 *
 * @param {Response} response a Cerebras chat-completions response with stream: true
 * @returns {Promise<{ text: string, finishReason: string|null, sawReasoning: boolean }>}
 */
export async function readCerebrasCompletion(response) {
    const reader = response.body.getReader();
    const splitter = createLineSplitter();
    let text = '';
    let finishReason = null;
    let sawReasoning = false;

    const handleLine = (line) => {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) return;
        const jsonStr = trimmed.slice(5).trim();
        if (!jsonStr || jsonStr === '[DONE]') return;
        let parsed;
        try { parsed = JSON.parse(jsonStr); } catch { return; } // skip malformed SSE lines
        const choice = parsed?.choices?.[0];
        const delta = choice?.delta;
        if (typeof delta?.content === 'string') text += delta.content;
        if (delta?.reasoning || delta?.reasoning_content) sawReasoning = true;
        if (choice?.finish_reason) finishReason = String(choice.finish_reason);
    };

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        splitter.push(value).forEach(handleLine);
    }
    splitter.flush().forEach(handleLine);

    return { text, finishReason, sawReasoning };
}

/** A short, bounded label for why a completion came back empty — safe to use as a Redis hash field. */
export function emptyReason({ finishReason, sawReasoning }) {
    const finish = (finishReason ?? 'none').replace(/[^a-z_]/gi, '').slice(0, 16) || 'none';
    return sawReasoning ? `${finish}+reasoning` : finish;
}
