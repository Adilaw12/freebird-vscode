// test/mocks/upstash-redis.js
//
// In-memory mock of @upstash/redis, deliberately with a small artificial
// delay on incr/decr to simulate real network latency — WITHOUT that delay,
// concurrent calls in a test would never actually interleave (Node's event
// loop wouldn't yield), so the race condition this test suite exists to
// catch would never actually be exercised. The delay is what makes this a
// real test of the race, not just a test that happens to pass.

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

class MockPipeline {
    constructor(store) {
        this.store = store;
        this.ops = [];
    }
    incr(key)          { this.ops.push({ type: 'incr', key }); return this; }
    decr(key)          { this.ops.push({ type: 'decr', key }); return this; }
    expire(key, ttl)   { this.ops.push({ type: 'expire', key, ttl }); return this; }
    sadd(key, member)  { this.ops.push({ type: 'sadd', key, member }); return this; }

    async exec() {
        const results = [];
        for (const op of this.ops) {
            if (op.type === 'incr') {
                await delay(1 + Math.random() * 4); // simulate network latency BEFORE the mutation
                const current = (this.store.counters.get(op.key) ?? 0) + 1;
                this.store.counters.set(op.key, current);
                results.push(current);
            } else if (op.type === 'decr') {
                await delay(1 + Math.random() * 4);
                const current = (this.store.counters.get(op.key) ?? 0) - 1;
                this.store.counters.set(op.key, current);
                results.push(current);
            } else if (op.type === 'expire') {
                results.push(1);
            } else if (op.type === 'sadd') {
                const set = this.store.sets.get(op.key) ?? new Set();
                const added = set.has(op.member) ? 0 : 1;
                set.add(op.member);
                this.store.sets.set(op.key, set);
                results.push(added);
            }
        }
        return results;
    }
}

class MockRedis {
    constructor() {
        this.counters = new Map();
        this.sets = new Map();
        this.strings = new Map();
    }

    static fromEnv() {
        return new MockRedis();
    }

    async get(key) {
        if (this.counters.has(key)) return String(this.counters.get(key));
        if (this.strings.has(key)) return this.strings.get(key);
        return null;
    }

    async set(key, value) {
        this.strings.set(key, value);
        return 'OK';
    }

    async incr(key) {
        await delay(1 + Math.random() * 4);
        const current = (this.counters.get(key) ?? 0) + 1;
        this.counters.set(key, current);
        return current;
    }

    async decr(key) {
        await delay(1 + Math.random() * 4);
        const current = (this.counters.get(key) ?? 0) - 1;
        this.counters.set(key, current);
        return current;
    }

    async expire() { return 1; }

    async sadd(key, member) {
        const set = this.sets.get(key) ?? new Set();
        const added = set.has(member) ? 0 : 1;
        set.add(member);
        this.sets.set(key, set);
        return added;
    }

    pipeline() {
        return new MockPipeline(this);
    }
}

module.exports = { Redis: MockRedis };
