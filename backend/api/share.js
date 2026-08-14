// api/share.js — share a code selection with a colleague without exposing
// the whole codebase. This is what the README's "team collaboration" line
// actually refers to: not a repo-wide access grant, just a scoped snippet.
//
// POST creates a share (requires an active Pro/Enterprise/Team/trial
// license — same isLicenseActive() check as chat.js/fallback.js):
//   { licenseKey, code, language?, filename?, title? } -> { id, url, expiresInDays }
//
// GET (?id=) renders it as a public, unlisted HTML page — no license or even
// Freebird installed needed to view, same trust model as a paste/gist link.
// Rewritten from the clean /share/:id URL by vercel.json.
//
// Storage: Redis `share:${id}`, TTL 14 days — meant for "check this out",
// not permanent hosting. Creation is rate-limited per license so this can't
// be used as a free, unbounded paste service.

import { Redis } from '@upstash/redis';
import { randomBytes } from 'crypto';
import { isLicenseActive } from '../lib/license.js';
import { reserveSingleCounter } from '../lib/quota.js';
import { escapeHtml } from '../lib/htmlEscape.js';

const redis = Redis.fromEnv();

const MAX_CODE_CHARS    = 60_000; // ~60KB — a snippet/file, not a repo dump
const SHARE_TTL         = 14 * 24 * 60 * 60; // 14 days, in seconds
const DAILY_SHARE_LIMIT = 30; // per license, per day — generous for real use, bounds cost/abuse
const APP_URL           = process.env.APP_URL || 'https://freebird-backend.vercel.app';

export const config = { runtime: 'nodejs' };

export default async function handler(req, res) {
    if (req.method === 'OPTIONS') {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
        return res.status(200).end();
    }
    if (req.method === 'POST') return handleCreate(req, res);
    if (req.method === 'GET')  return handleView(req, res);
    return res.status(405).json({ error: 'Method not allowed' });
}

function newShareId() {
    return randomBytes(9).toString('base64url'); // 12 chars, URL-safe, unguessable — this IS the access control for viewing
}

async function handleCreate(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');

    const { licenseKey, code, language, filename, title } = req.body ?? {};

    if (!licenseKey || typeof licenseKey !== 'string') {
        return res.status(401).json({ error: 'Sharing requires an active Pro license.', code: 'LICENSE_REQUIRED' });
    }

    const normalisedKey = licenseKey.trim().toUpperCase();
    let license;
    try {
        license = await redis.get(`license:${normalisedKey}`);
    } catch (err) {
        console.error('License lookup error (share):', err);
        return res.status(500).json({ error: 'Internal error', code: 'SERVER_ERROR' });
    }
    if (!isLicenseActive(license)) {
        return res.status(403).json({ error: 'Sharing requires an active Pro license.', code: 'LICENSE_REQUIRED' });
    }

    if (!code || typeof code !== 'string' || !code.trim()) {
        return res.status(400).json({ error: 'code is required', code: 'BAD_REQUEST' });
    }
    if (code.length > MAX_CODE_CHARS) {
        return res.status(400).json({
            error: `Selection too large — max ${MAX_CODE_CHARS.toLocaleString()} characters. Share a smaller selection.`,
            code: 'TOO_LARGE'
        });
    }

    // Rate limit per license, not per IP — the license is the identity that matters here.
    const rateKey = `share:rate:${normalisedKey}:${new Date().toISOString().slice(0, 10)}`;
    const { blocked } = await reserveSingleCounter(redis, rateKey, DAILY_SHARE_LIMIT, 24 * 60 * 60);
    if (blocked) {
        return res.status(429).json({
            error: `Daily share limit reached (${DAILY_SHARE_LIMIT}/day). Try again tomorrow.`,
            code: 'RATE_LIMITED'
        });
    }

    const id = newShareId();
    const record = {
        code,
        language: typeof language === 'string' ? language.slice(0, 40)  : '',
        filename: typeof filename === 'string' ? filename.slice(0, 200) : '',
        title:    typeof title    === 'string' ? title.slice(0, 200)    : '',
        createdAt: new Date().toISOString()
    };

    await redis.set(`share:${id}`, record, { ex: SHARE_TTL });

    return res.status(200).json({ id, url: `${APP_URL}/share/${id}`, expiresInDays: 14 });
}

async function handleView(req, res) {
    const { id } = req.query ?? {};
    if (!id || typeof id !== 'string') {
        return res.status(400).send(page('Invalid link', '<p>This share link is malformed.</p>'));
    }

    let record;
    try {
        record = await redis.get(`share:${id}`);
    } catch (err) {
        console.error('Share lookup error:', err);
        return res.status(500).send(page('Something went wrong', '<p>Please try again in a moment.</p>'));
    }

    if (!record) {
        return res.status(404).send(page(
            'Link expired',
            `<p>This share link has expired or doesn't exist. Share links last 14 days.</p>`
        ));
    }

    const rawTitle = record.title || record.filename || 'Shared code';
    const heading   = escapeHtml(rawTitle);
    const metaParts = [record.filename, record.language].filter(Boolean).map(escapeHtml);
    const meta      = metaParts.length ? `<div class="meta">${metaParts.join(' · ')}</div>` : '';

    return res.status(200).send(page(
        heading,
        `${meta}<pre class="code"><code>${escapeHtml(record.code)}</code></pre>`,
        true
    ));
}

function page(title, body, isCodeView = false) {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} — Freebird AI</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
         max-width: ${isCodeView ? '900px' : '560px'}; margin: 40px auto; padding: 0 24px 40px;
         color: #e8e0ff; background: #1a1a2e; }
  h1 { font-size: 1.4em; margin-bottom: 4px; word-break: break-word; }
  .meta { opacity: 0.6; font-size: 0.85em; margin-bottom: 16px; }
  .code { font-family: ui-monospace, 'SF Mono', Consolas, monospace; font-size: 0.9em;
          background: #14141f; border: 1px solid #3a3a6e; border-radius: 8px;
          padding: 16px 18px; overflow-x: auto; white-space: pre; line-height: 1.5; }
  a { color: #a89aff; }
  .footer { margin-top: 28px; padding-top: 16px; border-top: 1px solid #3a3a6e;
            font-size: 0.85em; opacity: 0.7; }
</style>
</head>
<body>
<h1>${title}</h1>
${body}
<div class="footer">Shared via <a href="https://marketplace.visualstudio.com/items?itemName=TenLabs.freebird-ai">Freebird AI</a> — an open-source AI coding assistant for VS Code.</div>
</body>
</html>`;
}
