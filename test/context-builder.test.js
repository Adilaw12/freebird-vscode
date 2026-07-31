// test/context-builder.test.js — tests out/chat/contextBuilder.js: the
// active-file context block that heads every chat request (buildFileContext)
// and @mention resolution that pulls whole files into context (resolveMentions).
// These shape what the model actually sees, so a bug here wastes tokens or
// leaks the wrong file into the prompt.
//
// The vscode mock (test/mocks/vscode.js) supplies the surface this module
// needs: window.activeTextEditor, workspace.workspaceFolders,
// workspace.asRelativePath, workspace.findFiles, and the Range class.

require('./bootstrap');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { suite, check, summary } = require('./helpers');

const OUT = path.join(__dirname, '..', 'out');
const { buildFileContext, resolveMentions, listWorkspaceFiles } =
    require(path.join(OUT, 'chat/contextBuilder.js'));

const vscode = require('vscode');

function makeTempDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'freebird-context-test-'));
}

function setWorkspaceRoot(root) {
    vscode.workspace.workspaceFolders = root ? [{ uri: { fsPath: root } }] : undefined;
}

const emptySelection = {
    isEmpty: true,
    start: { line: 0, character: 0 },
    end: { line: 0, character: 0 },
    active: { line: 0, character: 0 }
};

// Minimal fake TextEditor for window.activeTextEditor. getText() honours both
// the no-arg (whole doc) and selection/range-arg forms that buildFileContext
// calls.
function makeEditor({ fileName, languageId, text, selection }) {
    const lines = text.split('\n');
    const document = {
        fileName,
        languageId,
        lineCount: lines.length,
        lineAt(i) { return { text: lines[i] ?? '' }; },
        getText(range) {
            if (!range) return text;
            if (range.start.line === range.end.line) {
                return (lines[range.start.line] ?? '').slice(range.start.character, range.end.character);
            }
            const parts = [];
            for (let i = range.start.line; i <= range.end.line; i++) {
                const line = lines[i] ?? '';
                if (i === range.start.line) parts.push(line.slice(range.start.character));
                else if (i === range.end.line) parts.push(line.slice(0, range.end.character));
                else parts.push(line);
            }
            return parts.join('\n');
        }
    };
    return { document, selection };
}

async function run() {
    suite('buildFileContext with no active editor returns empty string');
    {
        vscode.window.activeTextEditor = undefined;
        check('no editor -> ""', buildFileContext() === '');
    }

    suite('buildFileContext with a selection emits a selected-code block');
    {
        setWorkspaceRoot('/workspace');
        vscode.window.activeTextEditor = makeEditor({
            fileName: '/workspace/src/app.ts',
            languageId: 'typescript',
            text: 'line one\nline two\nline three',
            selection: { isEmpty: false, start: { line: 1, character: 0 }, end: { line: 2, character: 10 }, active: { line: 2, character: 10 } }
        });
        const ctx = buildFileContext();
        check('header names the file and language', ctx.includes('**Active file:** `src/app.ts` (typescript)'));
        check('selected code is wrapped in a code fence', ctx.includes('**Selected code** (lines 2–3):') && ctx.includes('```typescript\nline two\nline three\n```'));
    }

    suite('buildFileContext with a small file includes the whole file');
    {
        setWorkspaceRoot('/workspace');
        vscode.window.activeTextEditor = makeEditor({
            fileName: '/workspace/small.js',
            languageId: 'javascript',
            text: 'const a = 1;\nmodule.exports = a;',
            selection: emptySelection
        });
        const ctx = buildFileContext();
        check('header names the file', ctx.includes('**Active file:** `small.js` (javascript)'));
        check('full file is embedded in a code fence', ctx.includes('```javascript\nconst a = 1;\nmodule.exports = a;\n```'));
    }

    suite('buildFileContext with a large file emits an excerpt around the cursor');
    {
        setWorkspaceRoot('/workspace');
        const lines = [];
        // Pad each line so the file exceeds MAX_FILE_CHARS (8,000) — otherwise
        // buildFileContext would take the full-file branch, not the excerpt one.
        for (let i = 0; i < 500; i++) lines.push(`line ${i} ` + 'x'.repeat(40));
        const text = lines.join('\n');
        vscode.window.activeTextEditor = makeEditor({
            fileName: '/workspace/big.py',
            languageId: 'python',
            text,
            selection: { isEmpty: true, start: { line: 0, character: 0 }, end: { line: 0, character: 0 }, active: { line: 300, character: 0 } }
        });
        const ctx = buildFileContext();
        check('context mentions an excerpt with the visible range', /Excerpt.*\(lines \d+–\d+ of 500\)/.test(ctx));
        check('excerpt starts before and ends after the cursor line', ctx.includes('line 240') && ctx.includes('line 360'));
        check('no full-file fence for oversized files', !ctx.includes('```python\nline 0'));
    }

    suite('resolveMentions with no mentions passes text through unchanged');
    {
        const result = await resolveMentions('hello world, no mentions here');
        check('cleanText is unchanged', result.cleanText === 'hello world, no mentions here');
        check('no mention context produced', result.mentionContext === '');
        check('resolvedCount is 0', result.resolvedCount === 0);
    }

    suite('resolveMentions with a workspace file pulls it into context');
    {
        const root = makeTempDir();
        try {
            setWorkspaceRoot(root);
            fs.writeFileSync(path.join(root, 'notes.md'), '# Notes\nSome important details.\n', 'utf8');

            const result = await resolveMentions('read @notes.md and summarize');
            check('mention is removed from the clean text', result.cleanText === 'read and summarize');
            check('mention context contains the file content', result.mentionContext.includes('Some important details.'));
            check('resolvedCount is 1', result.resolvedCount === 1);
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
            setWorkspaceRoot(null);
        }
    }

    suite('resolveMentions leaves a missing file as a plain-text mention');
    {
        const root = makeTempDir();
        try {
            setWorkspaceRoot(root);
            const result = await resolveMentions('see @does-not-exist.md please');
            check('text is unchanged when the file is missing', result.cleanText === 'see @does-not-exist.md please');
            check('no context produced', result.mentionContext === '');
            check('resolvedCount is 0', result.resolvedCount === 0);
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
            setWorkspaceRoot(null);
        }
    }

    suite('resolveMentions with no workspace root leaves text alone');
    {
        setWorkspaceRoot(null);
        const result = await resolveMentions('read @notes.md now');
        check('text unchanged with no workspace', result.cleanText === 'read @notes.md now');
        check('no context produced', result.mentionContext === '');
        check('resolvedCount is 0', result.resolvedCount === 0);
    }

    suite('listWorkspaceFiles maps found URIs to relative paths');
    {
        setWorkspaceRoot('/workspace');
        const originalFindFiles = vscode.workspace.findFiles;
        try {
            vscode.workspace.findFiles = async () => [
                { fsPath: '/workspace/src/a.ts' },
                { fsPath: '/workspace/b.md' }
            ];
            const files = await listWorkspaceFiles();
            check('returns relative paths', files.length === 2 && files[0] === 'src/a.ts' && files[1] === 'b.md');
        } finally {
            vscode.workspace.findFiles = originalFindFiles;
        }
    }

    // Clean up shared mock state so other suites in the same process are unaffected.
    vscode.window.activeTextEditor = undefined;
    setWorkspaceRoot(null);
}

module.exports = { run };

if (require.main === module) {
    run().then(() => process.exit(summary() ? 0 : 1));
}
