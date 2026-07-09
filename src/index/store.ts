// src/index/store.ts — local, on-disk vector index. No hosted vector
// database on purpose: at the scale of a single repo (thousands of chunks,
// not millions) brute-force search over a JSON file is completely fine, and
// it means embeddings never leave the user's machine except for the one API
// call needed to compute them.
//
// Takes a plain `root` directory string rather than touching vscode APIs
// directly, so this module is testable without a vscode mock.

import * as fs from 'fs';
import * as path from 'path';
import { EmbeddedItem, topKSimilar } from './vectorMath';

export const INDEX_RELATIVE_PATH = '.freebird/codeindex.json';

export interface IndexedChunk extends EmbeddedItem {
    id: string;         // `${filePath}#${startLine}-${endLine}`
    filePath: string;   // workspace-relative, forward-slash normalized
    startLine: number;
    endLine: number;
    text: string;
    vector: number[];
}

export interface IndexData {
    /** Which embedding provider produced these vectors — a provider change invalidates the whole index. */
    providerId: string;
    /** filePath -> content hash, used to skip re-embedding unchanged files. */
    fileHashes: Record<string, string>;
    chunks: IndexedChunk[];
}

export function emptyIndex(providerId: string): IndexData {
    return { providerId, fileHashes: {}, chunks: [] };
}

export function loadIndex(root: string): IndexData | null {
    const full = path.join(root, INDEX_RELATIVE_PATH);
    try {
        const raw = fs.readFileSync(full, 'utf8');
        const parsed = JSON.parse(raw) as IndexData;
        if (!parsed || !Array.isArray(parsed.chunks)) return null;
        return parsed;
    } catch {
        return null;
    }
}

export function saveIndex(root: string, data: IndexData): void {
    const full = path.join(root, INDEX_RELATIVE_PATH);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    // NOTE: stored as JSON for simplicity in v1. At very large repo sizes
    // (tens of thousands of chunks) a binary format (e.g. packed Float32Array)
    // would be meaningfully smaller and faster to load — revisit if indexing
    // time/file size actually becomes a complaint, not before.
    fs.writeFileSync(full, JSON.stringify(data), 'utf8');
}

/** Removes all chunks belonging to a file (e.g. before re-indexing it, or on delete). */
export function removeFileChunks(data: IndexData, filePath: string): IndexData {
    return {
        ...data,
        chunks: data.chunks.filter(c => c.filePath !== filePath),
        fileHashes: Object.fromEntries(Object.entries(data.fileHashes).filter(([f]) => f !== filePath))
    };
}

export function addFileChunks(data: IndexData, filePath: string, hash: string, chunks: IndexedChunk[]): IndexData {
    const withoutOld = removeFileChunks(data, filePath);
    return {
        ...withoutOld,
        fileHashes: { ...withoutOld.fileHashes, [filePath]: hash },
        chunks: [...withoutOld.chunks, ...chunks]
    };
}

export function search(data: IndexData, queryVector: number[], k: number = 8) {
    return topKSimilar(queryVector, data.chunks, k);
}
