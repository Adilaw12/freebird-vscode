// Detects whether a conversation is a spatial-design task (floor plans, building
// layouts). Pure — no vscode import.
//
// Why it exists: the Pro model thinks before it writes, and for a layout brief it
// would plan silently for ~2 minutes before the first word (measured). create_floor_plan
// has a code validator that catches the mistakes that deliberation was meant to
// avoid, so these runs ask the model for low effort and let the validator do the
// checking. Everything else keeps the default effort.

const DESIGN_REQUEST = new RegExp([
    'floor\\s?-?plan', 'site\\s?plan', 'house\\s?plan', 'building\\s?plan', 'room\\s?layout', 'layout of (a|the|my)',
    'architect', 'blueprint',
    '\\b\\d+\\s?-?\\s?(bed(room)?s?|storey|story)\\b',
    'design (a|an|the|my)\\b[^.]{0,60}\\b(house|home|villa|cottage|apartment|unit|office|clinic|surgery|school|classroom|shop|store|cafe|caf\\u00e9|restaurant|hotel|building)\\b'
].join('|'), 'i');

const RECENT_TURNS = 6;

export function isDesignConversation(userMessage: string, history: { content: unknown }[] = []): boolean {
    if (DESIGN_REQUEST.test(userMessage)) return true;
    // A follow-up like "make the kitchen bigger" has no keywords of its own.
    for (const m of history.slice(-RECENT_TURNS)) {
        const text = typeof m.content === 'string' ? m.content : '';
        if (text && (/create_floor_plan/.test(text) || DESIGN_REQUEST.test(text))) return true;
    }
    return false;
}
