// backend/lib/messageContent.js — tiny shared helper for api/chat.js.
//
// `content` is normally a plain string, but the extension's verify_diagram
// tool (Agent mode) can send an Anthropic-shaped content-block array when a
// tool result carries a rendered image (see src/ai/cloud.ts). Gemini/Cerebras
// don't understand that shape, so they need a safe text-only extraction
// instead of a stringified object landing in their request body.

/**
 * @param {string | Array<{type: string, text?: string}>} content
 * @returns {string}
 */
export function textOnlyContent(content) {
    if (!Array.isArray(content)) return content;
    const textBlock = content.find(b => b && b.type === 'text');
    return textBlock?.text ?? '[image omitted]';
}
