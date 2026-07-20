// src/license/backendPicker.ts — pure logic for the "Configure AI Backend"
// picker, kept separate from the vscode.QuickPick wiring in extension.ts so
// it's testable without simulating an actual picker interaction.

import { BYOK_BACKENDS } from '../ai/index';

export interface BackendPickerItem {
    label: string;
    /** Clean display name with no icon/lock decoration, for use in follow-up messages. */
    name: string;
    value: string;
    description: string;
    locked: boolean;
}

const BASE_ITEMS: { name: string; icon: string; value: string; description: string }[] = [
    { name: 'Freebird Cloud (default)', icon: 'zap',    value: 'cloud',     description: 'Gemini Flash — works instantly, 5 free edits/day' },
    { name: 'Ollama (local — free)',    icon: 'server', value: 'ollama',    description: 'Unlimited, 100% private, runs on your machine' },
    { name: 'Anthropic Claude',         icon: 'cloud',  value: 'anthropic', description: 'BYOK — direct-to-LLM speed, total privacy' },
    { name: 'OpenAI',                   icon: 'cloud',  value: 'openai',    description: 'BYOK — direct-to-LLM speed, total privacy' },
    { name: 'DeepSeek V4-pro',          icon: 'cloud',  value: 'deepseek',  description: 'BYOK — advanced reasoning model, excellent value' },
    { name: 'Qwen 2.5',                 icon: 'cloud',  value: 'qwen',      description: 'BYOK — powerful coding model via DashScope' }
];

/**
 * Builds the "Configure AI Backend" picker items. BYOK entries (anthropic/
 * openai/deepseek/qwen) are marked locked when the user has no active Pro/
 * Team/Enterprise license — the caller uses `locked` to short-circuit to an
 * upgrade prompt instead of the API-key entry flow, so the picker itself is
 * honest about what's actually usable rather than letting someone configure
 * a BYOK backend that getProvider() will silently ignore anyway.
 */
export function buildBackendPickerItems(isPro: boolean): BackendPickerItem[] {
    return BASE_ITEMS.map(item => {
        const locked = !isPro && BYOK_BACKENDS.has(item.value);
        return locked
            ? { label: `$(lock) ${item.name} — Requires Pro`, name: item.name, value: item.value, description: 'Upgrade to Pro to unlock', locked }
            : { label: `$(${item.icon}) ${item.name}`, name: item.name, value: item.value, description: item.description, locked };
    });
}
