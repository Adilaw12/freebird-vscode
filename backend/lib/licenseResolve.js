// backend/lib/licenseResolve.js — which licence key does this request belong to?
//
// A request can prove its licence two ways:
//   1. a pasted key (licenseKey) — trials, Team seats, and anyone who has not
//      linked their GitHub account;
//   2. a GitHub-verified session token (authToken) — the licence linked to that
//      account by api/link-license.js or by the Paddle webhook.
// An explicit key wins; otherwise the signed-in account's linked key is used.
// Everything downstream (isLicenseActive, premium counters) keeps working on the
// key, so chat/fallback/templates change by one line each.

import { verifySession } from './authToken.js';
import { isLicenseActive, hasTemplateLibraryAccess } from './license.js';

export const githubLicenseKey = githubId => `ghlicense:${githubId}`;

const entitled = lic => isLicenseActive(lic) || hasTemplateLibraryAccess(lic);

/**
 * @param {import('@upstash/redis').Redis} redis
 * @param {{ licenseKey?: unknown, authToken?: unknown }} input
 * @returns {Promise<string|null>} normalised key, or null
 */
export async function resolveLicenseKey(redis, { licenseKey, authToken }) {
    const explicit = (licenseKey && typeof licenseKey === 'string' && licenseKey.trim())
        ? licenseKey.trim().toUpperCase()
        : null;

    const session = authToken ? verifySession(authToken) : null;
    let linked = null;
    if (session?.sub) {
        try {
            const k = await redis.get(githubLicenseKey(session.sub));
            linked = typeof k === 'string' && k ? k.toUpperCase() : null;
        } catch (err) {
            console.error('Linked-licence lookup error:', err);
        }
    }

    if (!explicit) return linked;
    if (!linked || linked === explicit) return explicit;

    // Both present and different (say an expired trial key still in settings, and a
    // paid licence on the account): use whichever one is actually entitled.
    try {
        const explicitLicense = await redis.get(`license:${explicit}`);
        return entitled(explicitLicense) ? explicit : linked;
    } catch (err) {
        console.error('Licence lookup error:', err);
        return explicit;
    }
}
