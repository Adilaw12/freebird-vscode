import * as vscode from 'vscode';
import { getStoredSession, clearSession, signInWithGitHub, GithubSession } from '../auth/github';

export const API_BASE    = 'https://freebird-backend.vercel.app';
// A dynamic redirect (api/upgrade-page.js), not a hardcoded Payment Link —
// the backend picks the actual Stripe Price server-side by cadence and the
// buyer's own country (e.g. India gets a PPP-priced, UPI-enabled Price; see
// lib/checkoutPricing.js). Every existing "Upgrade to Pro" call site in this
// extension just opens this URL, so all of them get that routing for free
// without needing their own fetch/JSON logic. Append "?cadence=annual" for
// the annual price once a UI offers that choice.
/**
 * Checkout provider switch. false = today's behaviour (Stripe via /upgrade). true =
 * Paddle: Upgrade signs the user in with GitHub, asks the backend for a signed
 * checkout link (api/link-token.js) and opens it, and the plan lands on their
 * account with no key to paste. Flip to true once Paddle is live (sandbox testing:
 * build a dev copy with it on). See openUpgrade() below.
 */
export const PADDLE_CHECKOUT_ENABLED = true;
export const EXTENSION_ID = 'TenLabs.freebird-ai';
const STRIPE_TEMPLATES_URL = 'https://buy.stripe.com/3cI6oJ3SdgUu9ys1ylfAc04';
// Used inside chat markdown links, where we can't run code. With Paddle on these are
// deep links back into the extension (handled in extension.ts), which then run openUpgrade().
/** The public checkout page. Opened with ?plan= when the buyer is not signed in; a signed link (?t=) is added when they are. */
export const CHECKOUT_PAGE_URL = 'https://ten-labs.com.au/freebird-upgrade.html';

export const UPGRADE_URL = PADDLE_CHECKOUT_ENABLED ? `vscode://${EXTENSION_ID}/upgrade?plan=pro` : `${API_BASE}/upgrade`;
export const TEMPLATES_UPGRADE_URL = PADDLE_CHECKOUT_ENABLED ? `vscode://${EXTENSION_ID}/upgrade?plan=templates` : STRIPE_TEMPLATES_URL;

const CACHE_TTL_MS   = 60 * 60 * 1000;          // 1 hour
const OFFLINE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days offline grace

export interface LicenseStatus {
    isPro: boolean;
    plan?: 'pro' | 'enterprise' | 'team' | 'trial';
    isTeamOwner?: boolean;
    email?: string;
    expiresAt?: string;
    /** Set when a key is saved but not granting Pro, so the UI can say why instead of silently showing Free. */
    reason?: 'invalid' | 'offline';
    /** Where this status came from: a pasted key, or the licence linked to the signed-in GitHub account. */
    source?: 'key' | 'account';
    /** Premium Prompt Templates access (a standalone Templates plan does not make isPro true). */
    templateLibrary?: boolean;
    billingCycle?: string;
}

export interface StartTrialResult {
    ok: boolean;
    trialEndsAt?: number;
    error?: string;
    code?: string;
}

interface CacheEntry {
    status: LicenseStatus;
    ts: number;
    key: string;
    everValidated: boolean;
}

// ── In-memory cache: survives for the VS Code session ────────────────────────
// Avoids hitting globalState (async) or the network on every message send.
let _memCache: { status: LicenseStatus; ts: number; key: string } | null = null;

const ACCOUNT_PREFIX = 'acct:';

function planFrom(data: { plan?: string }): NonNullable<LicenseStatus['plan']> {
    return data.plan === 'enterprise' ? 'enterprise' : data.plan === 'team' ? 'team' : data.plan === 'trial' ? 'trial' : 'pro';
}

