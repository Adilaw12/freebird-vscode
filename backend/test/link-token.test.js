// test/link-token.test.js — checkout link tokens and licence resolution.

process.env.AUTH_SECRET = 'test-secret-for-link-tokens';

const { signLinkToken, verifyLinkToken } = await import('../lib/linkToken.js');
const { signSession } = await import('../lib/authToken.js');
const { resolveLicenseKey } = await import('../lib/licenseResolve.js');

let total = 0;
let failed = 0;
function check(label, condition) {
    total++;
    if (!condition) failed++;
    console.log(`${condition ? 'PASS' : 'FAIL'} — ${label}`);
}

console.log('\n--- link tokens ---');
const t = signLinkToken({ githubId: 12345, login: 'adisa', plan: 'pro' });
const v = verifyLinkToken(t);
check('round trip keeps the GitHub id, login and plan', v?.sub === '12345' && v.login === 'adisa' && v.plan === 'pro');
check('expired token is rejected', verifyLinkToken(signLinkToken({ githubId: 1 }, 60, Date.now() - 120_000)) === null);
check('tampered payload is rejected', (() => {
    const [p, s] = t.split('.');
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(p, 'base64url')), sub: '999' })).toString('base64url');
    return verifyLinkToken(`${forged}.${s}`) === null;
})());
check('garbage is rejected', verifyLinkToken('nope') === null && verifyLinkToken('') === null && verifyLinkToken(undefined) === null);
const session = signSession({ githubId: 12345, login: 'adisa' });
check('a session token is NOT accepted as a link token', verifyLinkToken(session) === null);

console.log('\n--- resolving a request to a licence key ---');
const store = new Map([
    ['ghlicense:12345', 'FB-AAAA-BBBB-CCCC-DDDD'],
    ['license:FB-AAAA-BBBB-CCCC-DDDD', { plan: 'pro', status: 'active' }],
    ['license:FBT-OLD1-OLD1-OLD1-OLD1', { plan: 'trial', status: 'active', trialEndsAt: new Date(Date.now() - 1000).toISOString() }],
    ['license:FB-LIVE-LIVE-LIVE-LIVE', { plan: 'pro', status: 'active' }]
]);
const redis = { get: async k => store.get(k) ?? null };
check('no key, no token: null', await resolveLicenseKey(redis, {}) === null);
check('pasted key only: that key, normalised', await resolveLicenseKey(redis, { licenseKey: ' fb-live-live-live-live ' }) === 'FB-LIVE-LIVE-LIVE-LIVE');
check('signed-in account with a linked licence: its key', await resolveLicenseKey(redis, { authToken: session }) === 'FB-AAAA-BBBB-CCCC-DDDD');
check('account with no linked licence: null', await resolveLicenseKey(redis, { authToken: signSession({ githubId: 777, login: 'x' }) }) === null);
check('invalid token is ignored', await resolveLicenseKey(redis, { authToken: 'bad' }) === null);
check('expired trial key in settings does not shadow the account licence',
    await resolveLicenseKey(redis, { licenseKey: 'FBT-OLD1-OLD1-OLD1-OLD1', authToken: session }) === 'FB-AAAA-BBBB-CCCC-DDDD');
check('an entitled pasted key still wins over the account licence',
    await resolveLicenseKey(redis, { licenseKey: 'FB-LIVE-LIVE-LIVE-LIVE', authToken: session }) === 'FB-LIVE-LIVE-LIVE-LIVE');

console.log(`\n${total - failed}/${total} checks passed`);
if (failed > 0) process.exit(1);
