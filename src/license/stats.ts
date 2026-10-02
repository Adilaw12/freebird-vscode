import * as vscode from 'vscode';

/**
 * Lifetime engagement counters for the "Pro usage analytics" display —
 * purely a retention/investment signal for existing Pro subscribers, not
 * a quota (see license/usage.ts for the actual enforced daily quota
 * mirror). Stored client-side only; nothing here is validated server-side
 * because nothing here gates anything — it's just a running tally.
 */

const EDITS_KEY      = 'freebird.lifetimeEditsUsed';
const AGENT_RUNS_KEY  = 'freebird.lifetimeAgentRuns';

// Deliberately a rough estimate, not a real measurement — there's no way
// to know how long a user would have taken by hand. Picked as a plausible
// "a human doing this manually" baseline: a one-shot edit saves a couple
// minutes of typing/context-switching; a full Agent-mode run (multi-file,
// tool-driven) stands in for meaningfully more manual work. Tune here if
// the displayed number ever needs to change — nothing else references
// these constants.
const SECONDS_SAVED_PER_EDIT      = 90;
const SECONDS_SAVED_PER_AGENT_RUN = 300;

/** Call once per successfully-served cloud edit (mirrors the cloud_edit_used event). */
export function recordEditUsed(context: vscode.ExtensionContext): void {
    const current = context.globalState.get<number>(EDITS_KEY, 0);
    context.globalState.update(EDITS_KEY, current + 1);
}

/** Call once per completed Agent-mode turn that made at least one tool call. */
export function recordAgentRun(context: vscode.ExtensionContext): void {
    const current = context.globalState.get<number>(AGENT_RUNS_KEY, 0);
    context.globalState.update(AGENT_RUNS_KEY, current + 1);
}

export interface UsageStats {
    edits: number;
    agentRuns: number;
    secondsSaved: number;
}

export function getUsageStats(context: vscode.ExtensionContext): UsageStats {
    const edits = context.globalState.get<number>(EDITS_KEY, 0);
    const agentRuns = context.globalState.get<number>(AGENT_RUNS_KEY, 0);
    const secondsSaved = edits * SECONDS_SAVED_PER_EDIT + agentRuns * SECONDS_SAVED_PER_AGENT_RUN;
    return { edits, agentRuns, secondsSaved };
}
