import * as vscode from 'vscode';

// Free Agent-mode runs for free-tier users — a taste of Pro's headline feature
// without the 7-day trial's open-ended cost. The server (backend/api/chat.js)
// enforces the real, cost-bounding cap as a lifetime budget of model requests
// per identity; this module only tracks runs locally so the UI can say "2 left"
// and so we don't start a run the server is about to refuse.
//
// BYOK runs cost Freebird nothing (the user's own key pays), so that cap is
// purely about conversion and is a little more generous.

const USED_KEY = 'freebird.agentTrialRunsUsed';

export const FREE_AGENT_RUNS_CLOUD = 3;
export const FREE_AGENT_RUNS_BYOK  = 5;

/** A free run is capped well below the normal 15 iterations — it bounds cost
 *  per run, and a taste doesn't need to be an unbounded loop. The server's
 *  request budget (24) assumes this number. */
export const AGENT_TRIAL_MAX_ITERATIONS = 8;

export function freeAgentRunsAllowed(byok: boolean): number {
    return byok ? FREE_AGENT_RUNS_BYOK : FREE_AGENT_RUNS_CLOUD;
}

export function getAgentTrialRunsLeft(context: vscode.ExtensionContext, byok: boolean): number {
    const used = context.globalState.get<number>(USED_KEY, 0);
    return Math.max(0, freeAgentRunsAllowed(byok) - used);
}

/** Call once per completed run that actually used tools. */
export async function recordAgentTrialRun(context: vscode.ExtensionContext): Promise<void> {
    const used = context.globalState.get<number>(USED_KEY, 0);
    await context.globalState.update(USED_KEY, used + 1);
}

/** The server said the budget is gone (e.g. a second device or a reinstall) —
 *  stop offering runs locally too. */
export async function markAgentTrialExhausted(context: vscode.ExtensionContext): Promise<void> {
    await context.globalState.update(USED_KEY, Math.max(FREE_AGENT_RUNS_CLOUD, FREE_AGENT_RUNS_BYOK));
}
