// test/vector-math.test.js — pure logic, no vscode mock needed.

const path = require('path');
const { suite, check, summary } = require('./helpers');

const OUT = path.join(__dirname, '..', 'out');
const { cosineSimilarity, topKSimilar } = require(path.join(OUT, 'index/vectorMath.js'));

function run() {
    suite('cosineSimilarity');
    check('identical vectors have similarity 1', Math.abs(cosineSimilarity([1, 0, 0], [1, 0, 0]) - 1) < 1e-9);
    check('orthogonal vectors have similarity 0', Math.abs(cosineSimilarity([1, 0], [0, 1])) < 1e-9);
    check('opposite vectors have similarity -1', Math.abs(cosineSimilarity([1, 0], [-1, 0]) - (-1)) < 1e-9);
    check('a zero vector returns 0, not NaN or a crash', cosineSimilarity([0, 0], [1, 1]) === 0);
    check('mismatched-length vectors return 0 rather than throwing', cosineSimilarity([1, 2], [1, 2, 3]) === 0);

    suite('topKSimilar');
    const items = [
        { id: 'a', vector: [1, 0] },   // identical to query
        { id: 'b', vector: [0.9, 0.1] }, // close
        { id: 'c', vector: [0, 1] },   // orthogonal
        { id: 'd', vector: [-1, 0] }   // opposite
    ];
    const results = topKSimilar([1, 0], items, 2);
    check('returns exactly k results', results.length === 2);
    check('most similar item ranks first', results[0].id === 'a');
    check('second most similar item ranks second', results[1].id === 'b');
    check('results include a numeric score field', typeof results[0].score === 'number');
    check('results are sorted descending by score', results[0].score >= results[1].score);

    check('asking for more results than exist returns all of them, not an error', topKSimilar([1, 0], items, 100).length === items.length);
    check('asking for 0 results returns an empty array', topKSimilar([1, 0], items, 0).length === 0);
}

module.exports = { run };

if (require.main === module) {
    run();
    process.exit(summary() ? 0 : 1);
}
