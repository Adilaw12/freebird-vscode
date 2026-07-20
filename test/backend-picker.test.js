// test/backend-picker.test.js — the "Configure AI Backend" picker must not
// let a non-Pro user configure a BYOK backend that getProvider() will then
// silently ignore. This locks in that the picker itself reflects reality.

require('./bootstrap');
const path = require('path');
const { suite, check } = require('./helpers');

const OUT = path.join(__dirname, '..', 'out');
const { buildBackendPickerItems } = require(path.join(OUT, 'license/backendPicker.js'));

const BYOK_VALUES = ['anthropic', 'openai', 'deepseek', 'qwen'];

function run() {
    suite('buildBackendPickerItems — no active license');
    {
        const items = buildBackendPickerItems(false);
        const byValue = Object.fromEntries(items.map(i => [i.value, i]));

        check('cloud is never locked', byValue.cloud.locked === false);
        check('ollama is never locked', byValue.ollama.locked === false);
        for (const v of BYOK_VALUES) {
            check(`${v} is locked when unlicensed`, byValue[v].locked === true);
            check(`${v}'s label signals it's locked`, byValue[v].label.includes('Requires Pro'));
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
        const locked = buildBackendPickerItems(false);
        const unlocked = buildBackendPickerItems(true);
        check('locked items\' name has no icon/lock decoration', locked.every(i => !i.name.includes('$(')));
        check('unlocked items\' name has no icon decoration', unlocked.every(i => !i.name.includes('$(')));
        check('name is stable across licensed/unlicensed for the same backend',
            locked.every((item, idx) => item.name === unlocked[idx].name));
    }
}

module.exports = { run };
