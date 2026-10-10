import * as vscode from 'vscode';
import { API_BASE } from './license/validator';
import { trackEvent } from './telemetry';

const LAST_CHECK_KEY = 'freebird.announcementLastCheck';
const DISMISSED_KEY  = 'freebird.announcementDismissed'; // stores the message text last dismissed
export const LATEST_VERSION_KEY = 'freebird.latestVersion'; // newest published version, from the same endpoint
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // once per day is plenty

interface Announcement {
    message: string | null;
    latestVersion?: string;
    variant?: string;
    cta?: string;
    ctaAction?: string;
}

/** True when `current` is an older dotted version than `latest` (0.15.0 < 0.15.1). */
export function isOlderVersion(current: string, latest: string): boolean {
    const a = current.split('.').map(Number);
    const b = latest.split('.').map(Number);
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
        const x = a[i] ?? 0;
        const y = b[i] ?? 0;
        if (x !== y) return x < y;
    }
    return false;
}

/**
 * Checks api/announcement.js for a founder message and shows it once per
 * distinct message (not once ever — a new announcement should still show
 * even if an old one was dismissed). Safe to call on every activation; it
 * self-throttles to one network call per day.
 */
export async function checkAnnouncement(context: vscode.ExtensionContext): Promise<void> {
    const lastCheck = context.globalState.get<number>(LAST_CHECK_KEY, 0);
    if (Date.now() - lastCheck < CHECK_INTERVAL_MS) return;
    await context.globalState.update(LAST_CHECK_KEY, Date.now());

    let data: Announcement;
    try {
        const res = await fetch(`${API_BASE}/api/announcement`, { signal: AbortSignal.timeout(6000) });
        if (!res.ok) return;
        data = await res.json() as Announcement;
    } catch {
        return; // silent — an announcement is never critical path
    }

    // Recorded before the message check: the version nudge is independent of whether there is an announcement.
    if (data.latestVersion) await context.globalState.update(LATEST_VERSION_KEY, data.latestVersion);

    if (!data.message) return;

    const alreadyDismissed = context.globalState.get<string>(DISMISSED_KEY);
    if (alreadyDismissed === data.message) return; // this exact message was already shown/dismissed

    trackEvent('announcement_shown');
    const action = data.cta
        ? await vscode.window.showInformationMessage(data.message, data.cta, 'Dismiss')
        : await vscode.window.showInformationMessage(data.message, 'Dismiss');

    await context.globalState.update(DISMISSED_KEY, data.message);

    if (action === data.cta && data.ctaAction) {
        trackEvent('announcement_cta_clicked');
        if (/^https?:|^mailto:/.test(data.ctaAction)) {
            vscode.env.openExternal(vscode.Uri.parse(data.ctaAction));
        } else {
            // Treat anything else as a VS Code command id
            vscode.commands.executeCommand(data.ctaAction);
        }
    }
}