/** Validates a pasted key. null = the check itself failed (offline, server error). */
async function validateKey(key: string): Promise<LicenseStatus | null> {
    try {
        const res = await fetch(`${API_BASE}/api/validate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ key }),
            signal: AbortSignal.timeout(6000)
        });
        if (!res.ok) return null;
        const data = await res.json() as { valid: boolean; email?: string; plan?: string; isTeamOwner?: boolean; expiresAt?: string };
        return {
            isPro: data.valid === true,
            plan: planFrom(data),
            isTeamOwner: data.isTeamOwner === true,
            email: data.email,
            expiresAt: data.expiresAt,
            source: 'key'
        };
    } catch {
        return null;
    }
}

/** What api/license-status.js says about the signed-in GitHub account. */
export interface AccountStatus {
    linked: boolean;
    valid: boolean;
    plan?: string;
    status?: string;
    billingCycle?: string | null;
    templateLibrary?: boolean;
    isTeamOwner?: boolean;
    email?: string | null;
    expiresAt?: string | null;
    /** Paddle's own update-card / cancel links for the subscription. */
    billing?: { update: string | null; cancel: string | null } | null;
}

export async function fetchAccountStatus(session: GithubSession): Promise<AccountStatus | null> {
    try {
        const res = await fetch(`${API_BASE}/api/license-status`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ authToken: session.sessionToken }),
            signal: AbortSignal.timeout(6000)
        });
        if (!res.ok) return null;
        return await res.json() as AccountStatus;
    } catch {
        return null;
    }
}

function statusFromAccount(a: AccountStatus): LicenseStatus {
    const paid = a.valid === true;
    return {
        isPro: paid,
        ...(paid ? {
            plan: planFrom(a),
            isTeamOwner: a.isTeamOwner === true,
            email: a.email ?? undefined,
            expiresAt: a.expiresAt ?? undefined
        } : {}),
        templateLibrary: a.templateLibrary === true,
        billingCycle: a.billingCycle ?? undefined,
        source: 'account'
    };
}

export async function getLicenseStatus(context: vscode.ExtensionContext): Promise<LicenseStatus> {
    const key = vscode.workspace
        .getConfiguration('freebird')
        .get<string>('licenseKey', '')
        .trim()
        .toUpperCase();

    // A saved key wins; with none, the licence linked to the signed-in GitHub account is used.
    const session = await getStoredSession(context);
    const id = key || (session ? `${ACCOUNT_PREFIX}${session.login}` : '');
    if (!id) return { isPro: false };

    // 1. In-memory cache — zero I/O, sub-millisecond
    if (_memCache && _memCache.key === id && Date.now() - _memCache.ts < CACHE_TTL_MS) {
        return _memCache.status;
    }

    // 2. Persistent cache (globalState) — fast local read, no network
    const persisted = context.globalState.get<CacheEntry>('licenseCache');
    if (persisted && persisted.key === id && Date.now() - persisted.ts < CACHE_TTL_MS) {
        _memCache = { status: persisted.status, ts: persisted.ts, key: id };
        return persisted.status;
    }

    // 3. Network validation — only when cache is stale
    //    keyResult: undefined = no key, null = the check failed, otherwise the answer.
    const keyResult = key ? await validateKey(key) : undefined;
    let status: LicenseStatus | null = keyResult ?? null;

    // No key, or a key that doesn't grant Pro (say an expired trial still in settings):
    // ask what the signed-in account has.
    if (session && !status?.isPro) {
        const account = await fetchAccountStatus(session);
        if (account) {
            const fromAccount = statusFromAccount(account);
            if (fromAccount.isPro) status = fromAccount;
            else if (keyResult === undefined) status = fromAccount; // no key to disagree with
        }
    }

    if (!status) return fallbackToCache(persisted, id);

    if (status.isPro) {
        const entry: CacheEntry = { status, ts: Date.now(), key: id, everValidated: true };
        await context.globalState.update('licenseCache', entry);
        if (status.source === 'key') await context.globalState.update(KEY_BACKUP, key);
        _memCache = { status, ts: Date.now(), key: id };
    } else {
        await context.globalState.update('licenseCache', undefined);
        _memCache = null;
        if (key) status.reason = 'invalid';
    }

    return status;
}

function fallbackToCache(cached: CacheEntry | null | undefined, key: string): LicenseStatus {
    if (
        cached &&
        cached.key === key &&
        cached.everValidated === true &&
        cached.status.isPro === true &&
        Date.now() - cached.ts < OFFLINE_TTL_MS
    ) {
        _memCache = { status: cached.status, ts: cached.ts, key };
        return cached.status;
    }
    return { isPro: false, reason: 'offline' };
}

// ── Key backup ───────────────────────────────────────────────────────────────
// The key normally lives in the user's settings. If that value ever disappears (a different VS Code profile,
// a remote/WSL/dev-container window, a settings reset or sync conflict) Pro silently turned into Free and the
// user had to paste the key again. A copy in the extension's own storage lets activation put it back.

const KEY_BACKUP = 'freebird.licenseKeyBackup';

/** Called at activation, before anything reads the key: restores a key the settings lost. */
export async function restoreLicenseKeyIfLost(context: vscode.ExtensionContext): Promise<boolean> {
    const cfg = vscode.workspace.getConfiguration('freebird');
    if (cfg.get<string>('licenseKey', '').trim()) return false;
    const backup = context.globalState.get<string>(KEY_BACKUP, '').trim();
    if (!backup) return false;
    try {
        await cfg.update('licenseKey', backup, true);
        return true;
    } catch {
        return false;
    }
}

/** A key the user removes from settings while VS Code is running is a deliberate removal: forget the backup too. */
export function watchLicenseKeyRemoval(context: vscode.ExtensionContext): vscode.Disposable {
    return vscode.workspace.onDidChangeConfiguration(e => {
        if (!e.affectsConfiguration('freebird.licenseKey')) return;
        const now = vscode.workspace.getConfiguration('freebird').get<string>('licenseKey', '').trim();
        if (!now) {
            context.globalState.update(KEY_BACKUP, undefined);
            context.globalState.update('licenseCache', undefined);
            _memCache = null;
        }
    });
}

export async function warmLicenseCache(context: vscode.ExtensionContext): Promise<void> {
    // Called at extension activation — runs in background, never blocks startup
    getLicenseStatus(context).catch(() => {});
}

export async function activateLicense(
    context: vscode.ExtensionContext,
    key: string
): Promise<LicenseStatus> {
    const normalised = key.trim().toUpperCase();
    await vscode.workspace.getConfiguration('freebird').update('licenseKey', normalised, true);
    await context.globalState.update('licenseCache', undefined);
    _memCache = null; // clear in-memory cache too
    return getLicenseStatus(context);
}

export function clearLicenseCache(context: vscode.ExtensionContext): void {
    context.globalState.update('licenseCache', undefined);
    _memCache = null;
}

/**
 * Synchronous, cache-only license check. For gates that can't await (like
 * getProvider, called from hot paths such as tab completion). Fails CLOSED —
 * if the cache hasn't warmed yet or has expired, this returns isPro: false
 * rather than risk treating an unverified user as licensed. warmLicenseCache
 * is called at activation specifically so this cache is populated well before
 * any BYOK call would need it.
 */
/**
 * Last known-good Pro status from the persisted cache, read synchronously with
 * NO freshness check and NO network. Only for painting the UI instantly at
 * window open (Pro badge, status bar) so it doesn't sit in an unlicensed-looking
 * state for the seconds the real validation takes — the real result always
 * follows and replaces it. Never use this to gate a feature.
 */
export function getPersistedLicenseHint(context: vscode.ExtensionContext): LicenseStatus | undefined {
    const key = vscode.workspace.getConfiguration('freebird').get<string>('licenseKey', '').trim().toUpperCase();
    const persisted = context.globalState.get<CacheEntry>('licenseCache');
    if (!persisted || persisted.status.isPro !== true) return undefined;
    // With a key saved the cache must be for that key; with none, only an account entry counts.
    return key
        ? (persisted.key === key ? persisted.status : undefined)
        : (persisted.key.startsWith(ACCOUNT_PREFIX) ? persisted.status : undefined);
}

export function getCachedLicenseStatus(): LicenseStatus {
    if (_memCache && Date.now() - _memCache.ts < CACHE_TTL_MS) {
        return _memCache.status;
    }
    return { isPro: false };
}

/** Loose format check, enough to catch typos. The backend checks the same shape. */
export function isValidEmail(value: string): boolean {
    return value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

/**
 * Claims a self-serve 7-day Pro trial for this device (machineId-gated, no
 * sign-in required) and, on success, activates it immediately — no manual
 * key copy/paste needed. The email is optional and is only used for trial
 * reminders and account help.
 */
export async function startTrial(
    context: vscode.ExtensionContext,
    machineId: string,
    email?: string
): Promise<StartTrialResult> {
    try {
        const res = await fetch(`${API_BASE}/api/start-trial`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ machineId, ...(email && { email }) }),
            signal: AbortSignal.timeout(10_000)
        });

        const data = await res.json() as { key?: string; trialEndsAt?: number; error?: string; code?: string };

        if (!res.ok || !data.key) {
            return { ok: false, error: data.error ?? 'Could not start trial.', code: data.code };
        }

        await activateLicense(context, data.key);
        return { ok: true, trialEndsAt: data.trialEndsAt };
    } catch (err: any) {
        return { ok: false, error: err?.message ?? 'Network error starting trial.' };
    }
}

/**
 * Asks the backend for a Stripe customer-portal link, so a Pro subscriber can
 * cancel, change their card, or download invoices. Only works for Stripe-paid
 * licenses; trials and other providers get an error explaining that.
 */
export async function openBillingPortal(licenseKey: string): Promise<{ url?: string; update?: string | null; cancel?: string | null; error?: string; code?: string }> {
    try {
        const res = await fetch(`${API_BASE}/api/billing-portal`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ key: licenseKey }),
            signal: AbortSignal.timeout(10_000)
        });
        const data = await res.json() as { url?: string; update?: string | null; cancel?: string | null; error?: string; code?: string };
        if (!res.ok || !data.url) {
            return { error: data.error ?? 'Could not open billing.', code: data.code };
        }
        return { url: data.url, update: data.update, cancel: data.cancel };
    } catch (err: any) {
        return { error: err?.message ?? 'Network error opening billing.' };
    }
}

// ── Upgrading, and saving a purchase to the GitHub account ───────────────────

export type UpgradePlan = 'pro' | 'pro-annual' | 'templates' | 'team';
const UPGRADE_PLANS: UpgradePlan[] = ['pro', 'pro-annual', 'templates', 'team'];
export function isUpgradePlan(v: unknown): v is UpgradePlan {
    return typeof v === 'string' && (UPGRADE_PLANS as string[]).includes(v);
}

/** Fired when the account's plan may have changed (purchase finished, sign-in, link). */
export const onLicenseChanged = new vscode.EventEmitter<void>();

async function signInForPurchase(context: vscode.ExtensionContext, intro: string): Promise<GithubSession | null> {
    try {
        return await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: 'Waiting for GitHub sign-in…', cancellable: false },
            () => signInWithGitHub(context, intro)
        );
    } catch (err: any) {
        if (err?.message !== 'CANCELLED') vscode.window.showErrorMessage(`GitHub sign-in failed: ${err?.message ?? err}`);
        return null;
    }
}

/**
 * The one entry point for every "Upgrade" button. With Paddle on: sign in with
 * GitHub if needed, get a signed checkout link for this account, open it, then
 * watch for the plan to appear. With it off: the old Stripe behaviour.
 */
export async function openUpgrade(context: vscode.ExtensionContext, plan: UpgradePlan = 'pro'): Promise<void> {
    if (!PADDLE_CHECKOUT_ENABLED) {
        const url = plan === 'templates' ? STRIPE_TEMPLATES_URL
            : plan === 'pro-annual' ? `${API_BASE}/upgrade?cadence=annual`
            : `${API_BASE}/upgrade`;
        await vscode.env.openExternal(vscode.Uri.parse(url));
        return;
    }

    // Signing in is optional: it saves the plan to the GitHub account and switches the extension on
    // by itself. Without it the buyer pays on the plain page and pastes the license key once.
    const openPlainCheckout = async () => {
        
        await vscode.env.openExternal(vscode.Uri.parse(`${CHECKOUT_PAGE_URL}?plan=${encodeURIComponent(plan)}`));
        vscode.window.showInformationMessage(
            'After you pay, the confirmation shows your license key. Then run "Freebird: Activate License" and paste it.'
        );
    };

    let session = await getStoredSession(context);
    if (!session) {
        const pick = await vscode.window.showInformationMessage(
            'Sign in with GitHub to save your plan to your account (no license key to paste), or continue without signing in.',
            'Sign in with GitHub', 'Continue without signing in'
        );
        if (!pick) return;
        if (pick === 'Sign in with GitHub') {
            session = await signInForPurchase(context, 'Sign in with GitHub to save your plan to your account (no license key to paste)');
        }
        if (!session) { await openPlainCheckout(); return; }
    }

    const requestLink = (s: GithubSession) => fetch(`${API_BASE}/api/link-token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ authToken: s.sessionToken, plan }),
        signal: AbortSignal.timeout(10_000)
    });

    try {
        let res = await requestLink(session);
        if (res.status === 401) {
            // The saved sign-in expired: sign in again once.
            await clearSession(context);
            session = await signInForPurchase(context, 'Your Freebird sign-in expired. Sign in with GitHub to continue');
            if (!session) { await openPlainCheckout(); return; }
            res = await requestLink(session);
        }
        const data = await res.json().catch(() => ({})) as { url?: string; error?: string; code?: string };

        if (res.ok && data.url) {
            await vscode.env.openExternal(vscode.Uri.parse(data.url));
            watchForUpgrade(context, plan);
            return;
        }
        if (res.status === 409) {
            // Already has it (or it is bundled): say so and refresh what the extension believes.
            vscode.window.showInformationMessage(data.error ?? 'You already have this plan.');
            clearLicenseCache(context);
            onLicenseChanged.fire();
            return;
        }
        if (res.status === 403) {
            // Region block: never route around it.
            vscode.window.showErrorMessage(data.error ?? 'Checkout is not available in your region.');
            return;
        }
        vscode.window.showWarningMessage(data.error ?? 'Could not start the account-linked checkout. Continuing without signing in.');
        await openPlainCheckout();
    } catch {
        vscode.window.showWarningMessage('Could not reach Freebird to start the account-linked checkout. Continuing without signing in.');
        await openPlainCheckout();
    }
}

