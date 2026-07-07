// api/announcement.js — Freebird dynamic announcement endpoint
// Called by the extension on activation to check for founder messages.
// Returns a message object if there's something to show, null otherwise.
//
// Extension calls: GET /api/announcement
// Response: { message: string, variant: string, cta: string, ctaAction: string } | { message: null }

// TODO(Adisa): paste the real Product Hunt listing URL here once it's live,
// then push this file (Vercel auto-deploys on push to main).
const PRODUCT_HUNT_URL = 'https://www.producthunt.com/posts/freebird-ai'; // placeholder — confirm slug

// Shown from July 15 through July 18 (UTC) to cover launch day plus a few
// days of catch-up across timezones, then stops automatically — no need to
// remember to turn it back off.
const LAUNCH_WINDOW_START = new Date('2026-07-15T00:00:00Z');
const LAUNCH_WINDOW_END   = new Date('2026-07-19T00:00:00Z');

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

    const now = new Date();
    if (now >= LAUNCH_WINDOW_START && now < LAUNCH_WINDOW_END) {
        return res.status(200).json({
            variant:   'launch',
            message:   'Freebird AI just launched on Product Hunt 🚀 — if it\'s been useful, a quick upvote helps a lot!',
            cta:       'Support us on Product Hunt',
            ctaAction: PRODUCT_HUNT_URL
        });
    }

    // No announcement active right now
    return res.status(200).json({ message: null });
}
