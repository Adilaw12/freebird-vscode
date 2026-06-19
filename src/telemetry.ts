import * as vscode from 'vscode';

const API_BASE = 'https://freebird-backend.vercel.app';
const FLUSH_INTERVAL_MS = 60_000; // flush every 60 seconds
const SESSION_KEY = 'freebird.telemetrySession';

let _enabled = false;
let _context: vscode.ExtensionContext | undefined;
let _sessionId = '';
let _pendingEvents: Record<string, number> = {};
let _flushTimer: ReturnType<typeof setInterval> | undefined;

interface SessionData {
    sessionId: string;
    startedAt: string;
    events: Record<string, number>;
}

export function initTelemetry(context: vscode.ExtensionContext): void {
    _context = context;
    _enabled = vscode.workspace.getConfiguration('freebird').get<boolean>('telemetry.enabled', true);

    _sessionId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const session: SessionData = {
        sessionId: _sessionId,
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

export function trackEvent(name: string): void {
    if (!_enabled || !_context) return;

    // Local persistence (for getSessionStats)
    const session = _context.globalState.get<SessionData>(SESSION_KEY);
    if (session) {
        session.events[name] = (session.events[name] ?? 0) + 1;
        _context.globalState.update(SESSION_KEY, session);
    }

    // Queue for remote flush
    _pendingEvents[name] = (_pendingEvents[name] ?? 0) + 1;
}

export function getSessionStats(): Record<string, number> | null {
    if (!_context) return null;
    const session = _context.globalState.get<SessionData>(SESSION_KEY);
    return session?.events ?? null;
}

export function disposeTelemetry(): void {
    if (_flushTimer) {
        clearInterval(_flushTimer);
        _flushTimer = undefined;
    }
    flush();
}

async function flush(): Promise<void> {
    if (!_enabled || !_context) return;

    const events = _pendingEvents;
    _pendingEvents = {};

    const entries = Object.entries(events);
    if (entries.length === 0) return;

    const config = vscode.workspace.getConfiguration('freebird');
    const payload = {
        events: entries.map(([name, count]) => ({ name, count, ts: Date.now() })),
        meta: {
            sessionId: _sessionId,
            version: vscode.extensions.getExtension('TenLabs.freebird-ai')?.packageJSON?.version ?? 'unknown',
            platform: process.platform,
            backend: config.get<string>('backend', 'ollama')
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
        for (const [name, count] of entries) {
            _pendingEvents[name] = (_pendingEvents[name] ?? 0) + count;
        }
    }
}
