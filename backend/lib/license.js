// backend/lib/license.js — shared "is this license currently entitled?" check.
// Used by chat.js, fallback.js, and validate.js so trial-expiry logic (and any
// future plan type) only needs to change in one place.

export const TRIAL_DAYS = 7;

export function isLicenseActive(license) {
    if (!license || license.status !== 'active') return false;

    if (license.plan === 'trial') {
        return typeof license.trialEndsAt === 'number' && Date.now() < license.trialEndsAt;
    }

    return ['pro', 'enterprise', 'team'].includes(license.plan);
}
