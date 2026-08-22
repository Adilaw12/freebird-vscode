// api/announcement.js — Freebird dynamic announcement endpoint
// Called by the extension on activation to check for founder messages.
// Returns a message object if there's something to show, null otherwise.
//
// Extension calls: GET /api/announcement
// Response: { message: string, variant: string, cta: string, ctaAction: string } | { message: null }

// v0.11.0 update notice — shown for ~14 days after release, then stops
// automatically. The extension dedupes per distinct message text, so users
// see this exactly once. (Previous v0.9.0 window has already elapsed —
// kept only as a reference for the pattern, not still active.)
const WINDOW_START = new Date('2026-08-22T00:00:00Z');
const WINDOW_END   = new Date('2026-09-05T00:00:00Z');

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

    const now = new Date();
    if (now >= WINDOW_START && now < WINDOW_END) {
        return res.status(200).json({
            variant:   'update-0110',
            message:   'New: the Freebird Template Library — 33 expert-crafted prompt templates (migration planning, security-adjacent reviews, accessibility/compliance audits, release automation, and more) alongside the 3 free ones. Included free with Pro/Enterprise/Team, or available as its own low-cost subscription.',
            cta:       'Browse templates',
            ctaAction: 'freebird.usePromptTemplate'
        });
    }

    // No announcement active right now
    return res.status(200).json({ message: null });
}
