// test/backend-picker.test.js — the "Configure AI Backend" picker must
// reflect reality. As of v0.8.9, every backend (including all BYOK entries)
// is available on the free plan, so nothing is ever locked regardless of
// license status.

require('./bootstrap');
const path = require('path');
const { suite, check } = require('./helpers');

const OUT = path.join(__dirname, '..', 'out');
const { buildBackendPickerItems } = require(path.join(OUT, 'license/backendPicker.js'));

const BYOK_VALUES = ['anthropic', 'openai', 'deepseek', 'qwen', 'kimi', 'custom'];

function run() {
    suite('buildBackendPickerItems — no active license');
    {
        const items = buildBackendPickerItems(false);
        const byValue = Object.fromEntries(items.map(i => [i.value, i]));

        check('cloud is never locked', byValue.cloud.locked === false);
        check('ollama is never locked', byValue.ollama.locked === false);
        for (const v of BYOK_VALUES) {
            check(`${v} is not locked when unlicensed`, byValue[v].locked === false);
            check(`${v}'s label does not say Requires Pro`, !byValue[v].label.includes('Requires Pro'));
        }
    }

    suite('buildBackendPickerItems — active Pro license');
    {
        const items = buildBackendPickerItems(true);
        const byValue = Object.fromEntries(items.map(i => [i.value, i]));

        check('cloud is never locked', byValue.cloud.locked === false);
        check('ollama is never locked', byValue.ollama.locked === false);
        for (const v of BYOK_VALUES) {
            check(`${v} is unlocked when licensed`, byValue[v].locked === false);
            check(`${v}'s label does not say Requires Pro`, !byValue[v].label.includes('Requires Pro'));
        }
    }

    suite('every item has a clean "name" usable outside the decorated label');
    {
        const unlicensed = buildBackendPickerItems(false);
        const licensed = buildBackendPickerItems(true);
        check('unlicensed items\' name has no icon decoration', unlicensed.every(i => !i.name.includes('$(')));
        check('licensed items\' name has no icon decoration', licensed.every(i => !i.name.includes('$(')));
        check('name is stable across licensed/unlicensed for the same backend',
            unlicensed.every((item, idx) => item.name === licensed[idx].name));
    }
}

module.exports = { run };
