import * as vscode from 'vscode';
import { API_BASE } from './license/validator';
import { getMachineId, trackEvent } from './telemetry';

export type FeedbackTrigger = 'result' | 'failure' | 'manual';

export interface FeedbackSubmission {
    trigger: FeedbackTrigger;
    rating?: 'up' | 'down';
    reason?: string;
    text?: string;
    /** Bounded classifier for what the user was doing (an error code or feature) — never free text. */
    context?: string;
}

const DAY_KEY = 'freebird.feedbackPromptDay';
const SUCCESS_KEY = 'freebird.feedbackSuccessCount';
const IGNORED_KEY = 'freebird.feedbackIgnored';

// Results a user must have received before the first unprompted "was this
// useful?" — let them get a feel for the product first.
const MIN_SUCCESSES_BEFORE_ASK = 3;
// Dismissals in a row (with no engagement in between) after which unprompted
// asks stop for good. The Feedback button stays available either way.
const MAX_IGNORED = 3;

const today = () => new Date().toISOString().slice(0, 10);

/** Counts a delivered result toward the "settled in" threshold. */
export async function recordResultDelivered(context: vscode.ExtensionContext): Promise<void> {
    await context.globalState.update(SUCCESS_KEY, (context.globalState.get<number>(SUCCESS_KEY) ?? 0) + 1);
}

/**
 * Global cap across every unprompted ask: at most one per day, never before the
 * user has had a few results, never once they have ignored it repeatedly, and
 * never if they turned it off.
 */
export function canAutoPrompt(context: vscode.ExtensionContext, kind: 'result' | 'failure'): boolean {
    if (!vscode.workspace.getConfiguration('freebird').get<boolean>('feedbackPrompts', true)) return false;
    if ((context.globalState.get<number>(IGNORED_KEY) ?? 0) >= MAX_IGNORED) return false;
    if (context.globalState.get<string>(DAY_KEY) === today()) return false;
    // A failure is when users have something specific to say, so it skips the warm-up.
    if (kind === 'result' && (context.globalState.get<number>(SUCCESS_KEY) ?? 0) < MIN_SUCCESSES_BEFORE_ASK) return false;
    return true;
}

export async function markPrompted(context: vscode.ExtensionContext): Promise<void> {
    await context.globalState.update(DAY_KEY, today());
}

export async function recordDismissed(context: vscode.ExtensionContext): Promise<void> {
    await context.globalState.update(IGNORED_KEY, (context.globalState.get<number>(IGNORED_KEY) ?? 0) + 1);
}

export async function recordEngaged(context: vscode.ExtensionContext): Promise<void> {
    await context.globalState.update(IGNORED_KEY, 0);
}

/** Sends one piece of feedback. Returns false if it could not be delivered. */
export async function submitFeedback(context: vscode.ExtensionContext, f: FeedbackSubmission): Promise<boolean> {
    const config = vscode.workspace.getConfiguration('freebird');
    try {
        const res = await fetch(`${API_BASE}/api/feedback`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                ...f,
                meta: {
                    machineId: getMachineId(),
                    version: context.extension.packageJSON.version,
                    platform: process.platform,
                    backend: config.get<string>('backend', 'cloud')
                }
            }),
            signal: AbortSignal.timeout(8000)
        });
        if (!res.ok) return false;
        await recordEngaged(context);
        trackEvent('feedback_submitted', `${f.trigger}:${f.rating ?? 'note'}`);
        return true;
    } catch {
        return false;
    }
}
