// api/health.js — Freebird backend health check
// Used by UptimeRobot (or any uptime monitor) to verify the Gemini
// integration is working. Pings Gemini with a minimal 5-token request.
//
// Returns:
//   200 { status: 'ok', ... }       — everything working
//   502 { status: 'degraded', ... } — Gemini returned an error
//   503 { status: 'down', ... }     — network/timeout failure
//
// UptimeRobot setup:
//   Monitor Type: HTTP(s)
//   URL: https://freebird-backend.vercel.app/api/health
//   Interval: 5 minutes
//   Alert on: non-2xx response

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL   = 'gemini-3.1-flash-lite';
const GEMINI_URL     = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;

export default async function handler(req, res) {
    // Allow GET for uptime monitors and POST for manual checks
    if (req.method !== 'GET' && req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    if (!GEMINI_API_KEY) {
        return res.status(503).json({
            status:    'down',
            service:   'gemini',
            error:     'GEMINI_API_KEY not configured',
            timestamp: new Date().toISOString()
        });
    }

    const start = Date.now();

    try {
        const response = await fetch(GEMINI_URL, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{
                    role:  'user',
                    parts: [{ text: 'hi' }]
                }],
                generationConfig: {
                    maxOutputTokens: 5,
                    temperature:     0
                }
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

            console.error(`Health check failed: ${response.status} ${errorMessage}`);

            return res.status(502).json({
                status:    'degraded',
                service:   'gemini',
                model:     GEMINI_MODEL,
                error:     errorMessage,
                code:      response.status,
                latencyMs,
                timestamp: new Date().toISOString()
            });
        }

        return res.status(200).json({
            status:    'ok',
            service:   'gemini',
            model:     GEMINI_MODEL,
            latencyMs,
            timestamp: new Date().toISOString()
        });

    } catch (err) {
        const latencyMs = Date.now() - start;
        const isTimeout = err.name === 'TimeoutError' || err.message?.includes('timeout');

        console.error(`Health check error: ${err.message}`);

        return res.status(503).json({
            status:    'down',
            service:   'gemini',
            model:     GEMINI_MODEL,
            error:     isTimeout ? 'Gemini request timed out (>8s)' : err.message,
            latencyMs,
            timestamp: new Date().toISOString()
        });
    }
}
