// src/license/backendPicker.ts — pure logic for the "Configure AI Backend"
// picker, kept separate from the vscode.QuickPick wiring in extension.ts so
// it's testable without simulating an actual picker interaction.

export interface BackendPickerItem {
    label: string;
    /** Clean display name with no icon/lock decoration, for use in follow-up messages. */
    name: string;
    value: string;
    description: string;
    locked: boolean;
}

const BASE_ITEMS: { name: string; icon: string; value: string; description: string }[] = [
    { name: 'Freebird Cloud (default)', icon: 'zap',    value: 'cloud',     description: 'Gemini Flash — works instantly, 20 free edits/day' },
    { name: 'Ollama (local — free)',    icon: 'server', value: 'ollama',    description: 'Unlimited, 100% private, runs on your machine' },
    { name: 'Anthropic Claude',         icon: 'cloud',  value: 'anthropic', description: 'BYOK — direct-to-LLM speed, total privacy' },
    { name: 'OpenAI',                   icon: 'cloud',  value: 'openai',    description: 'BYOK — direct-to-LLM speed, total privacy' },
    { name: 'DeepSeek V4-pro',          icon: 'cloud',  value: 'deepseek',  description: 'BYOK — advanced reasoning model, excellent value' },
    { name: 'Qwen 2.5',                 icon: 'cloud',  value: 'qwen',      description: 'BYOK — powerful coding model via DashScope' }
];

/**
 * Builds the "Configure AI Backend" picker items. As of v0.8.9 every
 * backend — including all BYOK entries — is available on the free plan,
 * so nothing is ever locked. The isPro parameter is kept so callers don't
 * need to change, and `locked` is always false. Pro's value now lives in
 * unlimited cloud edits + agent mode, not in gating backends.
 */
export function buildBackendPickerItems(_isPro: boolean): BackendPickerItem[] {
    return BASE_ITEMS.map(item => ({
        label: `$(${item.icon}) ${item.name}`,
        name: item.name,
        value: item.value,
        description: item.description,
        locked: false
    }));
}
