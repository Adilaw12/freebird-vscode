// test/checkpoint.test.js — the checkpoint/restore feature is a data-loss-risk
// surface (restoring the wrong content, or restoring over the wrong file), so
// it's tested against a real temp directory rather than just trusting the logic.

require('./bootstrap');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { suite, check } = require('./helpers');

const OUT = path.join(__dirname, '..', 'out');
const { recordPreState, markTurnUnrevertable, finalizeTurn, restoreCheckpoint, checkpointsRootFor } =
    require(path.join(OUT, 'agent/checkpoint.js'));

function makeTempDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'freebird-checkpoint-test-'));
}

function b64(text) {
    return Buffer.from(text, 'utf8').toString('base64');
}

function run() {
    suite('finalizeTurn returns null when nothing was touched');
    {
        const summary = finalizeTurn(makeTempDir(), 'turn-empty');
        check('no files touched -> finalizeTurn returns null', summary === null);
    }

    suite('a newly created file: restore deletes it');
    {
        const checkpointsRoot = makeTempDir();
        const workspaceRoot = makeTempDir();
        try {
            const turnId = 'turn-new-file';
            const relPath = 'new.txt';
            const full = path.join(workspaceRoot, relPath);

            recordPreState(turnId, relPath, { existed: false });
            fs.writeFileSync(full, 'created by the agent', 'utf8');

            const summary = finalizeTurn(checkpointsRoot, turnId);
            check('finalizeTurn returns a summary listing the new file', summary && summary.files.length === 1 && summary.files[0] === relPath);
            check('summary is not flagged unrevertable', summary.unrevertable === false);

            const result = restoreCheckpoint(workspaceRoot, checkpointsRoot, turnId);
            check('restore reports the file as deleted, not restored', result.deleted.length === 1 && result.restored.length === 0);
            check('the file no longer exists on disk', !fs.existsSync(full));
        } finally {
            fs.rmSync(checkpointsRoot, { recursive: true, force: true });
            fs.rmSync(workspaceRoot, { recursive: true, force: true });
        }
    }

    suite('an edited existing file: restore brings back the original content');
    {
        const checkpointsRoot = makeTempDir();
        const workspaceRoot = makeTempDir();
        try {
            const turnId = 'turn-edit-file';
            const relPath = 'existing.txt';
            const full = path.join(workspaceRoot, relPath);
            fs.writeFileSync(full, 'original content', 'utf8');

            recordPreState(turnId, relPath, { existed: true, content: b64('original content') });
            fs.writeFileSync(full, 'edited content', 'utf8');

            finalizeTurn(checkpointsRoot, turnId);
            const result = restoreCheckpoint(workspaceRoot, checkpointsRoot, turnId);
            check('restore reports the file as restored', result.restored.length === 1 && result.restored[0] === relPath);
            check('the file content is back to the original', fs.readFileSync(full, 'utf8') === 'original content');
        } finally {
            fs.rmSync(checkpointsRoot, { recursive: true, force: true });
            fs.rmSync(workspaceRoot, { recursive: true, force: true });
        }
    }

    suite('a path touched twice in one turn only records the first pre-state');
    {
        const checkpointsRoot = makeTempDir();
        const workspaceRoot = makeTempDir();
        try {
            const turnId = 'turn-double-edit';
            const relPath = 'doubled.txt';
            const full = path.join(workspaceRoot, relPath);
            fs.writeFileSync(full, 'v0', 'utf8');

            recordPreState(turnId, relPath, { existed: true, content: b64('v0') });
            fs.writeFileSync(full, 'v1', 'utf8');
            // Second edit in the same turn — must NOT overwrite the recorded pre-state with 'v1'.
            recordPreState(turnId, relPath, { existed: true, content: b64('v1') });
            fs.writeFileSync(full, 'v2', 'utf8');

            finalizeTurn(checkpointsRoot, turnId);
            const result = restoreCheckpoint(workspaceRoot, checkpointsRoot, turnId);
            check('restoring after two edits in one turn goes back to the original (v0), not the intermediate (v1)',
                fs.readFileSync(full, 'utf8') === 'v0');
            check('only one restore entry for the doubly-touched path', result.restored.length === 1);
        } finally {
            fs.rmSync(checkpointsRoot, { recursive: true, force: true });
            fs.rmSync(workspaceRoot, { recursive: true, force: true });
        }
    }

    suite('restoreCheckpoint refuses to write outside the workspace root');
    {
        const checkpointsRoot = makeTempDir();
        const workspaceRoot = makeTempDir();
        const outsideDir = makeTempDir();
        try {
            const turnId = 'turn-path-escape';
            // A checkpoint entry with a traversal path shouldn't be reachable via the
            // normal recordPreState call sites (they all go through resolveWorkspacePath
            // first), but restoreCheckpoint must not trust that on its own — write one
            // directly to simulate a checkpoint file that somehow got a bad path in it.
            const escapePath = path.relative(workspaceRoot, path.join(outsideDir, 'evil.txt'));
            fs.mkdirSync(checkpointsRoot, { recursive: true });
            fs.writeFileSync(path.join(checkpointsRoot, `${turnId}.json`), JSON.stringify({
                turnId, createdAt: Date.now(), unrevertable: false,
                files: [{ path: escapePath, existed: false }]
            }), 'utf8');

            const result = restoreCheckpoint(workspaceRoot, checkpointsRoot, turnId);
            check('the escaping entry is reported as an error, not restored or deleted',
                result.errors.length === 1 && result.restored.length === 0 && result.deleted.length === 0);
            check('nothing was written outside the workspace', !fs.existsSync(path.join(outsideDir, 'evil.txt')));
        } finally {
            fs.rmSync(checkpointsRoot, { recursive: true, force: true });
            fs.rmSync(workspaceRoot, { recursive: true, force: true });
            fs.rmSync(outsideDir, { recursive: true, force: true });
        }
    }

    suite('a turn that also ran a shell command is flagged unrevertable');
    {
        const checkpointsRoot = makeTempDir();
        try {
            const turnId = 'turn-with-command';
            recordPreState(turnId, 'a.txt', { existed: false });
            markTurnUnrevertable(turnId);

            const summary = finalizeTurn(checkpointsRoot, turnId);
            check('summary is flagged unrevertable', summary.unrevertable === true);
        } finally {
            fs.rmSync(checkpointsRoot, { recursive: true, force: true });
        }
    }

    suite('pruning caps stored checkpoints at 20');
    {
        const checkpointsRoot = makeTempDir();
        try {
            for (let i = 0; i < 25; i++) {
                const turnId = `turn-prune-${i}`;
                recordPreState(turnId, `f${i}.txt`, { existed: false });
                finalizeTurn(checkpointsRoot, turnId);
            }
            const remaining = fs.readdirSync(checkpointsRoot).filter(f => f.endsWith('.json'));
            check('at most 20 checkpoint files remain after 25 turns', remaining.length <= 20);
        } finally {
            fs.rmSync(checkpointsRoot, { recursive: true, force: true });
        }
    }

    suite('checkpointsRootFor');
    {
        const withStorage = { storageUri: { fsPath: path.join(os.tmpdir(), 'freebird-fake-storage') } };
        check('returns a path under storageUri when present', checkpointsRootFor(withStorage) === path.join(withStorage.storageUri.fsPath, 'checkpoints'));

        const withoutStorage = { storageUri: undefined };
        check('returns null when storageUri is undefined', checkpointsRootFor(withoutStorage) === null);
    }
}

module.exports = { run };
