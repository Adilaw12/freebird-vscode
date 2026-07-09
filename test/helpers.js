// test/helpers.js — tiny, dependency-free test utilities.
// No Jest/Mocha — this repo has no test framework yet, and pulling one in
// just for a handful of pure-logic checks is more weight than value right
// now. If the suite grows significantly, revisit.

function makeFakeContext() {
    const store = new Map();
    return {
        globalState: {
            get: (k, d) => (store.has(k) ? store.get(k) : d),
            update: (k, v) => { store.set(k, v); return Promise.resolve(); }
        },
        secrets: {
            get: () => Promise.resolve(undefined),
            store: () => Promise.resolve(),
            delete: () => Promise.resolve()
        }
    };
}

let total = 0;
let failed = 0;
let currentSuite = '';

function suite(name) {
    currentSuite = name;
    console.log(`\n--- ${name} ---`);
}

function check(label, condition) {
    total++;
    const ok = !!condition;
    if (!ok) failed++;
    console.log(`${ok ? 'PASS' : 'FAIL'} — ${label}`);
    return ok;
}

async function checkAsync(label, fn) {
    try {
        const result = await fn();
        return check(label, result);
    } catch (err) {
        total++;
        failed++;
        console.log(`FAIL — ${label} (threw: ${err.message})`);
        return false;
    }
}

function summary() {
    console.log('\n=====================================');
    console.log(`${total - failed}/${total} checks passed` + (failed ? ` — ${failed} FAILED` : ''));
    return failed === 0;
}

module.exports = { makeFakeContext, suite, check, checkAsync, summary };
