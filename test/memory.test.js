// test/memory.test.js — project-level memory file (.freebird/memory.md).
// The memory file is the agent's long-term store across sessions, so its
// read/truncate/clear behavior is tested against a real temp directory,
// not just trusted. Mirrors checkpoint.test.js conventions: bootstrap the
// vscode mock, load compiled out/agent/memory.js, use real temp dirs.

require('./bootstrap');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { suite, check, summary } = require('./helpers');

const OUT = path.join(__dirname, '..', 'out');
const { readProjectMemory, clearProjectMemory, MEMORY_RELATIVE_PATH } =
    require(path.join(OUT, 'agent/memory.js'));

const vscode = require('vscode');

function makeTempDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'freebird-memory-test-'));
}

// memory.js reads vscode.workspace.workspaceFolders?.[0]?.uri.fsPath — the
// shared mock doesn't define workspaceFolders, so set it directly per test.
function setWorkspaceRoot(root) {
    vscode.workspace.workspaceFolders = root
        ? [{ uri: { fsPath: root } }]
        : undefined;
}

function run() {
    suite('memory path constant');
    {
        check('memory file lives at .freebird/memory.md', MEMORY_RELATIVE_PATH === '.freebird/memory.md');
    }

    suite('no workspace open -> read returns empty, clear is a no-op');
    {
        setWorkspaceRoot(null);
        check('readProjectMemory returns "" with no workspace', readProjectMemory() === '');
        check('clearProjectMemory returns false with no workspace', clearProjectMemory() === false);
    }

    suite('no memory file yet -> read returns empty string');
    {
        const workspaceRoot = makeTempDir();
        try {
            setWorkspaceRoot(workspaceRoot);
            check('readProjectMemory returns "" before the file exists', readProjectMemory() === '');
        } finally {
            fs.rmSync(workspaceRoot, { recursive: true, force: true });
        }
    }

    suite('round-trip: write a memory file, read it back');
    {
        const workspaceRoot = makeTempDir();
        try {
            setWorkspaceRoot(workspaceRoot);
            const memoryPath = path.join(workspaceRoot, MEMORY_RELATIVE_PATH);
            fs.mkdirSync(path.dirname(memoryPath), { recursive: true });
            fs.writeFileSync(memoryPath, 'Remember: use tabs for indentation.', 'utf8');

            check('readProjectMemory returns the file contents', readProjectMemory() === 'Remember: use tabs for indentation.');
            check('clearProjectMemory returns true for an existing file', clearProjectMemory() === true);
            check('the file is actually removed from disk', !fs.existsSync(memoryPath));
            check('readProjectMemory returns "" after clearing', readProjectMemory() === '');
        } finally {
            fs.rmSync(workspaceRoot, { recursive: true, force: true });
        }
    }

    suite('whitespace-only memory file reads as empty');
    {
        const workspaceRoot = makeTempDir();
        try {
            setWorkspaceRoot(workspaceRoot);
            const memoryPath = path.join(workspaceRoot, MEMORY_RELATIVE_PATH);
            fs.mkdirSync(path.dirname(memoryPath), { recursive: true });
            fs.writeFileSync(memoryPath, '   \n\t\n  ', 'utf8');

            check('whitespace-only file returns ""', readProjectMemory() === '');
        } finally {
            fs.rmSync(workspaceRoot, { recursive: true, force: true });
        }
    }

    suite('memory longer than 4000 chars is truncated with a marker');
    {
        const workspaceRoot = makeTempDir();
        try {
            setWorkspaceRoot(workspaceRoot);
            const memoryPath = path.join(workspaceRoot, MEMORY_RELATIVE_PATH);
            fs.mkdirSync(path.dirname(memoryPath), { recursive: true });
            const longContent = 'x'.repeat(10_000);
            fs.writeFileSync(memoryPath, longContent, 'utf8');

            const result = readProjectMemory();
            const marker = '\n… (truncated)';
            check('result is capped at 4000 chars + the truncation marker', result.length === 4000 + marker.length);
            check('result ends with the truncation marker', result.endsWith('… (truncated)'));
        } finally {
            fs.rmSync(workspaceRoot, { recursive: true, force: true });
        }
    }

    suite('clearProjectMemory on a missing file returns false');
    {
        const workspaceRoot = makeTempDir();
        try {
            setWorkspaceRoot(workspaceRoot);
            check('clearing a file that does not exist returns false', clearProjectMemory() === false);
        } finally {
            fs.rmSync(workspaceRoot, { recursive: true, force: true });
        }
    }

    suite('read failure (permission/file-as-dir edge) degrades to empty string');
    {
        const workspaceRoot = makeTempDir();
        try {
            setWorkspaceRoot(workspaceRoot);
            // Point the memory path at a DIRECTORY — readFileSync throws EISDIR,
            // which must be swallowed and treated as "no memory".
            const memoryPath = path.join(workspaceRoot, MEMORY_RELATIVE_PATH);
            fs.mkdirSync(memoryPath, { recursive: true });

            check('reading a directory as the memory file returns ""', readProjectMemory() === '');
        } finally {
            fs.rmSync(workspaceRoot, { recursive: true, force: true });
        }
    }
}

module.exports = { run };

if (require.main === module) {
    run();
    process.exit(summary() ? 0 : 1);
}
