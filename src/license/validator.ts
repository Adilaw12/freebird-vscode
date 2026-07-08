import * as vscode from 'vscode';

export const API_BASE    = 'https://freebird-backend.vercel.app';
export const UPGRADE_URL = 'https://buy.stripe.com/9B628t4WheMmeSMccZfAc03';

const CACHE_TTL_MS   = 60 * 60 * 1000;          // 1 hour
const OFFLINE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days offline grace

export interface LicenseStatus {
    isPro: boolean;
    plan?: 'pro' | 'enterprise' | 'team' | 'trial';
    isTeamOwner?: boolean;
    email?: string;
    expiresAt?: string;
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

export async function getLicenseStatus(context: vscode.ExtensionContext): Promise<LicenseStatus> {
    const key = vscode.workspace
        .getConfiguration('freebird')
        .get<string>('licenseKey', '')
        .trim()
        .toUpperCase();

    if (!key) return { isPro: false };

    // 1. In-memory cache — zero I/O, sub-millisecond
    if (_memCache && _memCache.key === key && Date.now() - _memCache.ts < CACHE_TTL_MS) {
        return _memCache.status;
    }

    // 2. Persistent cache (globalState) — fast local read, no network
    const persisted = context.globalState.get<CacheEntry>('licenseCache');
    if (persisted && persisted.key === key && Date.now() - persisted.ts < CACHE_TTL_MS) {
        _memCache = { status: persisted.status, ts: persisted.ts, key };
        return persisted.status;
    }

    // 3. Network validation — only when cache is stale
    try {
        const res = await fetch(`${API_BASE}/api/validate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ key }),
            signal: AbortSignal.timeout(6000)
        });

        if (!res.ok) return fallbackToCache(persisted, key);

        const data = await res.json() as { valid: boolean; email?: string; plan?: string; isTeamOwner?: boolean; expiresAt?: string };
        const status: LicenseStatus = {
            isPro: data.valid === true,
            plan: data.plan === 'enterprise' ? 'enterprise' : data.plan === 'team' ? 'team' : data.plan === 'trial' ? 'trial' : 'pro',
            isTeamOwner: data.isTeamOwner === true,
            email: data.email,
            expiresAt: data.expiresAt
        };

        if (status.isPro) {
            const entry: CacheEntry = { status, ts: Date.now(), key, everValidated: true };
            await context.globalState.update('licenseCache', entry);
            _memCache = { status, ts: Date.now(), key };
        } else {
            await context.globalState.update('licenseCache', undefined);
            _memCache = null;
        }

        return status;

    } catch {
        return fallbackToCache(persisted, key);
    }
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
    return { isPro: false };
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
 * Claims a self-serve 7-day Pro trial for the signed-in GitHub account and,
 * on success, activates it immediately — no manual key copy/paste needed.
 */
export async function startTrial(
    context: vscode.ExtensionContext,
    sessionToken: string
): Promise<StartTrialResult> {
    try {
        const res = await fetch(`${API_BASE}/api/start-trial`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ authToken: sessionToken }),
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
