// test/index-store.test.js — store.ts has no vscode dependency, so this
// tests it directly against a real temp directory on disk.

const path = require('path');
const fs = require('fs');
const os = require('os');
const { suite, check, summary } = require('./helpers');

const OUT = path.join(__dirname, '..', 'out');
const { loadIndex, saveIndex, emptyIndex, addFileChunks, removeFileChunks, search, INDEX_RELATIVE_PATH } =
    require(path.join(OUT, 'index/store.js'));

function makeTempDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'freebird-index-test-'));
}

function run() {
    suite('loadIndex / saveIndex round-trip');
    const root = makeTempDir();
    try {
        check('loadIndex on a fresh directory returns null', loadIndex(root) === null);

        let data = emptyIndex('test-provider');
        data = addFileChunks(data, 'src/foo.ts', 'hash1', [
            { id: 'src/foo.ts#0-10', filePath: 'src/foo.ts', startLine: 0, endLine: 10, text: 'hello', vector: [1, 0] }
        ]);
        saveIndex(root, data);

        check('index file is actually written to .freebird/codeindex.json', fs.existsSync(path.join(root, INDEX_RELATIVE_PATH)));

        const reloaded = loadIndex(root);
        check('reloaded index is not null', reloaded !== null);
        check('reloaded index has the right provider id', reloaded.providerId === 'test-provider');
        check('reloaded index has the chunk we saved', reloaded.chunks.length === 1 && reloaded.chunks[0].filePath === 'src/foo.ts');
        check('reloaded index has the file hash we saved', reloaded.fileHashes['src/foo.ts'] === 'hash1');
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }

    suite('addFileChunks replaces old chunks for the same file (no duplicates on re-index)');
    {
        let data = emptyIndex('p');
        data = addFileChunks(data, 'a.ts', 'hash1', [
            { id: 'a.ts#0-5', filePath: 'a.ts', startLine: 0, endLine: 5, text: 'v1', vector: [1, 0] }
        ]);
        data = addFileChunks(data, 'a.ts', 'hash2', [
            { id: 'a.ts#0-5', filePath: 'a.ts', startLine: 0, endLine: 5, text: 'v2', vector: [0, 1] }
        ]);
        check('re-indexing the same file leaves only the new chunks, not both old and new', data.chunks.length === 1);
        check('the surviving chunk is the new version', data.chunks[0].text === 'v2');
        check('the file hash reflects the latest content', data.fileHashes['a.ts'] === 'hash2');
    }

    suite('removeFileChunks removes exactly one file, leaves others untouched');
    {
        let data = emptyIndex('p');
        data = addFileChunks(data, 'a.ts', 'h1', [{ id: 'a.ts#0-1', filePath: 'a.ts', startLine: 0, endLine: 1, text: 'a', vector: [1, 0] }]);
        data = addFileChunks(data, 'b.ts', 'h2', [{ id: 'b.ts#0-1', filePath: 'b.ts', startLine: 0, endLine: 1, text: 'b', vector: [0, 1] }]);
        data = removeFileChunks(data, 'a.ts');
        check('removed file\'s chunks are gone', !data.chunks.some(c => c.filePath === 'a.ts'));
        check('removed file\'s hash entry is gone', !('a.ts' in data.fileHashes));
        check('other file\'s chunks are untouched', data.chunks.some(c => c.filePath === 'b.ts'));
    }

    suite('search returns the most relevant chunk across files');
    {
        let data = emptyIndex('p');
        data = addFileChunks(data, 'auth.ts', 'h1', [{ id: 'auth.ts#0-5', filePath: 'auth.ts', startLine: 0, endLine: 5, text: 'auth code', vector: [1, 0] }]);
        data = addFileChunks(data, 'unrelated.ts', 'h2', [{ id: 'unrelated.ts#0-5', filePath: 'unrelated.ts', startLine: 0, endLine: 5, text: 'unrelated code', vector: [0, 1] }]);
        const results = search(data, [1, 0], 1);
        check('top search result is the relevant file', results.length === 1 && results[0].filePath === 'auth.ts');
    }
}

module.exports = { run };

if (require.main === module) {
    run();
    process.exit(summary() ? 0 : 1);
}
