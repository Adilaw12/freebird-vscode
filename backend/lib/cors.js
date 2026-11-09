// backend/lib/cors.js — the origin rule validate.js uses, shared by the account
// endpoints: the VS Code extension sends no Origin header, webviews send
// vscode-webview://, and ten-labs.com.au is allowed. Anything else is refused.

const ALLOWED_ORIGINS = ['https://ten-labs.com.au', 'vscode-webview://'];

/**
 * Sets CORS headers. Returns true if the request is finished (preflight or
 * refused) and the handler should stop.
 */
export function handleCors(req, res) {
    const origin = req.headers['origin'] || '';
    const allowed = ALLOWED_ORIGINS.some(o => origin.startsWith(o));
    if (origin && !allowed) {
        res.status(403).json({ error: 'Forbidden' });
        return true;
    }
    res.setHeader('Access-Control-Allow-Origin', allowed ? origin : '');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') { res.status(200).end(); return true; }
    if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return true; }
    return false;
}
