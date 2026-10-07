// Deterministic SVG renderer for a validated floor plan. Pure (no vscode import).
//
// Everything on the page is computed from the spec — wall positions, door swings,
// window glazing, room dimensions and areas, overall dimension lines, scale bar —
// so the drawing cannot disagree with the data the way hand-written SVG did
// (e.g. a room labelled 14 m wide but drawn 19 m wide).

import { Plan, Room, Validation, PlacedOpening, exteriorIntervals, Side } from './plan';
import { rulesFor, PACKS, DEFAULT_BUILDING_TYPE, WALL } from './reference';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const f = (n: number) => (Math.round(n * 10) / 10).toString();
const metres = (mm: number) => (mm / 1000).toFixed(2).replace(/\.?0+$/, '');
const INK = '#1b1b1b';

export function renderPlan(plan: Plan, v: Validation, title: string): string {
    const rules = rulesFor(plan.brief.buildingType);
    const rule = (r: Room) => rules[r.type] ?? rules.other;
    const pack = PACKS[plan.brief.buildingType] ?? PACKS[DEFAULT_BUILDING_TYPE];

    const minX = Math.min(...plan.rooms.map(r => r.x1)), minY = Math.min(...plan.rooms.map(r => r.y1));
    const maxX = Math.max(...plan.rooms.map(r => r.x2)), maxY = Math.max(...plan.rooms.map(r => r.y2));
    const Wm = (maxX - minX) / 1000, Hm = (maxY - minY) / 1000;
    const S = Math.max(14, Math.min(80, 1000 / Math.max(Wm, Hm)));   // px per metre
    const padL = 80, padT = 110, padR = 90, padB = 100;
    const X = (mm: number) => padL + ((mm - minX) / 1000) * S;
    const Y = (mm: number) => padT + ((mm - minY) / 1000) * S;
    const width = Math.round(padL + Wm * S + padR), height = Math.round(padT + Hm * S + padB);
    const wallExt = Math.max(4, WALL.exterior * S), wallInt = Math.max(2, WALL.interior * S);

    const out: string[] = [];
    out.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" font-family="'Segoe UI', Arial, sans-serif">`);
    out.push(`<rect width="${width}" height="${height}" fill="#ffffff"/>`);

    // Title block
    const indoor = plan.rooms.filter(r => !rule(r).outdoor);
    out.push(`<text x="${padL}" y="42" font-size="22" font-weight="700" fill="${INK}">${esc(title)}</text>`);
    out.push(`<text x="${padL}" y="64" font-size="13" fill="#555">${esc(pack.label)} · ${v.internalArea.toFixed(1)} m² internal · ${indoor.length} room${indoor.length === 1 ? '' : 's'} · ${f(Wm)} × ${f(Hm)} m overall</text>`);

    // Room fills
    for (const r of plan.rooms) {
        const k = rule(r);
        out.push(`<rect x="${f(X(r.x1))}" y="${f(Y(r.y1))}" width="${f((r.x2 - r.x1) / 1000 * S)}" height="${f((r.y2 - r.y1) / 1000 * S)}" fill="${k.fill}"${k.outdoor ? ` stroke="#6a8f5c" stroke-width="1.5" stroke-dasharray="6 4"` : ''}/>`);
    }

    // Walls: thick where exterior, thin where two indoor rooms meet
    const indoorRooms = indoor;
    const lineFor = (r: Room, side: Side): { x1: number; y1: number; x2: number; y2: number; a: number; b: number } => {
        switch (side) {
            case 'N': return { x1: r.x1, y1: r.y1, x2: r.x2, y2: r.y1, a: r.x1, b: r.x2 };
            case 'S': return { x1: r.x1, y1: r.y2, x2: r.x2, y2: r.y2, a: r.x1, b: r.x2 };
            case 'W': return { x1: r.x1, y1: r.y1, x2: r.x1, y2: r.y2, a: r.y1, b: r.y2 };
            case 'E': return { x1: r.x2, y1: r.y1, x2: r.x2, y2: r.y2, a: r.y1, b: r.y2 };
        }
    };
    const seg = (r: Room, side: Side, a: number, b: number, sw: number) => {
        const L = lineFor(r, side);
        const horiz = side === 'N' || side === 'S';
        const p1 = horiz ? [a, L.y1] : [L.x1, a], p2 = horiz ? [b, L.y1] : [L.x1, b];
        return `<line x1="${f(X(p1[0]))}" y1="${f(Y(p1[1]))}" x2="${f(X(p2[0]))}" y2="${f(Y(p2[1]))}" stroke="${INK}" stroke-width="${f(sw)}" stroke-linecap="square"/>`;
    };
    const thin: string[] = [], thick: string[] = [];
    for (const r of indoorRooms) {
        for (const side of ['N', 'E', 'S', 'W'] as Side[]) {
            const L = lineFor(r, side);
            thin.push(seg(r, side, L.a, L.b, wallInt));
            for (const [a, b] of exteriorIntervals(r, side, indoorRooms)) thick.push(seg(r, side, a, b, wallExt));
        }
    }
    out.push(...thin, ...thick);

    // Openings: carve the wall, then draw the symbol
    const along = (o: PlacedOpening, t: number) => o.orient === 'H' ? { x: X(t), y: Y(o.fixed) } : { x: X(o.fixed), y: Y(t) };
    const gap = (o: PlacedOpening) => {
        const a = along(o, o.center - o.width / 2), b = along(o, o.center + o.width / 2);
        const t = wallExt + 2;
        return o.orient === 'H'
            ? `<rect x="${f(a.x)}" y="${f(a.y - t / 2)}" width="${f(b.x - a.x)}" height="${f(t)}" fill="#ffffff"/>`
            : `<rect x="${f(a.x - t / 2)}" y="${f(a.y)}" width="${f(t)}" height="${f(b.y - a.y)}" fill="#ffffff"/>`;
    };
    const byId = new Map(plan.rooms.map(r => [r.id, r]));
    for (const o of v.windows) {
        out.push(gap(o));
        const a = along(o, o.center - o.width / 2), b = along(o, o.center + o.width / 2);
        const t = Math.max(3, wallExt * 0.7);
        out.push(o.orient === 'H'
            ? `<rect x="${f(a.x)}" y="${f(a.y - t / 2)}" width="${f(b.x - a.x)}" height="${f(t)}" fill="#d6ebf8" stroke="#3f77a0" stroke-width="1"/><line x1="${f(a.x)}" y1="${f(a.y)}" x2="${f(b.x)}" y2="${f(b.y)}" stroke="#3f77a0" stroke-width="1"/>`
            : `<rect x="${f(a.x - t / 2)}" y="${f(a.y)}" width="${f(t)}" height="${f(b.y - a.y)}" fill="#d6ebf8" stroke="#3f77a0" stroke-width="1"/><line x1="${f(a.x)}" y1="${f(a.y)}" x2="${f(b.x)}" y2="${f(b.y)}" stroke="#3f77a0" stroke-width="1"/>`);
    }
    for (const o of v.doors) {
        out.push(gap(o));
        const kind = o.kind ?? 'swing';
        const A = along(o, o.center - o.width / 2), B = along(o, o.center + o.width / 2);
        if (kind === 'open') continue;
        if (kind === 'sliding' || kind === 'vehicle') {
            out.push(`<line x1="${f(A.x)}" y1="${f(A.y)}" x2="${f(B.x)}" y2="${f(B.y)}" stroke="${INK}" stroke-width="1.5"${kind === 'vehicle' ? ' stroke-dasharray="5 3"' : ''}/>`);
            continue;
        }
        // Swing into the less public room (interior doors) or inward (exterior doors).
        const room = byId.get(o.room)!, other = o.other ? byId.get(o.other) : undefined;
        let intoRoom = true;
        if (other) { const rT = !!rule(room).transit, oT = !!rule(other).transit; intoRoom = (oT && !rT) ? true : (rT && !oT) ? false : true; }
        // direction of the room that owns the wall side
        const dirRoom = o.orient === 'H' ? { x: 0, y: o.side === 'N' ? 1 : -1 } : { x: o.side === 'W' ? 1 : -1, y: 0 };
        const n = intoRoom ? dirRoom : { x: -dirRoom.x, y: -dirRoom.y };
        const hinge = A, end = B;
        const len = o.width / 1000 * S;
        const leaf = { x: hinge.x + n.x * len, y: hinge.y + n.y * len };
        const cross = (leaf.x - hinge.x) * (end.y - hinge.y) - (leaf.y - hinge.y) * (end.x - hinge.x);
        out.push(`<line x1="${f(hinge.x)}" y1="${f(hinge.y)}" x2="${f(leaf.x)}" y2="${f(leaf.y)}" stroke="${INK}" stroke-width="1.6"/>`);
        out.push(`<path d="M ${f(leaf.x)} ${f(leaf.y)} A ${f(len)} ${f(len)} 0 0 ${cross > 0 ? 1 : 0} ${f(end.x)} ${f(end.y)}" fill="none" stroke="#666" stroke-width="1" stroke-dasharray="3 2"/>`);
    }

    // Labels
    for (const r of plan.rooms) {
        const k = rule(r);
        const wpx = (r.x2 - r.x1) / 1000 * S, hpx = (r.y2 - r.y1) / 1000 * S;
        let cx = X(r.x1) + wpx / 2, cy = Y(r.y1) + hpx / 2;
        // Nudge the label away from door swings in this room so the leaf/arc does not cross the text.
        // The total nudge is capped per axis, so a room with many doors (a hall) keeps its label inside.
        let dx = 0, dy = 0;
        for (const o of v.doors) {
            if (o.kind === 'open' || o.kind === 'sliding' || o.kind === 'vehicle') continue;
            let side: Side | undefined;
            if (o.room === r.id) side = o.side;
            else if (o.other === r.id) side = o.side === 'N' ? 'S' : o.side === 'S' ? 'N' : o.side === 'E' ? 'W' : 'E';
            if (!side) continue;
            const push = o.width / 1000 * S * 0.5;
            if (side === 'N') dy += push; else if (side === 'S') dy -= push;
            else if (side === 'W') dx += push; else dx -= push;
        }
        const lim = (n: number, size: number) => Math.max(-size * 0.2, Math.min(size * 0.2, n));
        cx += lim(dx, wpx); cy += lim(dy, hpx);
        const name = r.name.toUpperCase();
        const fs = Math.max(7, Math.min(14, wpx / (Math.max(name.length, 7) * 0.68)));
        if (fs < 7.5 && hpx < 24) continue;
        const showDims = !k.outdoor ? Math.min(wpx, hpx) >= 46 : Math.min(wpx, hpx) >= 46;
        const dims = `${metres(r.x2 - r.x1)} × ${metres(r.y2 - r.y1)} m`;
        const area = `${(((r.x2 - r.x1) * (r.y2 - r.y1)) / 1e6).toFixed(1)} m²`;
        out.push(`<text x="${f(cx)}" y="${f(cy - (showDims ? 6 : -4))}" font-size="${f(fs)}" font-weight="700" text-anchor="middle" fill="${INK}">${esc(name)}</text>`);
        if (showDims) {
            out.push(`<text x="${f(cx)}" y="${f(cy + 8)}" font-size="${f(Math.max(7, fs - 2.5))}" text-anchor="middle" fill="#444">${esc(dims)}</text>`);
            if (hpx >= 62) out.push(`<text x="${f(cx)}" y="${f(cy + 8 + Math.max(9, fs))}" font-size="${f(Math.max(7, fs - 3))}" text-anchor="middle" fill="#777">${esc(area)}</text>`);
        }
    }

    // Overall dimension lines
    const dimY = Y(minY) - 28, dimX = X(minX) - 30;
    out.push(`<g stroke="#555" stroke-width="1" fill="none"><line x1="${f(X(minX))}" y1="${f(dimY)}" x2="${f(X(maxX))}" y2="${f(dimY)}"/><line x1="${f(X(minX))}" y1="${f(dimY - 5)}" x2="${f(X(minX))}" y2="${f(dimY + 5)}"/><line x1="${f(X(maxX))}" y1="${f(dimY - 5)}" x2="${f(X(maxX))}" y2="${f(dimY + 5)}"/>`);
    out.push(`<line x1="${f(dimX)}" y1="${f(Y(minY))}" x2="${f(dimX)}" y2="${f(Y(maxY))}"/><line x1="${f(dimX - 5)}" y1="${f(Y(minY))}" x2="${f(dimX + 5)}" y2="${f(Y(minY))}"/><line x1="${f(dimX - 5)}" y1="${f(Y(maxY))}" x2="${f(dimX + 5)}" y2="${f(Y(maxY))}"/></g>`);
    out.push(`<text x="${f((X(minX) + X(maxX)) / 2)}" y="${f(dimY - 7)}" font-size="12" text-anchor="middle" fill="#444">${metres(maxX - minX)} m</text>`);
    out.push(`<text transform="translate(${f(dimX - 8)} ${f((Y(minY) + Y(maxY)) / 2)}) rotate(-90)" font-size="12" text-anchor="middle" fill="#444">${metres(maxY - minY)} m</text>`);

    // Scale bar (1, 2, 5 or 10 m — whichever is closest to ~120 px)
    const choices = [1, 2, 5, 10, 20];
    const bar = choices.reduce((best, c) => Math.abs(c * S - 120) < Math.abs(best * S - 120) ? c : best, choices[0]);
    const bx = padL, by = height - 44;
    out.push(`<g stroke="${INK}" stroke-width="2"><line x1="${bx}" y1="${by}" x2="${f(bx + bar * S)}" y2="${by}"/><line x1="${bx}" y1="${by - 5}" x2="${bx}" y2="${by + 5}"/><line x1="${f(bx + bar * S)}" y1="${by - 5}" x2="${f(bx + bar * S)}" y2="${by + 5}"/></g>`);
    out.push(`<text x="${f(bx + (bar * S) / 2)}" y="${by + 20}" font-size="12" text-anchor="middle" fill="#444">${bar} m</text>`);

    // North arrow (plan north is up)
    const nx = width - 48, ny = 44;
    out.push(`<g><circle cx="${nx}" cy="${ny}" r="22" fill="none" stroke="${INK}" stroke-width="1.5"/><polygon points="${nx},${ny - 17} ${nx - 7},${ny + 9} ${nx},${ny + 4} ${nx + 7},${ny + 9}" fill="${INK}"/><text x="${nx}" y="${ny - 27}" font-size="12" font-weight="700" text-anchor="middle" fill="${INK}">N</text></g>`);

    out.push(`<text x="${width - padR + 20}" y="${height - 20}" font-size="10" text-anchor="end" fill="#999">Concept sketch — not for construction</text>`);
    out.push('</svg>');
    return out.join('\n');
}
