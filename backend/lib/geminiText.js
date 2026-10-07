// backend/lib/geminiText.js — pulls the visible answer text out of one Gemini streaming chunk.
//
// Thinking models can return several parts per chunk, some of them thought summaries
// ({ thought: true }). Reading only parts[0] forwarded a thought fragment as if it were the answer and
// dropped the real text; read every part, skip the thoughts, and join the rest.

export function geminiChunkText(parsed) {
    const parts = parsed?.candidates?.[0]?.content?.parts;
    if (!Array.isArray(parts)) return undefined;
    const text = parts.filter(p => p && !p.thought && typeof p.text === 'string').map(p => p.text).join('');
    return text || undefined;
}

// Gemini's hidden thinking tokens are counted against maxOutputTokens. With the 2048 the extension asks
// for by default, a thinking model could spend nearly all of it thinking and stop ~270 characters into
// the answer — a tool call cut off mid-JSON, which ended the agent run with nothing. Leave headroom for
// thinking on anything that is not a tiny tab completion.
export const GEMINI_THINKING_HEADROOM = 4096;
