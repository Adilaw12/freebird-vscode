import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { chunkFile, INDEXABLE_EXTENSIONS, MAX_INDEXABLE_FILE_BYTES } from './chunker';
import { loadIndex, saveIndex, emptyIndex, addFileChunks, removeFileChunks, search, IndexData, IndexedChunk } from './store';
import { getEmbeddingProvider } from './embeddings';

const EXCLUDE_GLOB = '{**/node_modules/**,**/.git/**,**/dist/**,**/out/**,**/build/**,**/.freebird/**}';
const MAX_FILES = 3000; // sanity cap for huge monorepos — avoids pathological first-index cost/time
const EMBED_BATCH_SIZE = 20;

function hashContent(content: string): string {
    return crypto.createHash('sha1').update(content).digest('hex');
}

function getWorkspaceRoot(): string | null {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null;
}

function toRelPath(root: string, fsPath: string): string {
    return path.relative(root, fsPath).split(path.sep).join('/');
}

async function embedFile(
    provider: ReturnType<typeof getEmbeddingProvider>,
    relPath: string,
    content: string
): Promise<IndexedChunk[]> {
    const chunks = chunkFile(content);
    const indexedChunks: IndexedChunk[] = [];

    for (let i = 0; i < chunks.length; i += EMBED_BATCH_SIZE) {
        const batch = chunks.slice(i, i + EMBED_BATCH_SIZE);
        const vectors = await provider.embedBatch(batch.map(c => c.text));
        batch.forEach((chunk, j) => {
            indexedChunks.push({
                id: `${relPath}#${chunk.startLine}-${chunk.endLine}`,
                filePath: relPath,
                startLine: chunk.startLine,
                endLine: chunk.endLine,
                text: chunk.text,
                vector: vectors[j] ?? []
            });
        });
    }
    return indexedChunks;
}

export interface IndexProgress {
    filesProcessed: number;
    totalFiles: number;
    currentFile?: string;
}

/**
 * Builds or incrementally updates the codebase index for the current
 * workspace. Skips files whose content hash hasn't changed since the last
 * index, so re-running this after a small edit only re-embeds what changed.
 */
export async function buildIndex(
    context: vscode.ExtensionContext,
    sessionId: string,
    onProgress?: (p: IndexProgress) => void
): Promise<{ indexed: number; skipped: number; failed: number }> {
    const root = getWorkspaceRoot();
    if (!root) return { indexed: 0, skipped: 0, failed: 0 };

    const provider = getEmbeddingProvider(context, sessionId);
    let data = loadIndex(root) ?? emptyIndex(provider.id);

    // Embedding provider changed since last index (e.g. switched from Ollama
    // to cloud) — vectors from different models aren't comparable, start fresh.
    if (data.providerId !== provider.id) {
        data = emptyIndex(provider.id);
    }

    const uris = await vscode.workspace.findFiles('**/*', EXCLUDE_GLOB, MAX_FILES);
    const candidates = uris.filter(u => INDEXABLE_EXTENSIONS.has(path.extname(u.fsPath)));

    let indexed = 0, skipped = 0, failed = 0;
    const toEmbed: Array<{ relPath: string; content: string; hash: string }> = [];

    for (const uri of candidates) {
        const relPath = toRelPath(root, uri.fsPath);
        let stat: fs.Stats;
        try {
            stat = fs.statSync(uri.fsPath);
        } catch {
            continue;
        }
        if (stat.size > MAX_INDEXABLE_FILE_BYTES) { skipped++; continue; }

        let content: string;
        try {
            content = fs.readFileSync(uri.fsPath, 'utf8');
        } catch {
            failed++; continue;
        }
        if (content.includes('\0')) { skipped++; continue; } // binary file

        const hash = hashContent(content);
        if (data.fileHashes[relPath] === hash) { skipped++; continue; } // unchanged since last index

        toEmbed.push({ relPath, content, hash });
    }

    let processed = 0;
    for (const { relPath, content, hash } of toEmbed) {
        onProgress?.({ filesProcessed: processed, totalFiles: toEmbed.length, currentFile: relPath });

        try {
            const indexedChunks = await embedFile(provider, relPath, content);
            data = addFileChunks(data, relPath, hash, indexedChunks);
            indexed++;
        } catch (err) {
            failed++;
            // One file failing (e.g. a transient network error) shouldn't
            // abort indexing the rest of the workspace.
            console.error(`Freebird: failed to index ${relPath}:`, err);
        }

        processed++;
        // Save incrementally so a crash or cancel mid-index doesn't lose all progress.
        if (processed % 20 === 0) saveIndex(root, data);
    }

    // Drop chunks for files that were deleted since the last index.
    const stillPresent = new Set(candidates.map(u => toRelPath(root, u.fsPath)));
    for (const filePath of Object.keys(data.fileHashes)) {
        if (!stillPresent.has(filePath)) {
            data = removeFileChunks(data, filePath);
        }
    }

    saveIndex(root, data);
    return { indexed, skipped, failed };
}

