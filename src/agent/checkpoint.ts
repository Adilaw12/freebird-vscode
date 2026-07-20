// src/agent/checkpoint.ts — per-turn file checkpoints so an agent turn can be
// undone. Only covers direct file-content mutations (write_file, edit_file,
// copy_file, download_file); run_command/git_push are flagged unrevertable
// instead of pretending to snapshot arbitrary side effects.
//
// Core data functions take a plain `checkpointsRoot`/`root` string rather than
// touching vscode APIs directly, so they're testable without a vscode mock
// (mirrors src/index/store.ts). Only `checkpointsRootFor` below touches vscode.

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

const MAX_CHECKPOINTS = 20;

export interface CheckpointFileEntry {
    path: string;
    existed: boolean;
    /** Base64-encoded original file bytes (binary-safe — files touched by copy_file/download_file aren't always text). */
    content?: string;
}

export interface CheckpointData {
    turnId: string;
    createdAt: number;
    files: CheckpointFileEntry[];
    unrevertable: boolean;
}

export interface CheckpointSummary {
    turnId: string;
    files: string[];
    unrevertable: boolean;
}

export interface RestoreResult {
    restored: string[];
    deleted: string[];
    errors: string[];
}

interface PendingTurn {
    files: CheckpointFileEntry[];
    touchedPaths: Set<string>;
    unrevertable: boolean;
}

const pendingTurns = new Map<string, PendingTurn>();

function getOrCreatePending(turnId: string): PendingTurn {
    let pending = pendingTurns.get(turnId);
    if (!pending) {
        pending = { files: [], touchedPaths: new Set(), unrevertable: false };
        pendingTurns.set(turnId, pending);
    }
    return pending;
}

/** Records the pre-mutation state of a file the first time it's touched in a turn. Later touches in the same turn are no-ops, so restore undoes the whole turn, not just the last edit. */
export function recordPreState(turnId: string, relPath: string, prior: { existed: boolean; content?: string }): void {
    const pending = getOrCreatePending(turnId);
    if (pending.touchedPaths.has(relPath)) return;
    pending.touchedPaths.add(relPath);
    pending.files.push({ path: relPath, existed: prior.existed, content: prior.content });
}

/** Marks a turn as having run a non-file-content action (shell command, git push) that checkpoints can't undo. */
export function markTurnUnrevertable(turnId: string): void {
    getOrCreatePending(turnId).unrevertable = true;
}

/** Flushes the accumulated pre-state for a turn to disk and prunes old checkpoints. Returns null if nothing was touched (no card to show). */
export function finalizeTurn(checkpointsRoot: string | null, turnId: string): CheckpointSummary | null {
    const pending = pendingTurns.get(turnId);
    pendingTurns.delete(turnId);
    if (!pending || pending.files.length === 0) return null;

    const summary: CheckpointSummary = {
        turnId,
        files: pending.files.map(f => f.path),
        unrevertable: pending.unrevertable
    };

    if (!checkpointsRoot) return summary;

    try {
        fs.mkdirSync(checkpointsRoot, { recursive: true });
        const data: CheckpointData = {
            turnId,
            createdAt: Date.now(),
            files: pending.files,
            unrevertable: pending.unrevertable
        };
        fs.writeFileSync(path.join(checkpointsRoot, `${turnId}.json`), JSON.stringify(data), 'utf8');
        pruneOldCheckpoints(checkpointsRoot);
    } catch {
        // Checkpointing is best-effort — never block the turn that already happened.
    }

    return summary;
}

/** Restores every file recorded for a turn to its pre-turn state. Best-effort per file — one failure doesn't stop the rest. */
export function restoreCheckpoint(root: string, checkpointsRoot: string, turnId: string): RestoreResult {
    const result: RestoreResult = { restored: [], deleted: [], errors: [] };

    let data: CheckpointData;
    try {
        const raw = fs.readFileSync(path.join(checkpointsRoot, `${turnId}.json`), 'utf8');
        data = JSON.parse(raw) as CheckpointData;
    } catch {
        result.errors.push('Checkpoint not found or unreadable.');
        return result;
    }

    const resolvedRoot = path.resolve(root);

    for (const entry of data.files) {
        const full = path.resolve(resolvedRoot, entry.path);
        if (full !== resolvedRoot && !full.startsWith(resolvedRoot + path.sep)) {
            result.errors.push(`${entry.path}: refusing to restore outside the workspace`);
            continue;
        }
        try {
            if (entry.existed) {
                fs.mkdirSync(path.dirname(full), { recursive: true });
                fs.writeFileSync(full, Buffer.from(entry.content ?? '', 'base64'));
                result.restored.push(entry.path);
            } else {
                if (fs.existsSync(full)) fs.unlinkSync(full);
                result.deleted.push(entry.path);
            }
        } catch (err: any) {
            result.errors.push(`${entry.path}: ${err?.message ?? String(err)}`);
        }
    }

    return result;
}

function pruneOldCheckpoints(checkpointsRoot: string, keep: number = MAX_CHECKPOINTS): void {
    try {
        const files = fs.readdirSync(checkpointsRoot)
            .filter(f => f.endsWith('.json'))
            .map(f => ({ name: f, mtime: fs.statSync(path.join(checkpointsRoot, f)).mtimeMs }))
            .sort((a, b) => b.mtime - a.mtime);

        for (const stale of files.slice(keep)) {
            try { fs.unlinkSync(path.join(checkpointsRoot, stale.name)); } catch { /* best-effort */ }
        }
    } catch {
        // best-effort
    }
}

export function checkpointsRootFor(context: vscode.ExtensionContext): string | null {
    if (!context.storageUri) return null;
    return path.join(context.storageUri.fsPath, 'checkpoints');
}
