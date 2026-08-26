// api/announcement.js — Freebird dynamic announcement endpoint
// Called by the extension on activation to check for founder messages.
// Returns a message object if there's something to show, null otherwise.
//
// Extension calls: GET /api/announcement
// Response: { message: string, variant: string, cta: string, ctaAction: string } | { message: null }

// v0.12.0 update notice — shown for ~14 days after release, then stops
// automatically. The extension dedupes per distinct message text, so users
// see this exactly once. (Previous v0.9.0/v0.11.0 windows have already
// elapsed — kept only as a reference for the pattern, not still active.)
const WINDOW_START = new Date('2026-08-24T00:00:00Z');
const WINDOW_END   = new Date('2026-09-07T00:00:00Z');

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

    const now = new Date();
    if (now >= WINDOW_START && now < WINDOW_END) {
        return res.status(200).json({
            variant:   'update-0120',
            message:   'New: the 3 free prompt templates now run on Claude Haiku instead of Gemini Flash Lite — no more hallucinated citations. 1 free Haiku run/day, unlimited with the $3/mo Template Library. Agent turns are also faster and cheaper thanks to prompt caching.',
            cta:       'Try a template',
            ctaAction: 'freebird.usePromptTemplate'
        });
    }

    // No announcement active right now
    return res.status(200).json({ message: null });
}
