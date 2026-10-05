import * as vscode from 'vscode';

// BYOK API keys live in VS Code's SecretStorage (the OS keychain), one per
// provider — not in the `freebird.apiKey` setting. A key in settings.json is
// plaintext on disk and rides along with Settings Sync to every signed-in
// machine; and a single shared setting meant switching provider overwrote the
// previous provider's key. The old setting is still read as a fallback and is
// migrated into secure storage on activation.

export const KEY_PROVIDERS = ['anthropic', 'openai', 'deepseek', 'qwen', 'kimi', 'custom'] as const;
export type KeyProvider = typeof KEY_PROVIDERS[number];

export function isKeyProvider(value: string): value is KeyProvider {
    return (KEY_PROVIDERS as readonly string[]).includes(value);
}

const secretName = (p: KeyProvider) => `freebird.apiKey.${p}`;
const MIGRATION_NOTICE_KEY = 'freebird.apiKeyMigrationNoticeShown';

// Providers read keys synchronously on the hot path (every streamed request,
// every tab completion), but SecretStorage is async — so keys are loaded into
// memory once at activation and every write goes to both.
const cache = new Map<KeyProvider, string>();
let secrets: vscode.SecretStorage | undefined;

function legacySettingKey(): string {
    return (vscode.workspace.getConfiguration('freebird').get<string>('apiKey', '') || '').trim();
}

/** Loads stored keys, then moves any key still in the old plaintext setting into secure storage. */
export async function initApiKeys(context: vscode.ExtensionContext): Promise<void> {
    secrets = context.secrets;
    cache.clear();
    for (const p of KEY_PROVIDERS) {
        try {
            const v = await secrets.get(secretName(p));
            if (v) cache.set(p, v);
        } catch { /* keychain unavailable — fall back to the legacy setting */ }
    }
    await migrateLegacyKey(context);
}

async function migrateLegacyKey(context: vscode.ExtensionContext): Promise<void> {
    const legacy = legacySettingKey();
    if (!legacy) return;

    // The old setting is shared by every provider, so it can only be attributed
    // to the backend currently selected. With any other backend (cloud/ollama)
    // we can't tell whose key it is — leave it in place as a fallback.
    const backend = vscode.workspace.getConfiguration('freebird').get<string>('backend', 'cloud');
    if (!isKeyProvider(backend)) return;

    try {
        if (!cache.has(backend)) await setApiKey(backend, legacy);
        // Remove the plaintext copy everywhere it could be set.
        const cfg = vscode.workspace.getConfiguration('freebird');
        await cfg.update('apiKey', undefined, vscode.ConfigurationTarget.Global);
        try { await cfg.update('apiKey', undefined, vscode.ConfigurationTarget.Workspace); } catch { /* no workspace open */ }
    } catch {
        return; // couldn't store it securely — keep the setting rather than lose the key
    }

    if (!context.globalState.get<boolean>(MIGRATION_NOTICE_KEY)) {
        await context.globalState.update(MIGRATION_NOTICE_KEY, true);
        vscode.window.showInformationMessage(
            "Freebird moved your API key into VS Code's secure storage — it's no longer saved in settings.json."
        );
    }
}

/** Key for a provider: secure storage first, then the legacy setting. Empty string if none. */
export function getApiKey(provider: KeyProvider): string {
    return cache.get(provider) ?? legacySettingKey();
}

export async function setApiKey(provider: KeyProvider, key: string): Promise<void> {
    const trimmed = key.trim();
    if (!trimmed) return;
    cache.set(provider, trimmed);
    await secrets?.store(secretName(provider), trimmed);
}

export async function clearApiKey(provider: KeyProvider): Promise<void> {
    cache.delete(provider);
    await secrets?.delete(secretName(provider));
}

export function hasApiKey(provider: KeyProvider): boolean {
    return getApiKey(provider).length > 0;
}
