// backend/lib/cerebrasModel.js — Cerebras model selection for free-tier tab
// completions specifically, mirroring anthropicModel.js's fallback-chain
// pattern and NOTE comment style.
//
// Cerebras's inference hardware is dramatically faster (2,600+ tokens/second)
// than typical GPU inference — a genuine win specifically for tab
// completions, where perceived latency matters most and prompts are short
// (well under Cerebras's 8,192-token context limit). NOT used for full chat
// or Pro/unmetered traffic (which already gets Claude Haiku 4.5).
//
// Cost note: Cerebras discontinued its permanent free tier on 2026-08-17 —
// this is now a deliberate, modest paid cost (gpt-oss-120b: $0.35/M input,
// $0.75/M output — roughly $0.0007/completion at this feature's typical
// context size), not a free resource. Re-check current pricing/model
// availability at cloud.cerebras.ai if this ever needs revisiting — like
// Gemini/Anthropic's lineups, this can change.

const CEREBRAS_API_KEY = process.env.CEREBRAS_API_KEY;
const CEREBRAS_URL     = 'https://api.cerebras.ai/v1/chat/completions';

// Only one candidate today — confirmed real and currently priced as of this
// writing. Add a second entry here only once it's a confirmed, real model
// id, not a placeholder (same discipline as ANTHROPIC_MODEL_CANDIDATES).
export const CEREBRAS_MODEL_CANDIDATES = [
    'gpt-oss-120b'
];

/**
 * Tries each candidate model in order until one returns an ok response.
 * Same 404-only-advances semantics as fetchGeminiWithFallback/
 * fetchAnthropicWithFallback — a 429/5xx (including Cerebras's own rate
 * limits) isn't a model-availability problem, so it returns immediately
 * rather than retrying across models; the caller falls back to Gemini.
 *
 * @param {object} body OpenAI-compatible chat completions request body (model set per-candidate)
 * @param {RequestInit} [fetchOpts]
 * @returns {Promise<{ response: Response, modelUsed: string }>}
 */
export async function fetchCerebrasWithFallback(body, fetchOpts = {}, candidates = CEREBRAS_MODEL_CANDIDATES) {
    let lastResponse = null;
    let lastModel = candidates[0];

    for (const model of candidates) {
        const response = await fetch(CEREBRAS_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${CEREBRAS_API_KEY}`
            },
            body: JSON.stringify({ ...body, model }),
            ...fetchOpts
        });

        if (response.ok) {
            if (model !== candidates[0]) {
                console.warn(`Cerebras fallback engaged: primary model(s) unavailable, served via "${model}". Update CEREBRAS_MODEL_CANDIDATES.`);
            }
            return { response, modelUsed: model };
        }

        lastResponse = response;
        lastModel = model;

        if (response.status !== 404) break; // not a "model gone" failure — don't retry across models
        console.error(`Cerebras model "${model}" returned 404 (likely deprecated) — trying next candidate`);
    }

    return { response: lastResponse, modelUsed: lastModel };
}

/** True only when the key is actually configured — callers use this to decide whether to even attempt Cerebras before falling back to Gemini. */
export function cerebrasConfigured() {
    return Boolean(CEREBRAS_API_KEY);
}
