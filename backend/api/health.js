// api/health.js — Freebird backend health check
// Used by UptimeRobot (or any uptime monitor) to verify the Gemini
// integration is working. Checks EVERY model in the fallback chain, not just
// the primary — so you get an alert the moment the PRIMARY model breaks, even
// though the fallback chain is quietly covering for it and users aren't
// seeing an outage yet. Catching that moment matters: it's your warning that
// the safety margin just got smaller, before it disappears entirely.
//
// Returns:
//   200 { status: 'ok', ... }       — primary model works, full safety margin intact
//   502 { status: 'degraded', ... } — primary is down, a fallback is covering (still serving, but margin reduced)
//   503 { status: 'down', ... }     — ALL candidates failed, the tier is actually down
//
// Both 'degraded' and 'down' are non-2xx on purpose, so your EXISTING
// "alert on non-2xx" UptimeRobot config catches a primary-model failure
// immediately — no need to configure a second monitor for early warning.
//
// UptimeRobot setup:
//   Monitor Type: HTTP(s)
//   URL: https://freebird-backend.vercel.app/api/health
//   Interval: 5 minutes
//   Alert on: non-2xx response

import { GEMINI_MODEL_CANDIDATES } from '../lib/geminiModel.js';

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

async function checkModel(model) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`;
    const start = Date.now();
    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
                generationConfig: { maxOutputTokens: 5, temperature: 0 }
            }),
            signal: AbortSignal.timeout(8_000)
        });

        const latencyMs = Date.now() - start;
        if (!response.ok) {
            let errorMessage = response.statusText;
            try {
                const body = await response.json();
                errorMessage = body?.error?.message ?? errorMessage;
            } catch { /* ignore parse errors */ }
            return { model, ok: false, status: response.status, error: errorMessage, latencyMs };
        }
        return { model, ok: true, status: 200, latencyMs };
    } catch (err) {
        const latencyMs = Date.now() - start;
        const isTimeout = err.name === 'TimeoutError' || err.message?.includes('timeout');
        return { model, ok: false, status: null, error: isTimeout ? 'timeout (>8s)' : err.message, latencyMs };
    }
}

export default async function handler(req, res) {
    if (req.method !== 'GET' && req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    if (!GEMINI_API_KEY) {
        return res.status(503).json({
            status: 'down',
            error: 'GEMINI_API_KEY not configured',
            timestamp: new Date().toISOString()
        });
    }

    // Check every candidate in parallel — this endpoint is polled infrequently
    // (every few minutes by an uptime monitor), so the extra API calls are
    // cheap and worth it for the early-warning value.
    const results = await Promise.all(GEMINI_MODEL_CANDIDATES.map(checkModel));

    const primary = results[0];
    const anyWorking = results.some(r => r.ok);
    const workingCount = results.filter(r => r.ok).length;

    if (!anyWorking) {
        console.error('Health check: ALL Gemini model candidates failed', results);
        return res.status(503).json({
            status: 'down',
            error: 'All Gemini model candidates failed — free tier is fully down',
            candidates: results,
            timestamp: new Date().toISOString()
        });
    }

    if (!primary.ok) {
        console.error(`Health check: primary model "${primary.model}" failed, serving via fallback. Safety margin: ${workingCount - 1} backup(s) remaining.`, results);
        return res.status(502).json({
            status: 'degraded',
            primaryModel: primary.model,
            servingModel: results.find(r => r.ok).model,
            backupsRemaining: workingCount - 1,
            candidates: results,
            timestamp: new Date().toISOString()
        });
    }

    return res.status(200).json({
        status: 'ok',
        model: primary.model,
        latencyMs: primary.latencyMs,
        backupsRemaining: workingCount - 1,
        timestamp: new Date().toISOString()
    });
}
