// backend/lib/completionStats.js — server-side counters for tab-completion outcomes.
//
// The extension reports completion telemetry itself, so anything the server decides on its own (which
// provider answered, whether Cerebras came back empty, whether Gemini had to step in) was invisible:
// a Cerebras 429 or an empty reply that fell back to Gemini left only a log line. These counters live in
//   telemetry:completions:{YYYY-MM-DD}   hash — outcome name → count
// with fields such as:
//   cerebras:ok                       Cerebras returned usable text
//   cerebras:empty                    Cerebras answered but produced no text (see the :reason field below)
//   cerebras:empty:<finish>[+reasoning]   why: finish_reason, plus "+reasoning" when it only streamed reasoning
//   cerebras:error:http_<status>      Cerebras returned a non-OK status (e.g. 429)
//   cerebras:error:exception          Cerebras request threw or timed out
//   gemini:after_cerebras_fail        Gemini served a completion because Cerebras failed or came back empty

const STATS_TTL = 90 * 24 * 60 * 60; // same retention as the extension's telemetry hashes

/**
 * Adds 1 to each named field. Never throws: statistics must not break a completion.
 *
 * @param {object} redis an @upstash/redis client
 * @param {string} day YYYY-MM-DD (UTC)
 * @param {string[]} fields
 */
export async function recordCompletionOutcomes(redis, day, fields) {
    if (!Array.isArray(fields) || fields.length === 0) return;
    try {
        const key = `telemetry:completions:${day}`;
        const pipeline = redis.pipeline();
        for (const field of fields) pipeline.hincrby(key, field, 1);
        pipeline.expire(key, STATS_TTL);
        await pipeline.exec();
    } catch { /* ignore */ }
}
