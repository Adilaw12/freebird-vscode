/**
 * Stops tab completion from hammering a backend that keeps failing.
 *
 * A broken bring-your-own-key setup (unreachable endpoint, bad key, dead network) used to send a request at
 * every pause in typing, each one failing: one day showed 465 failed Qwen completions. After `limit`
 * failures in a row the breaker opens and requests stop for a while; the wait doubles each time the
 * backend is still failing when it reopens, up to `maxMs`, and one success resets everything.
 *
 * Pure (no VS Code imports) so it can be tested directly.
 */
export class ErrorBreaker {
    private streak = 0;
    private openUntil = 0;
    private waitMs: number;

    constructor(
        private readonly limit = 5,
        private readonly startMs = 2 * 60_000,
        private readonly maxMs = 30 * 60_000,
        private readonly now: () => number = Date.now
    ) {
        this.waitMs = startMs;
    }

    /** True while requests should not be sent. */
    get isOpen(): boolean {
        return this.now() < this.openUntil;
    }

    /** Milliseconds until requests resume (0 when closed). */
    get remainingMs(): number {
        return Math.max(0, this.openUntil - this.now());
    }

    /** Records one failed request. Returns true when this failure opened the breaker. */
    recordFailure(): boolean {
        this.streak++;
        if (this.streak < this.limit) return false;
        this.openUntil = this.now() + this.waitMs;
        this.waitMs = Math.min(this.maxMs, this.waitMs * 2);
        return true;
    }

    /** Records a request that got an answer (including an empty one). */
    recordSuccess(): void {
        this.streak = 0;
        this.waitMs = this.startMs;
        this.openUntil = 0;
    }
}
