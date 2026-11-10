// api/license-status.js — POST { authToken } -> what the signed-in account has.
//
// Replaces typing a key: the licence linked to this GitHub account (by the Paddle
// webhook, or by api/link-license.js) is found from the session token alone.
// The key itself is never returned; chat/fallback/templates resolve it server-side
// from the same token (lib/licenseResolve.js).

import { Redis } from '@upstash/redis';
import { verifySession } from '../lib/authToken.js';
import { isLicenseActive, hasTemplateLibraryAccess } from '../lib/license.js';
import { githubLicenseKey } from '../lib/licenseResolve.js';
import { handleCors } from '../lib/cors.js';
import { resolveManageLinks } from '../lib/paddleManage.js';

const redis = Redis.fromEnv();

export default async function handler(req, res) {
    if (handleCors(req, res)) return;

    const session = verifySession(req.body?.authToken);
    if (!session) return res.status(401).json({ error: 'Sign in with GitHub first.', code: 'AUTH_REQUIRED' });

    let license = null;
    try {
        const key = await redis.get(githubLicenseKey(session.sub));
        license = key ? await redis.get(`license:${String(key).toUpperCase()}`) : null;
    } catch (err) {
        console.error('license-status: Redis error:', err);
        return res.status(500).json({ error: 'Licence service unavailable' }); // client keeps its cache
    }

    if (!license) return res.status(200).json({ linked: false, valid: false });

    return res.status(200).json({
        linked: true,
        valid: isLicenseActive(license),
        plan: license.plan ?? 'pro',
        status: license.status,
        billingCycle: license.billingCycle ?? null,
        templateLibrary: hasTemplateLibraryAccess(license),
        isTeamOwner: license.plan === 'team' && license.teamOwnerKey != null && license.githubId === String(session.sub) && license.teamOwnerKey === license.key,
        email: license.email ?? null,
        expiresAt: license.expiresAt ?? null,
        billing: await resolveManageLinks(license, { redis })
    });
}