let _watchTimer: ReturnType<typeof setTimeout> | undefined;

/** After checkout opens, polls the account until the purchase shows up (up to 20 minutes). */
export function watchForUpgrade(context: vscode.ExtensionContext, plan: UpgradePlan): void {
    if (_watchTimer) clearTimeout(_watchTimer);
    const until = Date.now() + 20 * 60 * 1000;

    const tick = async () => {
        _watchTimer = undefined;
        if (Date.now() > until) return;
        const session = await getStoredSession(context);
        const a = session ? await fetchAccountStatus(session) : null;
        const done = a && (plan === 'templates' ? a.templateLibrary === true
            : plan === 'team' ? a.valid && a.plan === 'team'
            : a.valid);
        if (done && a) {
            clearLicenseCache(context);
            onLicenseChanged.fire();
            vscode.window.showInformationMessage(
                plan === 'templates'
                    ? 'Premium Prompt Templates are active on your account. Enjoy!'
                    : `Freebird ${a.plan === 'team' ? 'Team' : 'Pro'} is active on your account. Enjoy!`
            );
            return;
        }
        _watchTimer = setTimeout(tick, 5000);
    };
    _watchTimer = setTimeout(tick, 5000);
}

/**
 * After someone activates a paid key by hand, offer to save it to their GitHub
 * account so they never paste it again (on any machine).
 */
