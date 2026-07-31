// Generates keys like FB-A2B3-C4D5-E6F7-G8H9 (paid) or FBT-A2B3-C4D5-E6F7-G8H9
// (trial) — the prefix is purely a human-readable marker for support/debugging;
// actual authorization always comes from the license object's own `plan` field
// looked up server-side, never from the key string itself.
// Avoids ambiguous characters: 0/O, 1/I/L
const CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export function generateKey(prefix = 'FB') {
    const seg = () =>
        Array.from({ length: 4 }, () => CHARS[Math.floor(Math.random() * CHARS.length)]).join('');
    return `${prefix}-${seg()}-${seg()}-${seg()}-${seg()}`;
}
