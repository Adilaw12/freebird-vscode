import * as vscode from 'vscode';

/**
 * v0.8.9 — single source of truth for quota is the SERVER.
 *
 * Previously this module kept its own local 5-edit/day counter, fully
 * independent of the backend's 20/day Redis quota. The two disagreed:
 * the walkthrough promised 20/day, the picker said 5/day, the UI showed
 * "4 left" after one edit (5 − 1), and after the local counter hit zero
 * users were silently shunted into an Ollama-fallback path — surfacing
 * "Ollama is not reachable" warnings to people who never installed
 * Ollama — while the server would happily have served them 15 more
 * edits. The real quota wall (server-side QUOTA_EXCEEDED at 20) almost
 * never fired, which is why quota_wall_shown ≈ 0 and conversions were 0.
 *
 * Now: the client keeps only a display mirror, updated from the
 * X-Quota-Remaining header on every /api/chat response (see cloud.ts).
 * Enforcement lives in one place — backend/api/chat.js.
 */

/** Mirror of DAILY_LIMIT in backend/api/chat.js. Display only — the server enforces. */
export const DAILY_CLOUD_LIMIT = 20;

/** globalState key written by CloudProvider from the X-Quota-Remaining header. */
export const QUOTA_KEY = 'freebird.cloudQuotaRemaining';

/**
 * Last server-reported remaining quota. Before the first request of the
 * day (or ever) there is no server value yet — report the full limit and
 * let the server correct it on the first response.
 */
export function getCloudEditsRemaining(context: vscode.ExtensionContext): number {
    const v = context.globalState.get<number>(QUOTA_KEY);
    if (typeof v !== 'number' || !isFinite(v) || v < 0) return DAILY_CLOUD_LIMIT;
    return Math.min(v, DAILY_CLOUD_LIMIT);
}
