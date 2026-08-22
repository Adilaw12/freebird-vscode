// backend/lib/license.js — shared "is this license currently entitled?" check.
// Used by chat.js, fallback.js, and validate.js so trial-expiry logic (and any
// future plan type) only needs to change in one place.

export const TRIAL_DAYS = 7;

export function isLicenseActive(license) {
    if (!license || license.status !== 'active') return false;

    if (license.plan === 'trial') {
        // trialEndsAt was originally stored as raw epoch ms; now stored as an
        // ISO string for readability in the Redis console (matches
        // createdAt/updatedAt). new Date() parses both, so this stays
        // correct for trials created either way — no data migration needed.
        const endsAtMs = new Date(license.trialEndsAt).getTime();
        return !Number.isNaN(endsAtMs) && Date.now() < endsAtMs;
    }

    return ['pro', 'enterprise', 'team'].includes(license.plan);
}

// Template library access: bundled free for anyone with active Pro/Enterprise/
// Team/trial (isLicenseActive), OR a standalone templates-only purchase. This
// only ever ADDS entitlement on top of isLicenseActive — never subtracts from
// it — so a templates-only license (plan: 'templates') can't affect Pro/chat/
// fallback gating, since isLicenseActive's own plan whitelist excludes it.
export function hasTemplateLibraryAccess(license) {
    if (!license || license.status !== 'active') return false;
    if (isLicenseActive(license)) return true;
    return license.templateLibrary === true;
}
