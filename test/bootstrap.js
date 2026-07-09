// test/bootstrap.js
//
// Makes require('vscode') resolve to test/mocks/vscode.js everywhere,
// WITHOUT touching the real node_modules or needing a fake package there.
// This lets tests require the actual compiled output (out/**) — the exact
// code that ships — rather than re-implementing its logic in the test.
//
// Usage: require this before requiring anything from out/.

const Module = require('module');
const path = require('path');

const vscodeMockPath = path.join(__dirname, 'mocks', 'vscode.js');
const originalResolve = Module._resolveFilename;

Module._resolveFilename = function (request, ...args) {
    if (request === 'vscode') return vscodeMockPath;
    return originalResolve.call(this, request, ...args);
};

module.exports = require(vscodeMockPath);
