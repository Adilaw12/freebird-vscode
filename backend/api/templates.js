// backend/api/templates.js — gated catalog for the paid template library.
// Mirrors validate.js's CORS/POST/key-format conventions. Accepts either or
// both of licenseKey (Pro/Enterprise/Team/trial — bundles template access)
// and templateLicenseKey (a standalone templates-only purchase); either one
// being entitled unlocks the catalog. locked/prompt are computed here from
// the server-side license lookup only — never trust a client-sent flag.

import { Redis } from '@upstash/redis';
import { hasTemplateLibraryAccess } from '../lib/license.js';
import { TEMPLATE_CATALOG } from '../lib/templateCatalog.js';

const redis = Redis.fromEnv();

const ALLOWED_ORIGINS = [
    'https://ten-labs.com.au',
    'vscode-webview://'  // VS Code webview origin
];

const KEY_FORMAT = /^(FBT?|OP)-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/;

export default async function handler(req, res) {
    const origin = req.headers['origin'] || '';
    const allowed = ALLOWED_ORIGINS.some(o => origin.startsWith(o));

    if (origin && !allowed) {
        return res.status(403).json({ error: 'Forbidden' });
    }

    res.setHeader('Access-Control-Allow-Origin', allowed ? origin : '');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const { licenseKey, templateLicenseKey } = req.body ?? {};

    let entitled = false;
    for (const raw of [licenseKey, templateLicenseKey]) {
        if (entitled) break;
        if (!raw || typeof raw !== 'string') continue;

        const normalised = raw.trim().toUpperCase();
        if (!KEY_FORMAT.test(normalised)) continue;

        try {
            const license = await redis.get(`license:${normalised}`);
            if (hasTemplateLibraryAccess(license)) entitled = true;
        } catch (err) {
            console.error('Redis error during template entitlement check:', err);
            // Skip this key rather than failing the whole request — the other
            // key (if any) still gets a fair check, and an unentitled result
            // just shows the catalog as locked, same as any unentitled user.
        }
    }

    const templates = TEMPLATE_CATALOG.map(({ prompt, ...meta }) =>
        entitled ? { ...meta, locked: false, prompt } : { ...meta, locked: true }
    );

    return res.status(200).json({ templates });
}
