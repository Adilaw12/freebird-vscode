// test/prompt-templates.test.js — sanity checks on the built-in prompt
// templates. Not testing prose quality (that's a judgment call, not a bug),
// just structural guarantees the QuickPick and webview code relies on.

const path = require('path');
const { suite, check } = require('./helpers');

const OUT = path.join(__dirname, '..', 'out');
const { PROMPT_TEMPLATES } = require(path.join(OUT, 'agent/promptTemplates.js'));

function run() {
    suite('PROMPT_TEMPLATES structural guarantees');
    {
        check('exactly 3 built-in templates', PROMPT_TEMPLATES.length === 3);

        const ids = PROMPT_TEMPLATES.map(t => t.id);
        check('every template has a non-empty id/label/description/prompt', PROMPT_TEMPLATES.every(t =>
            typeof t.id === 'string' && t.id.length > 0 &&
            typeof t.label === 'string' && t.label.length > 0 &&
            typeof t.description === 'string' && t.description.length > 0 &&
            typeof t.prompt === 'string' && t.prompt.length > 0
        ));
        check('ids are unique', new Set(ids).size === ids.length);
        check('expected templates are present', ids.includes('codebase-cartographer') &&
            ids.includes('security-auditor') && ids.includes('multi-file-test-engineer'));
    }
}

module.exports = { run };
