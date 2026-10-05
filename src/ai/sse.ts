/**
 * Splits a streaming HTTP body into complete lines, carrying any partial
 * trailing line over to the next network chunk.
 *
 * Network chunks do not respect SSE line boundaries: a `data: {...}` line is
 * routinely cut in two. Decoding each chunk independently and splitting on
 * '\n' (what the providers did before) silently drops both halves of any such
 * line — lost text tokens, and, worse, lost `input_json_delta` /
 * `tool_calls.arguments` fragments, which left a tool call with invalid JSON
 * and fell back to an empty `{}` input with no error shown.
 */
export class LineBuffer {
    private readonly decoder = new TextDecoder();
    private pending = '';

    /** Feed one raw chunk; returns the complete lines it finished. */
    push(chunk: Uint8Array): string[] {
        this.pending += this.decoder.decode(chunk, { stream: true });
        return this.drain();
    }

    /** Call once at end of stream; returns a final unterminated line, if any. */
    flush(): string[] {
        this.pending += this.decoder.decode();
        const rest = this.pending;
        this.pending = '';
        return rest.length > 0 ? [rest] : [];
    }

    private drain(): string[] {
        const lines = this.pending.split('\n');
        this.pending = lines.pop() ?? '';
        return lines;
    }
}

/**
 * Yields the payload of every complete `data:` line in an SSE response,
 * trimmed (so `data: [DONE]` yields `[DONE]`). Non-data lines (event:, blank,
 * comments) are skipped.
 */
export async function* sseData(response: Response): AsyncGenerator<string> {
    const reader = response.body!.getReader();
    const buffer = new LineBuffer();

    const toData = (line: string): string | null => {
        const trimmed = line.trim();
        return trimmed.startsWith('data:') ? trimmed.slice(5).trim() : null;
    };

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        for (const line of buffer.push(value)) {
            const data = toData(line);
            if (data !== null) yield data;
        }
    }
    for (const line of buffer.flush()) {
        const data = toData(line);
        if (data !== null) yield data;
    }
}
