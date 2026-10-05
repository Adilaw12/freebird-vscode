// backend/lib/usageStats.js — token-usage accounting for Anthropic requests.
//
// api/chat.js proxies Anthropic's stream but only forwards the text, so token
// counts (and whether prompt caching is actually engaging) were invisible:
// the only cost signal was the Anthropic console's daily totals, which can't
// be split by who the traffic was for. This reads the usage numbers out of the
// stream and rolls them up per day into telemetry:usage:{date}, split by
// audience and request kind, so cost per request / per agent run can be
// measured instead of estimated.
//
// Anthropic reports usage in two places: `message_start` carries the input
// side (input_tokens, cache_creation_input_tokens, cache_read_input_tokens)
// and a first output_tokens; `message_delta` carries the FINAL cumulative
// output_tokens (and may repeat input-side fields).

export const USAGE_METRICS = ['requests', 'input', 'cache_write', 'cache_read', 'output'];

/** Accumulates usage across one request's stream events. */
export function createUsageTracker() {
    const usage = { input: 0, cache_write: 0, cache_read: 0, output: 0, seen: false };

    return {
        /** Feed each parsed SSE event; ignores everything but the two usage-bearing types. */
        consume(event) {
            if (!event || typeof event !== 'object') return;
            const u = event.type === 'message_start' ? event.message?.usage
                : event.type === 'message_delta' ? event.usage
                : null;
            if (!u) return;
            usage.seen = true;
            // Input-side fields appear on message_start; take the max so a repeat on
            // message_delta can't double-count. Output is cumulative, so max again.
            usage.input       = Math.max(usage.input,       Number(u.input_tokens) || 0);
            usage.cache_write = Math.max(usage.cache_write, Number(u.cache_creation_input_tokens) || 0);
            usage.cache_read  = Math.max(usage.cache_read,  Number(u.cache_read_input_tokens) || 0);
            usage.output      = Math.max(usage.output,      Number(u.output_tokens) || 0);
        },
        snapshot() { return { ...usage }; }
    };
}

/**
 * Who the traffic was for. Order matters: a free agent-trial request is not
 * unmetered even though it is served on Haiku.
 */
export function usageAudience({ agentTrialReserved, unmetered, licensePlan, templateHaikuEligible, premiumReserved }) {
    if (agentTrialReserved) return 'agent_trial';
    if (templateHaikuEligible) return 'template';
    if (unmetered) return licensePlan === 'trial' ? 'trial' : 'paid';
    return premiumReserved ? 'paid' : 'other';
}

/** haiku | sonnet | other — pricing differs, so the model family is part of the key. */
export function modelFamily(modelUsed) {
    const m = String(modelUsed || '').toLowerCase();
    if (m.includes('sonnet')) return 'sonnet';
    if (m.includes('haiku')) return 'haiku';
    return 'other';
}

export function usageKey(date) {
    return `telemetry:usage:${date}`;
}

/** hash field -> increment for one finished request, or null if the stream carried no usage. */
export function usageIncrements(snapshot, { audience, kind, family }) {
    if (!snapshot || !snapshot.seen) return null;
    const base = `${audience}:${kind}:${family}`;
    return {
        [`${base}:requests`]:    1,
        [`${base}:input`]:       snapshot.input,
        [`${base}:cache_write`]: snapshot.cache_write,
        [`${base}:cache_read`]:  snapshot.cache_read,
        [`${base}:output`]:      snapshot.output
    };
}

/** Writes a finished request's usage. Never throws — accounting must not break a response. */
export async function recordUsage(redis, date, snapshot, dims, ttlSeconds = 90 * 24 * 60 * 60) {
    try {
        const incs = usageIncrements(snapshot, dims);
        if (!incs) return false;
        const key = usageKey(date);
        const pipeline = redis.pipeline();
        for (const [field, n] of Object.entries(incs)) {
            if (n) pipeline.hincrby(key, field, n);
        }
        pipeline.expire(key, ttlSeconds);
        await pipeline.exec();
        return true;
    } catch (err) {
        console.error('Usage accounting error (chat):', err);
        return false;
    }
}

// Per-million-token prices (USD). Haiku 4.5 verified against the console bill
// on 2026-10-05; Sonnet 5 from the figures noted in api/chat.js. Cache writes
// cost 1.25x the input price and cache reads 0.1x (5-minute ephemeral cache).
export const PRICES = {
    haiku:  { input: 1, output: 5 },
    sonnet: { input: 2, output: 10 }
};

export function costOf(totals, family) {
    const p = PRICES[family];
    if (!p) return null;
    return (
        (totals.input       * p.input +
         totals.cache_write * p.input * 1.25 +
         totals.cache_read  * p.input * 0.1 +
         totals.output      * p.output) / 1_000_000
    );
}