/** Re-indexes a single file — called from the file-save watcher for incremental updates. */
export async function updateFileInIndex(context: vscode.ExtensionContext, sessionId: string, uri: vscode.Uri): Promise<void> {
    const root = getWorkspaceRoot();
    if (!root) return;
    if (!INDEXABLE_EXTENSIONS.has(path.extname(uri.fsPath))) return;

    let stat: fs.Stats;
    try {
        stat = fs.statSync(uri.fsPath);
    } catch {
        return; // deleted — handled by removeFileFromIndex via the delete watcher
    }
    if (stat.size > MAX_INDEXABLE_FILE_BYTES) return;

    let content: string;
    try {
        content = fs.readFileSync(uri.fsPath, 'utf8');
    } catch {
        return;
    }
    if (content.includes('\0')) return;

    const provider = getEmbeddingProvider(context, sessionId);
    let data = loadIndex(root) ?? emptyIndex(provider.id);
    if (data.providerId !== provider.id) return; // stale index — needs a full rebuild, not a spot update

    const relPath = toRelPath(root, uri.fsPath);
    const hash = hashContent(content);
    if (data.fileHashes[relPath] === hash) return; // no actual content change

    try {
        const indexedChunks = await embedFile(provider, relPath, content);
        data = addFileChunks(data, relPath, hash, indexedChunks);
        saveIndex(root, data);
    } catch (err) {
        console.error(`Freebird: incremental re-index failed for ${relPath}:`, err);
    }
}

export function removeFileFromIndex(uri: vscode.Uri): void {
    const root = getWorkspaceRoot();
    if (!root) return;
    const data = loadIndex(root);
    if (!data) return;
    saveIndex(root, removeFileChunks(data, toRelPath(root, uri.fsPath)));
}

export function getIndexStats(): { chunkCount: number; fileCount: number } | null {
    const root = getWorkspaceRoot();
    if (!root) return null;
    const data = loadIndex(root);
    if (!data) return null;
    return { chunkCount: data.chunks.length, fileCount: Object.keys(data.fileHashes).length };
}

export interface SemanticSearchResult {
    filePath: string;
    startLine: number;
    endLine: number;
    text: string;
    score: number;
}

/**
 * Embeds the query and returns the top-K most similar chunks. Builds the
 * index on first use if one doesn't exist yet — semantic search is opt-in by
 * use, not by a separate activation-time cost every user pays whether they
 * touch the agent or not.
 */
export async function searchCodebaseSemantic(
    context: vscode.ExtensionContext,
    sessionId: string,
    query: string,
    k: number = 8,
    onProgress?: (p: IndexProgress) => void
): Promise<SemanticSearchResult[]> {
    const root = getWorkspaceRoot();
    if (!root) return [];

    let data = loadIndex(root);
    if (!data || data.chunks.length === 0) {
        await buildIndex(context, sessionId, onProgress);
        data = loadIndex(root);
    }
    if (!data || data.chunks.length === 0) return [];

    const provider = getEmbeddingProvider(context, sessionId);
    if (data.providerId !== provider.id) {
        // Provider changed since the index was built — rebuild rather than
        // return garbage results from mismatched vector spaces.
        await buildIndex(context, sessionId, onProgress);
        data = loadIndex(root);
    }
    if (!data || data.chunks.length === 0) return [];

    const [queryVector] = await provider.embedBatch([query]);
    const results = search(data, queryVector, k);
    return results.map(r => ({ filePath: r.filePath, startLine: r.startLine, endLine: r.endLine, text: r.text, score: r.score }));
}
