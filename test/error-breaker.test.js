// test/error-breaker.test.js
//
// ErrorBreaker stops tab completion from retrying a failing backend at every pause in typing.

const path = require('path');
const { suite, check } = require('./helpers');

const { ErrorBreaker } = require(path.join(__dirname, '..', 'out', 'inline', 'errorBreaker.js'));

async function run() {
    const MIN = 60_000;
    let t = 1_000_000;
    const clock = () => t;

    suite('error breaker: opens after a run of failures');
    {
        const b = new ErrorBreaker(5, 2 * MIN, 30 * MIN, clock);
        check('starts closed', b.isOpen === false && b.remainingMs === 0);
        const opened = [1, 2, 3, 4].map(() => b.recordFailure());
        check('four failures do not open it', opened.every(x => x === false) && b.isOpen === false);
        check('the fifth failure opens it and reports that', b.recordFailure() === true && b.isOpen === true);
        check('it stays open for the first wait (2 minutes)', b.remainingMs === 2 * MIN);
        t += 2 * MIN - 1;
        check('still open just before the wait ends', b.isOpen === true);
        t += 1;
        check('closes when the wait ends', b.isOpen === false);
    }

    suite('error breaker: a failure after reopening trips it again, with a longer wait');
    {
        t = 2_000_000;
        const b = new ErrorBreaker(5, 2 * MIN, 30 * MIN, clock);
        for (let i = 0; i < 5; i++) b.recordFailure();
        t += 2 * MIN;
        check('one probe request is allowed after the wait', b.isOpen === false);
        check('that probe failing opens it again at once', b.recordFailure() === true && b.isOpen === true);
        check('the second wait is doubled (4 minutes)', b.remainingMs === 4 * MIN);
    }

    suite('error breaker: the wait is capped');
    {
        t = 3_000_000;
        const b = new ErrorBreaker(2, 2 * MIN, 30 * MIN, clock);
        let last = 0;
        for (let round = 0; round < 8; round++) {
            b.recordFailure(); b.recordFailure();
            last = b.remainingMs;
            t += last;
        }
        check('never waits longer than 30 minutes', last === 30 * MIN);
    }

    suite('error breaker: a success resets everything');
    {
        t = 4_000_000;
        const b = new ErrorBreaker(3, 2 * MIN, 30 * MIN, clock);
        b.recordFailure(); b.recordFailure();
        b.recordSuccess();
        check('failures before a success do not count toward the limit', b.recordFailure() === false && b.isOpen === false);
        b.recordFailure();
        check('it takes a fresh run of failures to open', b.recordFailure() === true);
        t += 2 * MIN;
        b.recordFailure();           // probe fails, wait doubles to 4 minutes
        t += 4 * MIN;
        b.recordSuccess();           // backend recovered
        check('a success closes it', b.isOpen === false);
        for (let i = 0; i < 3; i++) b.recordFailure();
        check('after recovery the wait starts from the beginning again', b.remainingMs === 2 * MIN);
    }
}

module.exports = { run };

if (require.main === module) {
    const { summary } = require('./helpers');
    run().then(() => process.exit(summary() ? 0 : 1));
}