export async function offerAccountLink(context: vscode.ExtensionContext, key: string): Promise<void> {
    let session = await getStoredSession(context);
    if (!session) {
        const pick = await vscode.window.showInformationMessage(
            'Save this license to your GitHub account? You will not need to paste the key again, on this or any other machine.',
            'Sign in and save', 'Not now'
        );
        if (pick !== 'Sign in and save') return;
        session = await signInForPurchase(context, 'Sign in with GitHub to save your license to your account');
        if (!session) return;
    }
    try {
        const res = await fetch(`${API_BASE}/api/link-license`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ authToken: session.sessionToken, key }),
            signal: AbortSignal.timeout(10_000)
        });
        const data = await res.json().catch(() => ({})) as { error?: string };
        if (res.ok) {
            vscode.window.showInformationMessage('License saved to your GitHub account.');
            onLicenseChanged.fire();
        } else {
            vscode.window.showWarningMessage(data.error ?? 'Could not save the license to your account. Your key still works.');
        }
    } catch {
        vscode.window.showWarningMessage('Could not reach Freebird to save the license. Your key still works.');
    }
}

/** Paddle's update-card / cancel links for the signed-in account, if it has a Paddle subscription. */
export async function getAccountBilling(context: vscode.ExtensionContext): Promise<{ update: string | null; cancel: string | null } | null> {
    const session = await getStoredSession(context);
    if (!session) return null;
    const a = await fetchAccountStatus(session);
    return a?.billing ?? null;
}
