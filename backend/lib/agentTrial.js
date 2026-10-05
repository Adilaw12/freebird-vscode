// backend/lib/agentTrial.js — the free Agent-mode trial budget for api/chat.js.
//
// Free-tier users get a few real Agent-mode runs so Pro's headline feature
// isn't invisible to anyone who never starts the 7-day trial. The cost bound is
// a LIFETIME budget of model requests per identity (an Agent-mode run is
// several requests), not a daily one, with a per-IP daily counter behind it to
// limit what resetting the machine id can buy. Same atomic reserve-then-refund
// pattern as lib/quota.js, and it deliberately does not touch the daily chat
// quota. Client counterpart: src/license/agentTrial.ts.

import { reserveSingleCounter } from './quota.js';

export const AGENT_TRIAL_MAX_REQUESTS = 24;   // ≈ 3 runs at the client's 8-iteration cap
export const AGENT_TRIAL_IP_DAILY     = 60;
export const AGENT_TRIAL_TTL          = 400 * 24 * 60 * 60;
export const AGENT_TRIAL_MAX_TOKENS   = 4096;
const IP_TTL = 24 * 60 * 60;

export function agentTrialKeys(identityKey, hashedIp, today) {
    return {
        idKey: `agenttrial:${String(identityKey).slice(0, 48)}`,
        ipKey: `agenttrial:ip:${hashedIp}:${today}`
    };
}

/**
 * Atomically reserves one model request from the trial budget.
 * @returns {{blocked: false, remaining: number, keys: object} |
 *           {blocked: true, code: 'AGENT_TRIAL_EXHAUSTED'|'AGENT_TRIAL_RATE_LIMITED'}}
 */
export async function reserveAgentTrial(redis, identityKey, hashedIp, today, limits = {}) {
    const maxRequests = limits.maxRequests ?? AGENT_TRIAL_MAX_REQUESTS;
    const ipDaily     = limits.ipDaily ?? AGENT_TRIAL_IP_DAILY;
    const keys = agentTrialKeys(identityKey, hashedIp, today);

    const idRes = await reserveSingleCounter(redis, keys.idKey, maxRequests, AGENT_TRIAL_TTL);
    if (idRes.blocked) return { blocked: true, code: 'AGENT_TRIAL_EXHAUSTED' };

    const ipRes = await reserveSingleCounter(redis, keys.ipKey, ipDaily, IP_TTL);
    if (ipRes.blocked) {
        await redis.decr(keys.idKey).catch(() => {});
        return { blocked: true, code: 'AGENT_TRIAL_RATE_LIMITED' };
    }

    return { blocked: false, remaining: Math.max(0, maxRequests - idRes.count), keys };
}

/** Refund a reservation whose upstream request failed — nobody is charged for an unserved request. */
export async function refundAgentTrial(redis, keys) {
    await redis.decr(keys.idKey).catch(() => {});
    await redis.decr(keys.ipKey).catch(() => {});
}
