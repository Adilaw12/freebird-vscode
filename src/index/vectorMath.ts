// src/index/vectorMath.ts — cosine similarity + top-K search.
// Deliberately brute-force: at the scale of a single repo (thousands of
// chunks, not millions), this is fast enough and needs no vector database.
// Revisit only if profiling actually shows this is a bottleneck.

export interface EmbeddedItem {
    id: string;
    vector: number[];
    [key: string]: unknown;
}

export function cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length || a.length === 0) return 0;

    let dot = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        normA += a[i] * a[i];
        normB += b[i] * b[i];
    }
    if (normA === 0 || normB === 0) return 0;
    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Returns the top-K items most similar to the query vector, sorted
 * descending by similarity. O(n log k) via a simple partial sort — fine at
 * the scale this is used for (thousands of chunks, not millions).
 */
export function topKSimilar<T extends EmbeddedItem>(
    queryVector: number[],
    items: T[],
    k: number
): Array<T & { score: number }> {
    const scored = items.map(item => ({ ...item, score: cosineSimilarity(queryVector, item.vector) }));
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, k);
}
