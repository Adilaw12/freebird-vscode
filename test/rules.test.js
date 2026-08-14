// test/rules.test.js — project-level rules file (.freebird/rules.md).
// Mirrors memory.test.js conventions (bootstrap the vscode mock, use real
// temp dirs) — rules.js is memory.js's read-only sibling: no clear function,
// since it's the user's own file and Freebird never deletes it.

require('./bootstrap');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { suite, check, summary } = require('./helpers');

const OUT = path.join(__dirname, '..', 'out');
const { readProjectRules, RULES_RELATIVE_PATH } =
    require(path.join(OUT, 'agent/rules.js'));

const vscode = require('vscode');

function makeTempDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'freebird-rules-test-'));
}

function setWorkspaceRoot(root) {
    vscode.workspace.workspaceFolders = root
        ? [{ uri: { fsPath: root } }]
        : undefined;
}

function run() {
    suite('rules path constant');
    {
        check('rules file lives at .freebird/rules.md', RULES_RELATIVE_PATH === '.freebird/rules.md');
    }

    suite('no workspace open -> read returns empty');
    {
        setWorkspaceRoot(null);
        check('readProjectRules returns "" with no workspace', readProjectRules() === '');
    }

    suite('no rules file yet -> read returns empty string');
    {
        const workspaceRoot = makeTempDir();
        try {
            setWorkspaceRoot(workspaceRoot);
            check('readProjectRules returns "" before the file exists', readProjectRules() === '');
        } finally {
            fs.rmSync(workspaceRoot, { recursive: true, force: true });
        }
    }

    suite('round-trip: write a rules file, read it back');
    {
        const workspaceRoot = makeTempDir();
        try {
            setWorkspaceRoot(workspaceRoot);
            const rulesPath = path.join(workspaceRoot, RULES_RELATIVE_PATH);
            fs.mkdirSync(path.dirname(rulesPath), { recursive: true });
            fs.writeFileSync(rulesPath, 'Always use tabs for indentation.', 'utf8');

            check('readProjectRules returns the file contents', readProjectRules() === 'Always use tabs for indentation.');
        } finally {
            fs.rmSync(workspaceRoot, { recursive: true, force: true });
        }
    }

    suite('whitespace-only rules file reads as empty');
    {
        const workspaceRoot = makeTempDir();
        try {
            setWorkspaceRoot(workspaceRoot);
            const rulesPath = path.join(workspaceRoot, RULES_RELATIVE_PATH);
            fs.mkdirSync(path.dirname(rulesPath), { recursive: true });
            fs.writeFileSync(rulesPath, '   \n\t\n  ', 'utf8');

            check('whitespace-only file returns ""', readProjectRules() === '');
        } finally {
            fs.rmSync(workspaceRoot, { recursive: true, force: true });
        }
    }

    suite('rules longer than 6000 chars is truncated with a marker');
    {
        const workspaceRoot = makeTempDir();
        try {
            setWorkspaceRoot(workspaceRoot);
            const rulesPath = path.join(workspaceRoot, RULES_RELATIVE_PATH);
            fs.mkdirSync(path.dirname(rulesPath), { recursive: true });
            const longContent = 'x'.repeat(10_000);
            fs.writeFileSync(rulesPath, longContent, 'utf8');

            const result = readProjectRules();
            const marker = '\n… (truncated — keep rules.md focused)';
            check('result is capped at 6000 chars + the truncation marker', result.length === 6000 + marker.length);
            check('result ends with the truncation marker', result.endsWith(marker));
        } finally {
            fs.rmSync(workspaceRoot, { recursive: true, force: true });
        }
    }

    suite('read failure (permission/file-as-dir edge) degrades to empty string');
    {
        const workspaceRoot = makeTempDir();
        try {
            setWorkspaceRoot(workspaceRoot);
            // Point the rules path at a DIRECTORY — readFileSync throws EISDIR,
            // which must be swallowed and treated as "no rules".
            const rulesPath = path.join(workspaceRoot, RULES_RELATIVE_PATH);
            fs.mkdirSync(rulesPath, { recursive: true });

            check('reading a directory as the rules file returns ""', readProjectRules() === '');
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
