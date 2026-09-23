import * as vscode from 'vscode';
import * as crypto from 'crypto';

const API_BASE = 'https://freebird-backend.vercel.app';
const FLUSH_INTERVAL_MS = 60_000; // flush every 60 seconds
const SESSION_KEY = 'freebird.telemetrySession';

// VS Code returns this exact literal string from vscode.env.machineId when
// telemetry is disabled/restricted at the OS or VS Code level — a known,
// documented upstream quirk (see microsoft/vscode-extension-telemetry
// issues: one report showed 10,000+ events from ~20 different countries all
// sharing this identical "machine" id). Since machineId is Freebird's only
// per-device key for trial-claim gating AND free-tier quota (see
// initTelemetry below, and getMachineId's callers), using it verbatim would
// silently collapse every such user — worldwide, indefinitely — into one
// shared trial-claim slot and one shared daily quota pool. Detected and
// confirmed live in production data: a single Redis identity
// ("m-someValuemachineId") had been accumulating activity since the day
// machineId-based quota shipped.
const VSCODE_MACHINE_ID_PLACEHOLDER = 'someValue.machineId';
const FALLBACK_MACHINE_ID_KEY = 'freebird.fallbackMachineId';

// Returns a per-device id: VS Code's real machineId normally, or — for users
// hitting the placeholder above — a UUID generated once and persisted in
// this extension's own globalState, so each real affected user gets their
// own stable identity instead of colliding with every other such user.
function resolveMachineId(context: vscode.ExtensionContext): string {
    const raw = vscode.env.machineId;
    if (raw !== VSCODE_MACHINE_ID_PLACEHOLDER) return raw;

    let fallback = context.globalState.get<string>(FALLBACK_MACHINE_ID_KEY);
    if (!fallback) {
        fallback = crypto.randomUUID();
        context.globalState.update(FALLBACK_MACHINE_ID_KEY, fallback);
    }
    return fallback;
}

// These fire right at the moments a frustrated user is most likely to close
// VS Code immediately after — batching them into the normal 60s flush risks
// losing the only diagnostic detail we'll ever get for that failure. Flush
// right away instead of waiting for the timer.
const IMMEDIATE_FLUSH_EVENTS = new Set([
    'trial_start_failed',
    'trial_already_used'
]);

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
    _machineId = `m-${resolveMachineId(context).replace(/[^a-zA-Z0-9]/g, '').slice(0, 40)}`;

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

    if (IMMEDIATE_FLUSH_EVENTS.has(name)) {
        void flush();
    }
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
