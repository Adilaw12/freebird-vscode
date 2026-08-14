// backend/lib/htmlEscape.js — shared HTML-escaping for any handler that
// renders untrusted, user-submitted content into a server-rendered page
// (currently just api/share.js). Kept dependency-free and separate from its
// caller so it can be imported directly in tests without pulling in Redis.
export function escapeHtml(s) {
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}
