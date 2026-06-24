// api/announcement.js — Freebird dynamic announcement endpoint
// Called by the extension on activation to check for founder messages.
// Returns a message object if there's something to show, null otherwise.
//
// Extension calls: GET /api/announcement
// Response: { message: string, variant: string, cta: string, ctaAction: string } | { message: null }

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

    // No announcement active right now
    return res.status(200).json({ message: null });

    // To activate an announcement, replace the above with:
    // return res.status(200).json({
    //     variant:   'founder',
    //     message:   'We noticed you\'ve been using Freebird heavily...',
    //     cta:       'Claim free Pro trial',
    //     ctaAction: 'mailto:support@ten-labs.com.au?subject=Pro%20Trial'
    // });
}
