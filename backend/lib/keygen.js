// Generates keys like OP-A2B3-C4D5-E6F7-G8H9
// Avoids ambiguous characters: 0/O, 1/I/L
const CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export function generateKey() {
    const seg = () =>
        Array.from({ length: 4 }, () => CHARS[Math.floor(Math.random() * CHARS.length)]).join('');
    return `OP-${seg()}-${seg()}-${seg()}-${seg()}`;
}
