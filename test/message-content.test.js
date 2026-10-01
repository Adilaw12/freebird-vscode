// test/message-content.test.js — tests backend/lib/messageContent.js, the
// helper that keeps Gemini/Cerebras safe when a message carries an
// Anthropic-shaped content-block array (verify_diagram's rendered image).

const path = require('path');
const { suite, check, summary } = require('./helpers');

async function run() {
    const modPath = path.join(__dirname, '..', 'backend', 'lib', 'messageContent.js');
    const { textOnlyContent } = await import(`file://${modPath}`);

    suite('textOnlyContent passes plain strings through unchanged');
    {
        check('a normal string is returned as-is', textOnlyContent('hello') === 'hello');
        check('an empty string is returned as-is', textOnlyContent('') === '');
    }

    suite('textOnlyContent extracts the text block from a content-block array');
    {
        const content = [
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'abc123' } },
            { type: 'text', text: 'Diagram rendered successfully.' }
        ];
        check('extracts the text block\'s text', textOnlyContent(content) === 'Diagram rendered successfully.');
    }

    suite('textOnlyContent degrades gracefully when there is no text block');
    {
        const imageOnly = [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'abc123' } }];
        check('falls back to a placeholder rather than returning undefined/an object', textOnlyContent(imageOnly) === '[image omitted]');
    }

    suite('textOnlyContent never leaks a stringified object into a text field');
    {
        const content = [{ type: 'text', text: 'ok' }];
        check('result is always a string', typeof textOnlyContent(content) === 'string');
        check('result is never the literal "[object Object]"', textOnlyContent([{ type: 'image' }]) !== '[object Object]');
    }
}

module.exports = { run };

if (require.main === module) {
    run().then(() => process.exit(summary() ? 0 : 1));
}
