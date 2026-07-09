// test/chunker.test.js — pure logic, no vscode mock needed.

const path = require('path');
const { suite, check, summary } = require('./helpers');

const OUT = path.join(__dirname, '..', 'out');
const { chunkFile, INDEXABLE_EXTENSIONS } = require(path.join(OUT, 'index/chunker.js'));

function run() {
    suite('chunkFile splits content into overlapping line windows');

    const lines40 = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n');
    const chunks40 = chunkFile(lines40, { chunkLines: 40, overlapLines: 8 });
    check('a file exactly one chunk long produces exactly one chunk', chunks40.length === 1);
    check('single chunk covers the whole file (line 0 to 39)', chunks40[0].startLine === 0 && chunks40[0].endLine === 39);

    const lines100 = Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n');
    const chunks100 = chunkFile(lines100, { chunkLines: 40, overlapLines: 8 });
    check('a 100-line file produces multiple chunks', chunks100.length > 1);
    check('consecutive chunks overlap', chunks100[1].startLine < chunks100[0].endLine);
    check('the last chunk reaches the end of the file', chunks100[chunks100.length - 1].endLine === 99);

    suite('chunkFile edge cases');
    check('empty content produces zero chunks', chunkFile('').length === 0);
    check('whitespace-only content produces zero chunks', chunkFile('   \n  \n\t\n').length === 0);

    const single = chunkFile('const x = 1;');
    check('a tiny single-line file produces exactly one chunk', single.length === 1);
    check('that chunk contains the actual content', single[0].text.includes('const x = 1;'));

    suite('INDEXABLE_EXTENSIONS sanity checks');
    check('.ts is indexable', INDEXABLE_EXTENSIONS.has('.ts'));
    check('.py is indexable', INDEXABLE_EXTENSIONS.has('.py'));
    check('.png is NOT indexable (binary/no text signal)', !INDEXABLE_EXTENSIONS.has('.png'));
    check('.lock is NOT indexable (noise, not signal)', !INDEXABLE_EXTENSIONS.has('.lock'));
}

module.exports = { run };

if (require.main === module) {
    run();
    process.exit(summary() ? 0 : 1);
}
