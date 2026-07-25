// backend/lib/geminiModel.js — centralized Gemini model selection with an
// automatic fallback chain.
//
// Built after the July 2026 incident where gemini-2.5-flash and
// gemini-2.0-flash were both deprecated within the same week, taking down
// chat.js, fallback.js, and health.js simultaneously because the model name
// was hardcoded in three separate files with no fallback. See CHANGELOG.
//
// When Google deprecates a model, update GEMINI_MODEL_CANDIDATES here —
// nowhere else — and the fallback chain buys time even if this list isn't
// updated immediately: a 404 on the first candidate automatically tries the
// next one rather than failing the whole free tier.

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

// Ordered most-preferred first. Only the first entry is used in normal
// operation — later entries are a safety net, not a quality tier list, so
// don't assume users are knowingly getting a "downgraded" model when a
// fallback engages; it should be rare and log loudly when it happens.
export const GEMINI_MODEL_CANDIDATES = [
    'gemini-3.1-flash-lite',
    'gemini-2.5-flash-lite',
    'gemini-2.5-flash'
];

// Pro/unmetered requests get the full (non-lite) tier first — a genuine
// quality difference paying users can feel, rather than relying on quota
// pressure alone. Falls through to the free-tier list as a safety net.
export const PRO_GEMINI_MODEL_CANDIDATES = [
    'gemini-3.6-flash',
    ...GEMINI_MODEL_CANDIDATES
];

function urlFor(model, endpoint) {
    const altParam = endpoint === 'streamGenerateContent' ? 'alt=sse&' : '';
    return `https://generativelanguage.googleapis.com/v1beta/models/${model}:${endpoint}?${altParam}key=${GEMINI_API_KEY}`;
}

/**
 * Tries each candidate model in order until one returns an ok response.
 * Only advances to the next candidate on a 404 (model not found/retired) —
 * other failures (429 rate limit, 5xx upstream issue, safety blocks) return
 * immediately rather than retrying across models, since those aren't caused
 * by model availability and retrying would just multiply latency and cost.
 *
 * @param {'streamGenerateContent'|'generateContent'} endpoint
 * @param {object} body Gemini request body
 * @param {RequestInit} [fetchOpts] extra fetch options (e.g. signal)
 * @returns {Promise<{ response: Response, modelUsed: string }>}
 */
export async function fetchGeminiWithFallback(endpoint, body, fetchOpts = {}, candidates = GEMINI_MODEL_CANDIDATES) {
    let lastResponse = null;
    let lastModel = candidates[0];

    for (const model of candidates) {
        const response = await fetch(urlFor(model, endpoint), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            ...fetchOpts
        });

        if (response.ok) {
            if (model !== candidates[0]) {
                console.warn(`Gemini fallback engaged: primary model(s) unavailable, served via "${model}". Update GEMINI_MODEL_CANDIDATES.`);
            }
            return { response, modelUsed: model };
        }

        lastResponse = response;
        lastModel = model;

        if (response.status !== 404) break; // not a "model gone" failure — don't retry across models
        console.error(`Gemini model "${model}" returned 404 (likely deprecated) — trying next candidate`);
    }

    return { response: lastResponse, modelUsed: lastModel };
}
