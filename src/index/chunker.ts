// src/index/chunker.ts — splits file content into overlapping chunks for
// embedding. Deliberately simple (fixed line-window, not AST-aware) — good
// enough to meaningfully beat keyword search, and easy to test/reason about.
// Pure logic, no vscode dependency, so it's directly unit-testable.

export interface Chunk {
    /** 0-based start line (inclusive) */
    startLine: number;
    /** 0-based end line (inclusive) */
    endLine: number;
    text: string;
}

const DEFAULT_CHUNK_LINES = 40;   // roughly 200-400 tokens for typical code
const DEFAULT_OVERLAP_LINES = 8;  // keeps context from being severed at chunk boundaries

/**
 * Splits file content into overlapping line-window chunks.
 * Skips chunks that are empty/whitespace-only.
 */
export function chunkFile(
    content: string,
    opts: { chunkLines?: number; overlapLines?: number } = {}
): Chunk[] {
    const chunkLines = opts.chunkLines ?? DEFAULT_CHUNK_LINES;
    const overlapLines = Math.min(opts.overlapLines ?? DEFAULT_OVERLAP_LINES, chunkLines - 1);
    const stride = chunkLines - overlapLines;

    const lines = content.split('\n');
    if (lines.length === 0) return [];

    const chunks: Chunk[] = [];
    for (let start = 0; start < lines.length; start += stride) {
        const end = Math.min(start + chunkLines, lines.length);
        const slice = lines.slice(start, end);
        const text = slice.join('\n');

        if (text.trim().length > 0) {
            chunks.push({ startLine: start, endLine: end - 1, text });
        }

        if (end >= lines.length) break;
    }

    return chunks;
}

/** Files below this are indexed whole (single chunk) rather than split — not worth the overhead. */
export const SMALL_FILE_LINE_THRESHOLD = DEFAULT_CHUNK_LINES;

/** Skip embedding files larger than this — avoids pathological cost/time on generated/data files. */
export const MAX_INDEXABLE_FILE_BYTES = 500_000; // 500KB

/** Extensions worth indexing. Deliberately conservative — binary/data/lockfiles add noise, not signal. */
export const INDEXABLE_EXTENSIONS = new Set([
    '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
    '.py', '.rb', '.go', '.rs', '.java', '.kt', '.swift', '.c', '.cpp', '.h', '.hpp', '.cs',
    '.php', '.scala', '.dart',
    '.html', '.css', '.scss', '.less',
    '.json', '.yaml', '.yml', '.toml',
    '.md', '.mdx',
    '.sql', '.sh', '.bash'
]);
