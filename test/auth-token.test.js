// test/auth-token.test.js - tests backend/lib/authToken.js (signed session
// tokens for GitHub-verified identity). This is the auth boundary of the
// whole free-tier quota system: if a token can be forged, an attacker gets
// a fresh 20-edits/day quota per fabricated identity and can claim trials.
//
// The module reads process.env.AUTH_SECRET at LOAD time, so each suite
// sets the env var first and re-imports with a cache-busting query string
// (mirrors how gemini-fallback.test.js re-imports an ESM backend lib).

const path = require('path');
const { suite, check, summary } = require('./helpers');

const AUTH_LIB = path.join(__dirname, '..', 'backend', 'lib', 'authToken.js');

function load(secret) {
  if (secret === undefined) {
    delete process.env.AUTH_SECRET;
  } else {
    process.env.AUTH_SECRET = secret;
  }
  const qs = Date.now() + '-' + Math.random();
  return import('file://' + AUTH_LIB + '?cache=' + qs);
}

async function run() {
  suite('signSession mints a token that verifySession accepts');
  {
    const { signSession, verifySession } = await load('test-secret-abc123');
    const token = signSession({ githubId: 98765, login: 'octocat' }, 3600);

    check('token is a non-empty string with payload.signature shape', typeof token === 'string' && token.includes('.'));

    const payload = verifySession(token);
    check('verifySession returns the original identity', !!payload && payload.sub === '98765' && payload.login === 'octocat');
    check('payload carries numeric iat and a future exp', typeof payload.iat === 'number' && typeof payload.exp === 'number' && payload.exp > payload.iat);
    check('custom TTL of 3600s is honored', Math.abs((payload.exp - payload.iat) - 3600 * 1000) < 1000);
  }

  suite('verifySession rejects tampered, malformed, and expired tokens');
  {
    const { signSession, verifySession } = await load('test-secret-abc123');

    const token = signSession({ githubId: 123, login: 'alice' }, 3600);
    const parts = token.split('.');
    const payloadB64 = parts[0];
    const sigB64 = parts[1];

    const tamperedPayload = Buffer.from(JSON.stringify({ sub: '999', login: 'attacker', iat: Date.now(), exp: Date.now() + 3600000 })).toString('base64url');
    check('tampered payload (same signature) is rejected', verifySession(tamperedPayload + '.' + sigB64) === null);

    const badSig = sigB64.slice(0, -2) + 'AA';
    check('tampered signature is rejected', verifySession(payloadB64 + '.' + badSig) === null);

    const expired = signSession({ githubId: 123, login: 'alice' }, -60); // expired 60s ago
    check('expired token is rejected', verifySession(expired) === null);

    check('null token is rejected', verifySession(null) === null);
    check('empty string is rejected', verifySession('') === null);
    check('non-string token is rejected', verifySession(123) === null);
    check('token with no dot is rejected', verifySession('payload-without-separator') === null);
    check('token with empty signature half is rejected', verifySession(payloadB64 + '.') === null);
    check('garbage base64url signature is rejected', verifySession(payloadB64 + '.!!!not-base64!!!') === null);
    check('non-JSON payload body is rejected', verifySession(Buffer.from('not json').toString('base64url') + '.' + sigB64) === null);
  }

  suite('verifySession rejects tokens signed with a DIFFERENT secret');
  {
    const { signSession } = await load('secret-A');
    const { verifySession } = await load('secret-B');

    const token = signSession({ githubId: 1, login: 'bob' }, 3600);
 check('token signed with another secret fails verification', verifySession(token) === null);
  }

  suite('missing AUTH_SECRET fails closed (never verifies, never mints)');
  {
    const { signSession, verifySession } = await load(undefined);

    let threw = false;
    try {
      signSession({ githubId: 1, login: 'x' });
    } catch (err) {
      threw = true;
    }
    check('signSession throws when AUTH_SECRET is unset', threw === true);
    check('verifySession returns null when AUTH_SECRET is unset', verifySession('a.b') === null);
  }

  suite('login is coerced to string and defaulted to empty (defensive)');
  {
    const { signSession, verifySession } = await load('test-secret-abc123');
    const token = signSession({ githubId: 42, login: undefined }, 3600);
    const payload = verifySession(token);
    check('a missing login is stored as empty string, not undefined/null', !!payload && payload.login === '');
    check('sub is always a string even when given a number', !!payload && payload.sub === '42');
  }
}

module.exports = { run };

if (require.main === module) {
  run().then(() => process.exit(summary() ? 0 : 1));
}
