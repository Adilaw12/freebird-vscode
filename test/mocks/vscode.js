// test/mocks/vscode.js
//
// A minimal mock of the `vscode` API surface used by the code under test.
// This is NOT a general-purpose VS Code mock — it only implements what
// src/ai/*.ts and src/license/*.ts actually call. If a new test needs more
// of the API, extend this file rather than adding ad-hoc mocks per test.
//
// Installed as the real 'vscode' module for test runs via test/bootstrap.js,
// which patches Node's module resolution — nothing here touches the real
// node_modules or the actual VS Code extension host.

let mockConfig = {};
const calls = { showWarningMessage: [], showInformationMessage: [] };

function getConfiguration(section) {
    return {
        get(key, def) {
            const full = section ? `${section}.${key}` : key;
            return Object.prototype.hasOwnProperty.call(mockConfig, full) ? mockConfig[full] : def;
        },
        update(key, value) {
            const full = section ? `${section}.${key}` : key;
            mockConfig[full] = value;
            return Promise.resolve();
        }
    };
}

module.exports = {
    // Test-only helpers, not part of the real vscode API:
    __setMockConfig(cfg) { mockConfig = cfg; },
    __getCalls() { return calls; },
    __resetCalls() { calls.showWarningMessage = []; calls.showInformationMessage = []; },

    workspace: { getConfiguration },
    window: {
        showWarningMessage(...args) { calls.showWarningMessage.push(args); return Promise.resolve(undefined); },
        showInformationMessage(...args) { calls.showInformationMessage.push(args); return Promise.resolve(undefined); },
        showInputBox() { return Promise.resolve(undefined); },
        withProgress(_opts, task) { return task({ report() {} }, { isCancellationRequested: false }); }
    },
    commands: { executeCommand() { return Promise.resolve(); } },
    env: {
        openExternal() { return Promise.resolve(true); },
        clipboard: { writeText() { return Promise.resolve(); } }
    },
    Uri: { parse(s) { return { toString: () => s }; } },
    ProgressLocation: { Notification: 1 },
    EventEmitter: class { event() {} fire() {} }
};
