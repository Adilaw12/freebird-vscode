// api/announcement.js — Freebird dynamic announcement endpoint
// Called by the extension on activation to check for founder messages.
// Returns a message object if there's something to show, null otherwise.
//
// Extension calls: GET /api/announcement
// Response: { message: string, variant: string, cta: string, ctaAction: string } | { message: null }

// v0.9.0 update notice — shown for ~10 days after release, then stops
// automatically. The extension dedupes per distinct message text, so users
// see this exactly once.
const WINDOW_START = new Date('2026-07-27T00:00:00Z');
const WINDOW_END   = new Date('2026-08-06T00:00:00Z');

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

    const now = new Date();
    if (now >= WINDOW_START && now < WINDOW_END) {
        return res.status(200).json({
            variant:   'update-090',
            message:   'Freebird 0.9.0: two new free BYOK backends — Kimi K3 (2.8T frontier model, 1M token context) and Custom Provider (any OpenAI-compatible API — OpenRouter, Together, self-hosted). Plus built-in prompt templates and a simpler quota wall with a direct switch to local Ollama.',
            cta:       'Start free Pro trial',
            ctaAction: 'freebird.startTrial'
        });
    }

    // No announcement active right now
    return res.status(200).json({ message: null });
}
