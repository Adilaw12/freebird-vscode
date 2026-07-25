// api/announcement.js — Freebird dynamic announcement endpoint
// Called by the extension on activation to check for founder messages.
// Returns a message object if there's something to show, null otherwise.
//
// Extension calls: GET /api/announcement
// Response: { message: string, variant: string, cta: string, ctaAction: string } | { message: null }

// v0.8.9 update notice — shown for ~10 days after release, then stops
// automatically. The extension dedupes per distinct message text, so users
// see this exactly once.
const WINDOW_START = new Date('2026-07-25T00:00:00Z');
const WINDOW_END   = new Date('2026-08-04T00:00:00Z');

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

    const now = new Date();
    if (now >= WINDOW_START && now < WINDOW_END) {
        return res.status(200).json({
            variant:   'update-089',
            message:   'Freebird 0.8.9: bring-your-own-key (Claude, GPT-4o, DeepSeek, Qwen) is now FREE for everyone, the free-edit counter is fixed (a bug under-reported your 20/day), and Pro now includes a 7-day free trial — no card needed.',
            cta:       'Start free Pro trial',
            ctaAction: 'freebird.startTrial'
        });
    }

    // No announcement active right now
    return res.status(200).json({ message: null });
}
