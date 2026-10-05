// test/api-keys.test.js — BYOK keys live in secure storage, one per provider.
//
// They used to be one shared plaintext `freebird.apiKey` setting: written to
// settings.json (and synced to every machine by Settings Sync), and overwritten
// whenever the user switched provider. These tests lock in: per-provider
// storage, the migration out of the old setting, and that the legacy setting
// still works as a fallback so nobody is left without a key mid-upgrade.

const vscodeMock = require('./bootstrap');
const path = require('path');
const { suite, check, summary } = require('./helpers');

const OUT = path.join(__dirname, '..', 'out');
const keys = require(path.join(OUT, 'ai/keys.js'));
const { OpenAIProvider } = require(path.join(OUT, 'ai/openai.js'));
const { DeepSeekProvider } = require(path.join(OUT, 'ai/deepseek.js'));
const { AnthropicProvider } = require(path.join(OUT, 'ai/anthropic.js'));

function fakeContext(initialSecrets = {}) {
    const secrets = new Map(Object.entries(initialSecrets));
    const state = new Map();
    return {
        secrets: {
            get: async k => secrets.get(k),
            store: async (k, v) => { secrets.set(k, v); },
            delete: async k => { secrets.delete(k); }
        },
        globalState: {
            get: (k, d) => (state.has(k) ? state.get(k) : d),
            update: async (k, v) => { state.set(k, v); }
        },
        _secrets: secrets
    };
}

/** What each provider would send as its key, read the way the request code reads it. */
const keyOf = p => p.apiKey;

async function run() {
    suite('keys are stored per provider');
    {
        vscodeMock.__setMockConfig({ 'freebird.backend': 'cloud', 'freebird.apiKey': '' });
        const ctx = fakeContext();
        await keys.initApiKeys(ctx);
        await keys.setApiKey('anthropic', 'sk-ant-AAA');
        await keys.setApiKey('openai', 'sk-OPENAI');
        await keys.setApiKey('deepseek', 'sk-DEEP');

        check('anthropic provider uses the anthropic key', keyOf(new AnthropicProvider()) === 'sk-ant-AAA');
        check('openai provider uses the openai key', keyOf(new OpenAIProvider()) === 'sk-OPENAI');
        check('deepseek provider uses its own key, not openai\'s', keyOf(new DeepSeekProvider()) === 'sk-DEEP');
        check('switching provider no longer overwrites the previous one\'s key', keyOf(new AnthropicProvider()) === 'sk-ant-AAA');
        check('secrets land in SecretStorage under per-provider names', ctx._secrets.get('freebird.apiKey.anthropic') === 'sk-ant-AAA' && ctx._secrets.get('freebird.apiKey.openai') === 'sk-OPENAI');
    }

    suite('keys survive a restart (loaded back from secure storage)');
    {
        vscodeMock.__setMockConfig({ 'freebird.backend': 'cloud', 'freebird.apiKey': '' });
        const ctx = fakeContext({ 'freebird.apiKey.qwen': 'sk-QWEN' });
        await keys.initApiKeys(ctx);
        check('qwen key restored on activation', keys.getApiKey('qwen') === 'sk-QWEN');
        check('other providers stay empty', keys.getApiKey('kimi') === '');
    }

    suite('migration — old plaintext setting moves into secure storage');
    {
        vscodeMock.__setMockConfig({ 'freebird.backend': 'anthropic', 'freebird.apiKey': 'sk-ant-LEGACY' });
        vscodeMock.__resetCalls();
        const ctx = fakeContext();
        await keys.initApiKeys(ctx);

        check('the key is now in secure storage for the selected provider', ctx._secrets.get('freebird.apiKey.anthropic') === 'sk-ant-LEGACY');
        check('the plaintext setting was cleared', !vscodeMock.workspace.getConfiguration('freebird').get('apiKey'));
        check('the provider still works', keyOf(new AnthropicProvider()) === 'sk-ant-LEGACY');
        check('the user is told once', vscodeMock.__getCalls().showInformationMessage.length === 1);

        await keys.initApiKeys(ctx); // next launch: nothing left to migrate
        check('no repeat notice on the next launch', vscodeMock.__getCalls().showInformationMessage.length === 1);
    }

    suite('migration — never overwrites a key already in secure storage');
    {
        vscodeMock.__setMockConfig({ 'freebird.backend': 'openai', 'freebird.apiKey': 'sk-OLD' });
        const ctx = fakeContext({ 'freebird.apiKey.openai': 'sk-NEW' });
        await keys.initApiKeys(ctx);
        check('the newer stored key wins', keys.getApiKey('openai') === 'sk-NEW');
        check('the stale plaintext copy is still removed', !vscodeMock.workspace.getConfiguration('freebird').get('apiKey'));
    }

    suite('migration — a key that can\'t be attributed is left as a fallback');
    {
        vscodeMock.__setMockConfig({ 'freebird.backend': 'cloud', 'freebird.apiKey': 'sk-MYSTERY' });
        const ctx = fakeContext();
        await keys.initApiKeys(ctx);
        check('with backend=cloud the setting is not touched', vscodeMock.workspace.getConfiguration('freebird').get('apiKey') === 'sk-MYSTERY');
        check('and still serves as a fallback for any provider', keys.getApiKey('openai') === 'sk-MYSTERY');
        check('a stored key takes precedence over the fallback', (await keys.setApiKey('openai', 'sk-REAL'), keys.getApiKey('openai') === 'sk-REAL'));
    }

    suite('clearing keys');
    {
        vscodeMock.__setMockConfig({ 'freebird.backend': 'cloud', 'freebird.apiKey': '' });
        const ctx = fakeContext();
        await keys.initApiKeys(ctx);
        await keys.setApiKey('kimi', 'sk-KIMI');
        check('hasApiKey sees a stored key', keys.hasApiKey('kimi'));
        await keys.clearApiKey('kimi');
        check('clear removes it from memory and storage', !keys.hasApiKey('kimi') && !ctx._secrets.has('freebird.apiKey.kimi'));
        await keys.setApiKey('kimi', '   ');
        check('a blank key is ignored, not stored', !keys.hasApiKey('kimi'));
    }

    suite('isKeyProvider');
    {
        check('recognises BYOK backends', ['anthropic', 'openai', 'deepseek', 'qwen', 'kimi', 'custom'].every(keys.isKeyProvider));
        check('rejects cloud and ollama (they need no key)', !keys.isKeyProvider('cloud') && !keys.isKeyProvider('ollama'));
    }
}

module.exports = { run };

if (require.main === module) {
    run().then(() => process.exit(summary() ? 0 : 1));
}
