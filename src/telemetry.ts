import * as vscode from 'vscode';

let _enabled = false;
let _context: vscode.ExtensionContext | undefined;

const SESSION_KEY = 'freebird.telemetrySession';

interface SessionData {
    sessionId: string;
    startedAt: string;
    events: Record<string, number>;
}

export function initTelemetry(context: vscode.ExtensionContext): void {
    _context = context;
    _enabled = vscode.workspace.getConfiguration('freebird').get<boolean>('telemetry.enabled', true);

    const session: SessionData = {
        sessionId: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        startedAt: new Date().toISOString(),
        events: {}
    };
    context.globalState.update(SESSION_KEY, session);

    trackEvent('extension_activated');

    vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('freebird.telemetry.enabled')) {
            _enabled = vscode.workspace.getConfiguration('freebird').get<boolean>('telemetry.enabled', true);
        }
    });
}

export function trackEvent(name: string): void {
    if (!_enabled || !_context) return;

    const session = _context.globalState.get<SessionData>(SESSION_KEY);
    if (!session) return;

    session.events[name] = (session.events[name] ?? 0) + 1;
    _context.globalState.update(SESSION_KEY, session);
}

export function getSessionStats(): Record<string, number> | null {
    if (!_context) return null;
    const session = _context.globalState.get<SessionData>(SESSION_KEY);
    return session?.events ?? null;
}
