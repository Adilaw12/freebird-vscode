import * as vscode from 'vscode';
import { getCachedLicenseStatus } from '../license/validator';

const API_BASE = 'https://freebird-backend.vercel.app';

export interface EmbeddingProvider {
    /** Embeds a batch of texts, returning one vector per input in the same order. */
    embedBatch(texts: string[]): Promise<number[][]>;
    /** Human-readable name, stored alongside the index so a backend switch triggers a re-embed. */
    readonly id: string;
}

class OllamaEmbeddingProvider implements EmbeddingProvider {
    readonly id = 'ollama:nomic-embed-text';

    private get url() {
        return vscode.workspace.getConfiguration('freebird').get<string>('ollamaUrl', 'http://localhost:11434');
    }

    async embedBatch(texts: string[]): Promise<number[][]> {
        // Ollama's embeddings endpoint takes one prompt per request. Run with
        // limited concurrency rather than fully serial (faster) or fully
        // parallel (can overwhelm a local model server).
        const CONCURRENCY = 4;
        const url = this.url;
        const results: number[][] = new Array(texts.length);

        let cursor = 0;
        const worker = async () => {
            while (cursor < texts.length) {
                const i = cursor++;
                const res = await fetch(`${url}/api/embeddings`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ model: 'nomic-embed-text', prompt: texts[i] })
                });
                if (!res.ok) {
                    throw new Error(`Ollama embeddings error: ${res.statusText}. Is 'ollama pull nomic-embed-text' done?`);
                }
                const data = await res.json() as { embedding?: number[] };
                results[i] = data.embedding ?? [];
            }
        };

        await Promise.all(Array.from({ length: Math.min(CONCURRENCY, texts.length) }, () => worker()));
        return results;
    }
}

class CloudEmbeddingProvider implements EmbeddingProvider {
    readonly id = 'cloud:gemini-embedding-001';

    constructor(private sessionId: string) {}

    async embedBatch(texts: string[]): Promise<number[][]> {
        const res = await fetch(`${API_BASE}/api/embed`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ texts, sessionId: this.sessionId }),
            signal: AbortSignal.timeout(30_000)
        });

        if (res.status === 429) {
            const body = await res.json().catch(() => ({})) as { error?: string };
            throw new Error(body.error ?? 'Embedding quota reached for today. Try again tomorrow, or switch to Ollama for unlimited local indexing.');
        }
        if (!res.ok) {
            throw new Error(`Embedding request failed: ${res.statusText}`);
        }

        const data = await res.json() as { embeddings: number[][] };
        return data.embeddings;
    }
}

class OpenAIEmbeddingProvider implements EmbeddingProvider {
    readonly id = 'openai:text-embedding-3-small';

    private get apiKey() {
        return vscode.workspace.getConfiguration('freebird').get<string>('apiKey', '');
    }

    async embedBatch(texts: string[]): Promise<number[][]> {
        const res = await fetch('https://api.openai.com/v1/embeddings', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${this.apiKey}`
            },
            body: JSON.stringify({ model: 'text-embedding-3-small', input: texts })
        });

        if (!res.ok) {
            throw new Error(`OpenAI embeddings error: ${res.statusText}`);
        }

        const data = await res.json() as { data: Array<{ embedding: number[] }> };
        return data.data.map(d => d.embedding);
    }
}

/**
 * Mirrors the same routing logic as getProvider() in src/ai/index.ts:
 * - backend=ollama -> local embeddings, always free
 * - backend=openai AND licensed -> BYOK embeddings (same license gate as chat,
 *   for consistency — see getProvider() for why BYOK requires a license)
 * - everything else -> cloud (Gemini) embeddings, cheap enough to stay free-tier
 */
export function getEmbeddingProvider(context: vscode.ExtensionContext, sessionId: string): EmbeddingProvider {
    const backend = vscode.workspace.getConfiguration('freebird').get<string>('backend', 'cloud');

    if (backend === 'ollama') {
        return new OllamaEmbeddingProvider();
    }
    if (backend === 'openai' && getCachedLicenseStatus().isPro) {
        return new OpenAIEmbeddingProvider();
    }
    return new CloudEmbeddingProvider(sessionId);
}
