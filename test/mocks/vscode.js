// test/mocks/vscode.js
//
// A minimal mock of the `vscode` API surface used by the code under test.
// This is NOT a general-purpose VS Code mock — it only implements what
// src/ai/*.ts, src/license/*.ts, src/chat/*.ts, and src/agent/*.ts actually
// call. If a new test needs more of the API, extend this file rather than
// adding ad-hoc mocks per test.
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

    workspace: {
        getConfiguration,
        workspaceFolders: undefined,
        asRelativePath(p) {
            const root = this.workspaceFolders && this.workspaceFolders[0]
                ? this.workspaceFolders[0].uri.fsPath
                : undefined;
            // Accept either a plain string path or a Uri-like { fsPath } object
            // (the real VS Code API passes a Uri; listWorkspaceFiles does too).
            const value = typeof p === 'string' ? p : (p && p.fsPath);
            if (root && typeof value === 'string' && value.startsWith(root)) {
                const rel = value.slice(root.length).replace(/^[\\/]+/, '');
                return rel || value;
            }
            return p;
        },
        findFiles() { return Promise.resolve([]); }
    },
    window: {
        activeTextEditor: undefined,
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
    Range: class {
        constructor(startLine, startCharacter, endLine, endCharacter) {
            this.start = { line: startLine, character: startCharacter };
            this.end = { line: endLine, character: endCharacter };
        }
    },
    ProgressLocation: { Notification: 1 },
    EventEmitter: class { event() {} fire() {} }
};
