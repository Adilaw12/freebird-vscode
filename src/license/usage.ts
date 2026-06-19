import * as vscode from 'vscode';

const TRIAL_KEY = 'freebird.agentTrialUsage';
export const DAILY_CLOUD_LIMIT = 5;

interface TrialUsage {
    day: string; // "YYYY-MM-DD"
    count: number;
}

function today(): string {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

function readUsage(context: vscode.ExtensionContext): TrialUsage {
    const stored = context.globalState.get<TrialUsage>(TRIAL_KEY);
    const day = today();
    if (!stored || stored.day !== day) {
        return { day, count: 0 };
    }
    return stored;
}

export function getCloudEditsRemaining(context: vscode.ExtensionContext): number {
    return Math.max(0, DAILY_CLOUD_LIMIT - readUsage(context).count);
}

export async function consumeCloudEdit(context: vscode.ExtensionContext): Promise<number> {
    const usage = readUsage(context);
    usage.count++;
    await context.globalState.update(TRIAL_KEY, usage);
    return Math.max(0, DAILY_CLOUD_LIMIT - usage.count);
}
