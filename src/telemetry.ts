import * as vscode from 'vscode';

const API_BASE = 'https://freebird-backend.vercel.app';
const FLUSH_INTERVAL_MS = 60_000; // flush every 60 seconds
const SESSION_KEY = 'freebird.telemetrySession';

let _enabled = false;
let _context: vscode.ExtensionContext | undefined;
let _machineId = '';
let _sessionId = '';
// name -> detail -> count. detail is '' for events tracked without one, so a
// single event name can carry both plain and detailed occurrences.
let _pendingEvents: Record<string, Record<string, number>> = {};
let _flushTimer: ReturnType<typeof setInterval> | undefined;

interface SessionData {
    sessionId: string;
    machineId: string;
    startedAt: string;
    events: Record<string, number>;
}

export function initTelemetry(context: vscode.ExtensionContext): void {
    _context = context;
    _enabled = vscode.workspace.getConfiguration('freebird').get<boolean>('telemetry.enabled', true);

    // Stable per-machine ID. Used as the quota key (see getProvider / quota
    // requests) so the daily limit can't be reset by quitting VS Code and
    // reopening — machineId persists across restarts. Also reported in
    // telemetry for unique-user analytics.
    _machineId = `m-${vscode.env.machineId.replace(/[^a-zA-Z0-9]/g, '').slice(0, 40)}`;

    // Per-launch session ID for session-level analytics. Namespaced by machine
    // so sessions can still be attributed to a machine.
    _sessionId = `${_machineId}-${Date.now()}`;

    const session: SessionData = {
        sessionId: _sessionId,
        machineId: _machineId,
        startedAt: new Date().toISOString(),
        events: {}
    };
    context.globalState.update(SESSION_KEY, session);

    trackEvent('extension_activated');

    // Start periodic flush
    _flushTimer = setInterval(() => flush(), FLUSH_INTERVAL_MS);

    // Flush on deactivation
    context.subscriptions.push({ dispose: () => flush() });

    vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('freebird.telemetry.enabled')) {
            _enabled = vscode.workspace.getConfiguration('freebird').get<boolean>('telemetry.enabled', true);
        }
    });
}

/**
 * @param detail Optional bounded classifier for this occurrence (e.g. an
 * error code, a tool action name) — never raw error messages, tool output,
 * file paths, or anything else that could carry code content or PII.
 */
export function trackEvent(name: string, detail?: string): void {
    if (!_enabled || !_context) return;

    // Local persistence (for getSessionStats)
    const session = _context.globalState.get<SessionData>(SESSION_KEY);
    if (session) {
        session.events[name] = (session.events[name] ?? 0) + 1;
        _context.globalState.update(SESSION_KEY, session);
    }

    // Queue for remote flush
    const key = detail || '';
    if (!_pendingEvents[name]) _pendingEvents[name] = {};
    _pendingEvents[name][key] = (_pendingEvents[name][key] ?? 0) + 1;
}

export function getSessionId(): string {
    return _sessionId;
}

/** Stable per-machine ID used for quota enforcement and unique-user analytics. */
export function getMachineId(): string {
    return _machineId;
}

export function getSessionStats(): Record<string, number> | null {
    if (!_context) return null;
    const session = _context.globalState.get<SessionData>(SESSION_KEY);
    return session?.events ?? null;
}

export async function disposeTelemetry(): Promise<void> {
    if (_flushTimer) {
        clearInterval(_flushTimer);
        _flushTimer = undefined;
    }
    return flush();
}

async function flush(): Promise<void> {
    if (!_enabled || !_context) return;

    const events = _pendingEvents;
    _pendingEvents = {};

    const entries: { name: string; detail: string; count: number }[] = [];
    for (const [name, byDetail] of Object.entries(events)) {
        for (const [detail, count] of Object.entries(byDetail)) {
            entries.push({ name, detail, count });
        }
    }
    if (entries.length === 0) return;

    const config = vscode.workspace.getConfiguration('freebird');
    const payload = {
        events: entries.map(({ name, detail, count }) => ({ name, detail: detail || undefined, count, ts: Date.now() })),
        meta: {
            sessionId: _sessionId,
            machineId: _machineId,
            version: vscode.extensions.getExtension('TenLabs.freebird-ai')?.packageJSON?.version ?? 'unknown',
            platform: process.platform,
            backend: config.get<string>('backend', 'cloud')
        }
    };

    try {
        await fetch(`${API_BASE}/api/telemetry`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(5000)
        });
    } catch {
        // Re-queue failed events for next flush
        for (const { name, detail, count } of entries) {
            if (!_pendingEvents[name]) _pendingEvents[name] = {};
            _pendingEvents[name][detail] = (_pendingEvents[name][detail] ?? 0) + count;
        }
    }
}
