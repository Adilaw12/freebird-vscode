// backend/lib/sseLines.js — line splitting for streamed SSE bodies.
//
// A network chunk can end in the middle of a `data: {...}` line. Decoding and
// splitting each chunk in isolation drops the text in any line that straddles
// a boundary (both halves fail to parse). This carries the partial tail over to
// the next chunk. Used by api/chat.js and api/fallback.js.

export function createLineSplitter() {
    const decoder = new TextDecoder();
    let pending = '';

    return {
        /** Feed one raw chunk; returns the complete lines it finished. */
        push(chunk) {
            pending += decoder.decode(chunk, { stream: true });
            const lines = pending.split('\n');
            pending = lines.pop() ?? '';
            return lines;
        },
        /** Call once at end of stream; returns a final unterminated line, if any. */
        flush() {
            pending += decoder.decode();
            const rest = pending;
            pending = '';
            return rest ? [rest] : [];
        }
    };
}
