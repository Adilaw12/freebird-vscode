// backend/lib/anthropicModel.js — Claude model selection for Pro/Enterprise/
// trial (unmetered) requests, mirroring geminiModel.js's fallback-chain
// pattern and NOTE comment style.
//
// Introduced when Pro/unmetered traffic moved off Gemini 3.6 Flash to Claude
// Haiku 4.5 — confirmed cheaper ($0.80/M input, $4.00/M output vs Gemini 3.6
// Flash's $1.50/M input, $7.50/M output) and noticeably better coding output.
// Free tier stays on Gemini (see geminiModel.js) — this file only ever serves
// unmetered requests, and callers should fall back to Gemini if every
// candidate here fails rather than hard-failing a paying user's request.

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const ANTHROPIC_VERSION = '2023-06-01';
const ANTHROPIC_URL     = 'https://api.anthropic.com/v1/messages';

// Only one candidate today — unlike Gemini's list, these aren't guessed
// alternates; add a second entry here only once it's a confirmed, real model
// id, not a placeholder.
export const ANTHROPIC_MODEL_CANDIDATES = [
    'claude-haiku-4-5-20251001'
];

/**
 * Tries each candidate model in order until one returns an ok response.
 * Same 404-only-advances semantics as fetchGeminiWithFallback — a 429/5xx/
 * safety block isn't a model-availability problem, so it returns immediately
 * rather than retrying across models.
 *
 * @param {object} body Anthropic Messages API request body (model is set per-candidate)
 * @param {RequestInit} [fetchOpts]
 * @returns {Promise<{ response: Response, modelUsed: string }>}
 */
export async function fetchAnthropicWithFallback(body, fetchOpts = {}, candidates = ANTHROPIC_MODEL_CANDIDATES) {
    let lastResponse = null;
    let lastModel = candidates[0];

    for (const model of candidates) {
        const response = await fetch(ANTHROPIC_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': ANTHROPIC_API_KEY,
                'anthropic-version': ANTHROPIC_VERSION
            },
            body: JSON.stringify({ ...body, model }),
            ...fetchOpts
        });

        if (response.ok) {
            if (model !== candidates[0]) {
                console.warn(`Anthropic fallback engaged: primary model(s) unavailable, served via "${model}". Update ANTHROPIC_MODEL_CANDIDATES.`);
            }
            return { response, modelUsed: model };
        }

        lastResponse = response;
        lastModel = model;

        if (response.status !== 404) break; // not a "model gone" failure — don't retry across models
        console.error(`Anthropic model "${model}" returned 404 (likely deprecated) — trying next candidate`);
    }

    return { response: lastResponse, modelUsed: lastModel };
}

/** True only when the key is actually configured — callers use this to decide whether to even attempt Anthropic before falling back to Gemini. */
export function anthropicConfigured() {
    return Boolean(ANTHROPIC_API_KEY);
}
