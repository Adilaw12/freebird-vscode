// src/license/trialReminder.ts — nudges as a Pro trial winds down.
//
// Two mechanisms:
//   - checkTrialReminder(): one-time toast at 3/2/1 days left (each shown at
//     most once, ever, for a given trial), then a one-time graceful toast
//     once the trial has actually expired. Runs on activation.
//   - getTrialBannerState(): a persistent chat-panel banner (not a dismissible
//     toast) for the highest-stakes moments — 1 day left or just expired —
//     since a single toast is easy to miss mid-session. Read by panel.ts
//     every time it already computes license status, so it stays current
//     without needing its own polling.
//
// Both rely on TRACKED_TRIAL_KEY to still recognise "this was a trial" after
// it expires, at which point getLicenseStatus() just reports isPro:false with
// no way to tell "never had a license" apart from "trial just ended."

import * as vscode from 'vscode';
import { getLicenseStatus, LicenseStatus, UPGRADE_URL } from './validator';
import { trackEvent } from '../telemetry';

export const TRACKED_TRIAL_KEY = 'freebird.trackedTrial';
const EXPIRED_SHOWN_KEY = 'freebird.trialExpiredMessageShown';

export interface TrackedTrial {
    key: string;
    expiresAt: string;
}

export interface TrialBannerState {
    message: string;
}

/** Records the active trial so it can still be recognised once it expires. Safe to call anywhere getLicenseStatus() is already being read. */
export async function recordActiveTrial(context: vscode.ExtensionContext, status: LicenseStatus, licenseKey: string): Promise<void> {
    if (status.isPro && status.plan === 'trial' && status.expiresAt) {
        await context.globalState.update(TRACKED_TRIAL_KEY, { key: licenseKey, expiresAt: status.expiresAt } as TrackedTrial);
    }
}

/** Persistent chat-panel banner text for the trial's last day or just-expired — null otherwise. */
export function getTrialBannerState(context: vscode.ExtensionContext, status: LicenseStatus, licenseKey: string): TrialBannerState | null {
    if (!licenseKey) return null;

    if (status.isPro && status.plan === 'trial' && status.expiresAt) {
        const daysLeft = Math.ceil((new Date(status.expiresAt).getTime() - Date.now()) / (24 * 60 * 60 * 1000));
        if (daysLeft > 1) return null;
        return { message: 'Your Freebird Pro trial ends today — upgrade to keep unlimited multi-file edits, terminal commands, and checkpoints.' };
    }

    if (status.isPro) return null; // paid Pro, not a trial

    const tracked = context.globalState.get<TrackedTrial>(TRACKED_TRIAL_KEY);
    if (!tracked || tracked.key !== licenseKey) return null;
    return { message: 'Your Freebird Pro trial has ended. Upgrade anytime to get unlimited multi-file edits, terminal commands, and checkpoints back.' };
}

export async function checkTrialReminder(context: vscode.ExtensionContext): Promise<void> {
    const licenseKey = vscode.workspace.getConfiguration('freebird').get<string>('licenseKey', '').trim().toUpperCase();
    if (!licenseKey) return;

    const status = await getLicenseStatus(context);
    await recordActiveTrial(context, status, licenseKey);

    if (status.isPro && status.plan === 'trial' && status.expiresAt) {
        const daysLeft = Math.ceil((new Date(status.expiresAt).getTime() - Date.now()) / (24 * 60 * 60 * 1000));
        if (daysLeft < 1 || daysLeft > 3) return;

        const shownKey = `freebird.trialReminderShown.${daysLeft}`;
        if (context.globalState.get<boolean>(shownKey)) return;
        await context.globalState.update(shownKey, true);

        trackEvent('trial_reminder_shown', String(daysLeft));
        const action = await vscode.window.showInformationMessage(
            `Freebird trial ends in ${daysLeft} day${daysLeft === 1 ? '' : 's'} — keep unlimited multi-file edits, terminal commands, and checkpoints by upgrading to Pro.`,
            'Upgrade to Pro', 'Dismiss'
        );
        if (action === 'Upgrade to Pro') {
            trackEvent('trial_reminder_upgrade_clicked', String(daysLeft));
            vscode.env.openExternal(vscode.Uri.parse(UPGRADE_URL));
        }
        return;
    }

    // Not an active trial right now — if we previously tracked one on this
    // same key and it's no longer valid, it just expired.
    if (status.isPro) return; // active non-trial (paid Pro) — nothing to do

    const tracked = context.globalState.get<TrackedTrial>(TRACKED_TRIAL_KEY);
    if (!tracked || tracked.key !== licenseKey) return;
    if (context.globalState.get<boolean>(EXPIRED_SHOWN_KEY)) return;

    await context.globalState.update(EXPIRED_SHOWN_KEY, true);
    trackEvent('trial_expired_message_shown');
    const action = await vscode.window.showInformationMessage(
        'Your Freebird Pro trial has ended. Upgrade anytime to get unlimited multi-file edits, terminal commands, and checkpoints back.',
        'Upgrade to Pro', 'Dismiss'
    );
    if (action === 'Upgrade to Pro') {
        trackEvent('trial_expired_upgrade_clicked');
        vscode.env.openExternal(vscode.Uri.parse(UPGRADE_URL));
    }
}
