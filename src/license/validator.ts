import * as vscode from 'vscode';

// Update both constants after deploying the backend
export const API_BASE    = 'https://openpilot.tenlabs.io';
export const UPGRADE_URL = 'https://openpilot.tenlabs.io/upgrade';

const CACHE_TTL_MS    = 60 * 60 * 1000;          // 1 hour — normal refresh interval
const OFFLINE_TTL_MS  = 7 * 24 * 60 * 60 * 1000; // 7 days — offline grace period

export interface LicenseStatus {
    isPro: boolean;
    email?: string;
    expiresAt?: string;
}

interface CacheEntry {
    status: LicenseStatus;
    ts: number;
    key: string;
}

export async function getLicenseStatus(context: vscode.ExtensionContext): Promise<LicenseStatus> {
    const key = vscode.workspace
        .getConfiguration('openpilot')
        .get<string>('licenseKey', '')
        .trim()
        .toUpperCase();

    if (!key) return { isPro: false };

    const cached = context.globalState.get<CacheEntry>('licenseCache');

    // Return cached result if it's fresh and the key hasn't changed
    if (cached && cached.key === key && Date.now() - cached.ts < CACHE_TTL_MS) {
        return cached.status;
    }

    try {
        const res = await fetch(`${API_BASE}/api/validate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ key }),
            signal: AbortSignal.timeout(5000)
        });

        if (!res.ok) return { isPro: false };

        const data = await res.json() as { valid: boolean; email?: string; expiresAt?: string };
        const status: LicenseStatus = {
            isPro: data.valid === true,
            email: data.email,
            expiresAt: data.expiresAt
        };

        await context.globalState.update('licenseCache', { status, ts: Date.now(), key } satisfies CacheEntry);
        return status;

    } catch {
        // Network failure — use stale cache within the 7-day grace period
        if (cached && cached.key === key && Date.now() - cached.ts < OFFLINE_TTL_MS) {
            return cached.status;
        }
        return { isPro: false };
    }
}

export async function activateLicense(
    context: vscode.ExtensionContext,
    key: string
): Promise<LicenseStatus> {
    const normalised = key.trim().toUpperCase();
    await vscode.workspace.getConfiguration('openpilot').update('licenseKey', normalised, true);
    await context.globalState.update('licenseCache', undefined); // force re-check
    return getLicenseStatus(context);
}

export function clearLicenseCache(context: vscode.ExtensionContext): void {
    context.globalState.update('licenseCache', undefined);
}
