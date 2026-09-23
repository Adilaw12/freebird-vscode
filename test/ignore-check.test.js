// test/ignore-check.test.js — tests out/agent/ignoreCheck.js: the shared
// exclusion check every agent tool (read_file, write_file, edit_file,
// copy_file, download_file, create_diagram, list_files, search_code,
// @mentions, and the RAG indexer) consults before touching a path.
//
// This is the feature that closes the gap where Freebird had zero file
// exclusion — a hardcoded safety list for secrets/keys always applies,
// .gitignore applies unless freebird.agent.respectGitignore is turned off,
// and an optional custom ignore file always applies regardless.

require('./bootstrap');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { suite, check, summary } = require('./helpers');

const OUT = path.join(__dirname, '..', 'out');
const { isPathIgnored, ignoreBlockMessage } = require(path.join(OUT, 'agent/ignoreCheck.js'));

const vscode = require('vscode');

function makeTempWorkspace() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'freebird-ignore-test-'));
}

async function run() {
    suite('.gitignore patterns are respected by default');
    {
        const root = makeTempWorkspace();
        try {
            vscode.__setMockConfig({});
            fs.writeFileSync(path.join(root, '.gitignore'), 'secret.txt\nbuild/\n', 'utf8');
            check('a file matched by .gitignore is ignored', isPathIgnored(root, 'secret.txt') === true);
            check('a file not matched by .gitignore is not ignored', isPathIgnored(root, 'normal.txt') === false);
            check('a directory pattern matches files inside it', isPathIgnored(root, 'build/output.js') === true);
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    }

    suite('the built-in safety list blocks secrets even with no .gitignore at all');
    {
        const root = makeTempWorkspace();
        try {
            vscode.__setMockConfig({});
            check('.env is always blocked', isPathIgnored(root, '.env') === true);
            check('.env.local is always blocked (glob variant)', isPathIgnored(root, '.env.local') === true);
            check('a .pem file is always blocked', isPathIgnored(root, 'certs/server.pem') === true);
            check('an id_rsa key is always blocked', isPathIgnored(root, 'id_rsa') === true);
            check('an ordinary file is not affected by the safety list', isPathIgnored(root, 'index.ts') === false);
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    }

    suite('a custom ignore file (freebird.agent.ignoreFile) is picked up');
    {
        const root = makeTempWorkspace();
        try {
            vscode.__setMockConfig({});
            fs.writeFileSync(path.join(root, '.freebirdignore'), 'scratch/**\n', 'utf8');
            check('a path matched by the custom ignore file is ignored', isPathIgnored(root, 'scratch/notes.md') === true);
            check('an unrelated path is unaffected', isPathIgnored(root, 'src/index.ts') === false);
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    }

    suite('freebird.agent.respectGitignore: false disables .gitignore but not the safety list or the custom ignore file');
    {
        const root = makeTempWorkspace();
        try {
            fs.writeFileSync(path.join(root, '.gitignore'), 'secret.txt\n', 'utf8');
            fs.writeFileSync(path.join(root, '.freebirdignore'), 'scratch/**\n', 'utf8');
            vscode.__setMockConfig({ 'freebird.agent.respectGitignore': false });

            check('.gitignore no longer applies once disabled', isPathIgnored(root, 'secret.txt') === false);
            check('the built-in safety list still applies regardless', isPathIgnored(root, '.env') === true);
            check('the custom ignore file still applies regardless', isPathIgnored(root, 'scratch/notes.md') === true);
        } finally {
            vscode.__setMockConfig({});
            fs.rmSync(root, { recursive: true, force: true });
        }
    }

    suite('ignoreBlockMessage names the path and the attempted action');
    {
        const readMsg = ignoreBlockMessage('.env', 'read');
        const writeMsg = ignoreBlockMessage('.env', 'write');
        check('read message names the path', readMsg.includes('.env'));
        check('read message says "read"', readMsg.includes('read'));
        check('write message says "written to", not "read"', writeMsg.includes('written to') && !writeMsg.includes(' read '));
    }

    vscode.__setMockConfig({});
}

module.exports = { run };

if (require.main === module) {
    run().then(() => process.exit(summary() ? 0 : 1));
}
