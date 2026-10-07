// Floor-plan spec: parsing, geometry and validation. Pure (no vscode import).
//
// The model proposes rooms/doors/windows as structured data; this module checks
// the design the way a reviewer would (can you walk to every room? does every
// bedroom have a window? are the rooms big enough?) and the renderer then draws
// it deterministically, so labels and dimensions are computed, never typed by
// the model. Internally everything is integer millimetres to avoid float drift
// when comparing wall coordinates.

import {
    rulesFor, roomTypesFor, canonicalRoomType, PACKS, DEFAULT_BUILDING_TYPE, DOOR, WINDOW, COVERAGE_GAP_WARN
} from './reference';

export type Side = 'N' | 'E' | 'S' | 'W';
export type DoorKind = 'swing' | 'open' | 'sliding' | 'vehicle';
export const EXTERIOR = 'exterior';

export interface Room { id: string; name: string; type: string; x1: number; y1: number; x2: number; y2: number; }
export interface DoorSpec { from: string; to: string; side?: Side; at: number; width: number; kind: DoorKind; }
export interface WindowSpec { room: string; side: Side; at: number; width: number; }
export interface Brief { buildingType: string; bedrooms?: number; hemisphere?: 'south' | 'north'; }
export interface Plan { brief: Brief; rooms: Room[]; doors: DoorSpec[]; windows: WindowSpec[]; layoutNotes?: string[]; }

/** A door/window resolved onto an actual wall. Coordinates in mm. */
export interface PlacedOpening {
    orient: 'H' | 'V';      // H = lies along a horizontal wall (constant y)
    fixed: number;          // the wall's constant coordinate
    center: number;         // centre along the wall
    width: number;
    side: Side;             // which side of `room` it is on
    room: string;           // the room whose wall it is on (for exterior doors / windows / the 'from' room of interior doors)
    other?: string;         // the room on the far side, for interior doors
    kind?: DoorKind;
    door?: DoorSpec;
}

export interface Validation {
    errors: string[];
    warnings: string[];
    notes: string[];
    areas: { id: string; name: string; type: string; w: number; h: number; area: number }[];
    internalArea: number;
    doors: PlacedOpening[];
    windows: PlacedOpening[];
}

const SIDES: Side[] = ['N', 'E', 'S', 'W'];
const mm = (m: number) => Math.round(m * 1000);
const m2 = (a: number) => a / 1e6;
const fmt = (v: number) => (v / 1000).toFixed(2).replace(/\.?0+$/, '') ;
const an = (word: string) => (/^[aeiou]/i.test(word.trim()) ? 'an' : 'a');
const num = (v: unknown): number | undefined => {
    const n = typeof v === 'string' ? Number(v) : v;
    return typeof n === 'number' && Number.isFinite(n) ? n : undefined;
};

// ── Layout trees ─────────────────────────────────────────────────────────────
// The model is far better at describing a layout as nested rows and columns with sizes than at
// placing rectangles at exact coordinates (overlaps, gaps and walls that don't quite meet were the
// main failure). A layout is a tree: a container is { items: [...] } whose direction alternates
// with its parent (the root stacks rows top-to-bottom; a row runs left-to-right; a column inside a
// row stacks top-to-bottom, and so on) and a leaf is a room { id, name, type } with optional w/h.
// Sizes along a container's own axis are given per item; unsized items share what is left. The
// code turns this into x/y/w/h, so neighbouring rooms line up exactly by construction.

interface LNode { id?: string; name?: string; type?: string; w?: number; h?: number; dir?: 'row' | 'col'; items?: LNode[]; [k: string]: unknown }

export function flattenLayout(layout: unknown, errors: string[], notes: string[]): Record<string, unknown>[] | undefined {
    if (!layout || typeof layout !== 'object') { errors.push('layout must be an object like { "items": [ { "h": 4, "items": [ …rooms… ] } ] }.'); return undefined; }
    const root = layout as LNode;
    const isContainer = (n: LNode) => Array.isArray(n.items);
    const given = (n: LNode, axis: 'w' | 'h'): number | undefined => { const v = num(n[axis]); return v !== undefined && v > 0 ? mm(v) : undefined; };

    // natural size along an axis, if every needed size was stated
    const natural = (n: LNode, axis: 'w' | 'h', dir: 'row' | 'col'): number | undefined => {
        const g = given(n, axis);
        if (g !== undefined) return g;
        if (!isContainer(n)) return undefined;
        const d = n.dir ?? (dir === 'row' ? 'col' : 'row');
        const sizes = n.items!.map(c => natural(c, axis, d));
        if (sizes.some(s => s === undefined)) return undefined;
        const alongAxis = (axis === 'w') === (d === 'row'); // does this container lay its items out along this axis?
        const known = sizes as number[];
        return alongAxis ? known.reduce((acc, v) => acc + v, 0) : Math.max(...known);
    };

    const rooms: Record<string, unknown>[] = [];
    const ids = new Set<string>();
    // ids already taken by explicit ids, so a derived id never collides with one the model wrote
    const used = new Set<string>();
    const collectIds = (n: LNode): void => { if (isContainer(n)) n.items!.forEach(collectIds); else if (n.id) used.add(String(n.id).trim()); };
    collectIds(root);
    const place = (n: LNode, x: number, y: number, W: number, H: number, parentDir: 'row' | 'col', path: string) => {
        if (!isContainer(n)) {
            let id = String(n.id ?? '').trim();
            if (!id) {
                // Forgetting the id is a common slip and the name says what the room is — derive one.
                const base = String(n.name ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24);
                if (!base) { errors.push(`layout item at ${path} needs a "name" or an "id" (or "items" if it is a row/column).`); return; }
                id = base;
                for (let k = 2; used.has(id); k++) id = `${base}-${k}`;
                notes.push(`Room "${String(n.name)}" had no id, so "${id}" was used — refer to it by that id in doors and windows.`);
            }
            used.add(id);
            rooms.push({ id, name: n.name, type: n.type, x: x / 1000, y: y / 1000, w: W / 1000, h: H / 1000 });
            return;
        }
        const dir = n.dir ?? (parentDir === 'row' ? 'col' : 'row');
        const items = n.items!;
        if (!items.length) { errors.push(`layout container at ${path} has no items.`); return; }
        const axis: 'w' | 'h' = dir === 'row' ? 'w' : 'h';
        const total = dir === 'row' ? W : H;
        const wanted = items.map(c => given(c, axis));
        const sumGiven = wanted.reduce((a: number, b) => a + (b ?? 0), 0);
        const unsized = wanted.filter(v => v === undefined).length;
        let sizes: number[];
        if (unsized > 0) {
            const share = Math.floor((total - sumGiven) / unsized);
            if (share <= 0) { errors.push(`layout at ${path}: the stated ${axis === 'w' ? 'widths' : 'heights'} (${fmt(sumGiven)} m) leave no room for the unsized items in ${fmt(total)} m.`); return; }
            sizes = wanted.map(v => v ?? share);
        } else {
            sizes = wanted as number[];
            if (sumGiven > total + 1) { errors.push(`layout at ${path}: ${axis === 'w' ? 'widths' : 'heights'} add up to ${fmt(sumGiven)} m but only ${fmt(total)} m is available.`); return; }
        }
        // absorb rounding / a small shortfall in the last item so the row meets its neighbour exactly
        const sum = sizes.reduce((a, b) => a + b, 0);
        if (sum < total) {
            if (total - sum > 100) notes.push(`Layout at ${path}: ${axis === 'w' ? 'widths' : 'heights'} added up to ${fmt(sum)} m of ${fmt(total)} m, so the last item was stretched to fill it.`);
            sizes[sizes.length - 1] += total - sum;
        }
        let cursor = dir === 'row' ? x : y;
        items.forEach((c, i) => {
            const label = `${path}/${c.id ?? c.name ?? i}`;
            if (dir === 'row') { place(c, cursor, y, sizes[i], H, dir, label); cursor += sizes[i]; }
            else { place(c, x, cursor, W, sizes[i], dir, label); cursor += sizes[i]; }
        });
    };

    const rootDir: 'row' | 'col' = root.dir ?? 'col';
    const W = given(root, 'w') ?? natural(root, 'w', rootDir === 'row' ? 'col' : 'row');
    const H = given(root, 'h') ?? natural(root, 'h', rootDir === 'row' ? 'col' : 'row');
    if (W === undefined || H === undefined) {
        errors.push('layout needs its overall size: add "w" and "h" (metres) on the layout, or give every row a "h" and every room in it a "w".');
        return undefined;
    }
    place({ ...root, dir: rootDir }, 0, 0, W, H, rootDir === 'row' ? 'col' : 'row', 'layout');
    for (const r of rooms) { const id = String(r.id); if (ids.has(id)) errors.push(`duplicate room id "${id}" in layout.`); ids.add(id); }
    return errors.length ? undefined : rooms;
}

// ── Parsing ──────────────────────────────────────────────────────────────────

export function parsePlan(input: unknown): { plan?: Plan; errors: string[] } {
    const errors: string[] = [];
    let raw: any = input;
    if (typeof raw === 'string') {
        try { raw = JSON.parse(raw); } catch { return { errors: ['spec is not valid JSON.'] }; }
    }
    if (!raw || typeof raw !== 'object') return { errors: ['spec must be an object with a "rooms" array.'] };
    const layoutNotes: string[] = [];
    if (raw.layout !== undefined) {
        if (Array.isArray(raw.rooms) && raw.rooms.length) return { errors: ['Give either "layout" or "rooms", not both.'] };
        const layoutErrors: string[] = [];
        const flat = flattenLayout(raw.layout, layoutErrors, layoutNotes);
        if (!flat) return { errors: layoutErrors.length ? layoutErrors : ['layout produced no rooms.'] };
        raw = { ...raw, rooms: flat };
    }
    if (!Array.isArray(raw.rooms) || raw.rooms.length === 0) return { errors: ['spec needs "layout" (rows/columns with sizes — recommended) or a non-empty "rooms" array.'] };
    if (raw.rooms.length > 60) return { errors: ['spec.rooms has more than 60 rooms — simplify.'] };

    const buildingType = String(raw.brief?.buildingType ?? DEFAULT_BUILDING_TYPE).toLowerCase();
    if (!PACKS[buildingType]) return { errors: [`brief.buildingType "${buildingType}" is not supported. Use one of: ${Object.keys(PACKS).join(', ')}.`] };
    const rules = rulesFor(buildingType);
    const validTypes = roomTypesFor(buildingType);

    const rooms: Room[] = [];
    const typeNotes: string[] = [];
    const seen = new Set<string>();
    raw.rooms.forEach((r: any, i: number) => {
        const id = String(r?.id ?? '').trim();
        const label = id || `rooms[${i}]`;
        if (!id) { errors.push(`rooms[${i}] needs an "id".`); return; }
        if (id === EXTERIOR) { errors.push(`room id "${EXTERIOR}" is reserved.`); return; }
        if (seen.has(id)) { errors.push(`duplicate room id "${id}".`); return; }
        seen.add(id);
        let type = String(r?.type ?? 'other');
        const canon = validTypes.includes(type) ? type : canonicalRoomType(buildingType, type);
        if (canon && canon !== type) { typeNotes.push(`Room type "${type}" for "${label}" was read as "${canon}".`); type = canon; }
        if (!validTypes.includes(type)) { errors.push(`room "${label}" has type "${type}", which is not a ${buildingType} room type. Valid: ${validTypes.join(', ')}.`); return; }
        const x = num(r.x), y = num(r.y), w = num(r.w), h = num(r.h);
        if (x === undefined || y === undefined || w === undefined || h === undefined) {
            errors.push(`room "${label}" needs numeric x, y, w, h (metres).`); return;
        }
        if (w <= 0 || h <= 0) { errors.push(`room "${label}" must have positive w and h.`); return; }
        rooms.push({ id, name: String(r.name ?? rules[type].label).slice(0, 40), type, x1: mm(x), y1: mm(y), x2: mm(x + w), y2: mm(y + h) });
    });

    const ids = new Set(rooms.map(r => r.id));
    const doors: DoorSpec[] = [];
    (Array.isArray(raw.doors) ? raw.doors : []).forEach((d: any, i: number) => {
        const from = String(d?.from ?? ''), to = String(d?.to ?? '');
        const ok = (id: string) => id === EXTERIOR || ids.has(id);
        if (!ok(from) || !ok(to)) { errors.push(`doors[${i}] refers to an unknown room ("${from}" → "${to}").`); return; }
        if (from === to) { errors.push(`doors[${i}] connects "${from}" to itself.`); return; }
        if (from === EXTERIOR && to === EXTERIOR) { errors.push(`doors[${i}] connects exterior to exterior.`); return; }
        const kind: DoorKind = ['swing', 'open', 'sliding', 'vehicle'].includes(d?.kind) ? d.kind : 'swing';
        const isExt = from === EXTERIOR || to === EXTERIOR;
        const side = typeof d?.side === 'string' ? d.side.toUpperCase() as Side : undefined;
        if (isExt && (!side || !SIDES.includes(side))) { errors.push(`doors[${i}] ("${from}" → "${to}") is an exterior door and needs "side": N, E, S or W.`); return; }
        const at = Math.min(1, Math.max(0, num(d?.at) ?? 0.5));
        const defaultW = kind === 'vehicle' ? DOOR.defaultGarageVehicle : kind === 'open' ? 1.2 : isExt ? DOOR.defaultEntry : DOOR.defaultInterior;
        const width = mm(num(d?.width) ?? defaultW);
        doors.push({ from, to, side: isExt ? side : undefined, at, width, kind });
    });

    const windows: WindowSpec[] = [];
    (Array.isArray(raw.windows) ? raw.windows : []).forEach((w: any, i: number) => {
        const room = String(w?.room ?? '');
        const side = typeof w?.side === 'string' ? w.side.toUpperCase() as Side : undefined;
        if (!ids.has(room)) { errors.push(`windows[${i}] refers to unknown room "${room}".`); return; }
        if (!side || !SIDES.includes(side)) { errors.push(`windows[${i}] (room "${room}") needs "side": N, E, S or W.`); return; }
        windows.push({ room, side, at: Math.min(1, Math.max(0, num(w?.at) ?? 0.5)), width: mm(num(w?.width) ?? WINDOW.defaultWidth) });
    });

    const brief: Brief = { buildingType };
    const bd = num(raw.brief?.bedrooms);
    if (bd !== undefined) brief.bedrooms = Math.round(bd);
    if (raw.brief?.hemisphere === 'south' || raw.brief?.hemisphere === 'north') brief.hemisphere = raw.brief.hemisphere;

    return errors.length ? { errors } : { plan: { brief, rooms, doors, windows, layoutNotes: [...layoutNotes, ...typeNotes] }, errors };
}

// ── Geometry ────────────────────────────────────────────────────────────────

type Interval = [number, number];

function sideLine(r: Room, side: Side): { orient: 'H' | 'V'; fixed: number; a: number; b: number } {
    switch (side) {
        case 'N': return { orient: 'H', fixed: r.y1, a: r.x1, b: r.x2 };
        case 'S': return { orient: 'H', fixed: r.y2, a: r.x1, b: r.x2 };
        case 'W': return { orient: 'V', fixed: r.x1, a: r.y1, b: r.y2 };
        case 'E': return { orient: 'V', fixed: r.x2, a: r.y1, b: r.y2 };
    }
}

function subtract(base: Interval, cuts: Interval[]): Interval[] {
    let out: Interval[] = [base];
    for (const [ca, cb] of cuts) {
        const next: Interval[] = [];
        for (const [a, b] of out) {
            if (cb <= a || ca >= b) { next.push([a, b]); continue; }
            if (ca > a) next.push([a, ca]);
            if (cb < b) next.push([cb, b]);
        }
        out = next;
    }
    return out.filter(([a, b]) => b - a > 1);
}

/** Parts of one side of a room not backed by another room — i.e. the true exterior wall. */
export function exteriorIntervals(r: Room, side: Side, rooms: Room[]): Interval[] {
    const L = sideLine(r, side);
    const cuts: Interval[] = [];
    for (const o of rooms) {
        if (o.id === r.id) continue;
        const opp: Side = side === 'N' ? 'S' : side === 'S' ? 'N' : side === 'E' ? 'W' : 'E';
        const O = sideLine(o, opp);
        if (O.orient !== L.orient || O.fixed !== L.fixed) continue;
        const a = Math.max(L.a, O.a), b = Math.min(L.b, O.b);
        if (b > a) cuts.push([a, b]);
    }
    return subtract([L.a, L.b], cuts);
}

export interface ExteriorSpot { side: Side; a: number; b: number; moved: boolean }

/**
 * Finds an exterior stretch of wall at least `need` mm long (plus margins) on a room. The requested
 * side wins if it has one; otherwise the longest stretch on any other exterior side is used. Working
 * out which sides of a room are outside walls is geometry the model is slow and unreliable at, so the
 * code does it and reports the move.
 */
export function findExteriorSpot(room: Room, preferred: Side | undefined, need: number, margin: number, rooms: Room[]): ExteriorSpot | undefined {
    const order: Side[] = preferred ? [preferred, ...SIDES.filter(s => s !== preferred)] : [...SIDES];
    let best: { score: number; spot: ExteriorSpot } | undefined;
    order.forEach((side, rank) => {
        for (const [a, b] of exteriorIntervals(room, side, rooms)) {
            if (b - a < need + 2 * margin) continue;
            const score = (rank === 0 && preferred ? 1e9 : 0) + (b - a);
            if (!best || score > best.score) best = { score, spot: { side, a, b, moved: !!preferred && side !== preferred } };
        }
    });
    return best?.spot;
}

/** Exterior sides of a room with their longest outside stretch, for error messages. */
export function describeExteriorSides(room: Room, rooms: Room[]): string {
    const parts = SIDES.map(side => ({ side, len: Math.max(0, ...exteriorIntervals(room, side, rooms).map(([a, b]) => b - a)) })).filter(s => s.len > 0);
    return parts.length ? parts.map(s => `${s.side} (${fmt(s.len)} m)`).join(', ') : 'none — it is enclosed by other rooms';
}

/** The wall segment two rooms share, plus which side of A it is on. */
export function sharedWall(A: Room, B: Room): { orient: 'H' | 'V'; fixed: number; a: number; b: number; sideOfA: Side } | null {
    const hit = (side: Side, opp: Side) => {
        const LA = sideLine(A, side), LB = sideLine(B, opp);
        if (LA.fixed !== LB.fixed) return null;
        const a = Math.max(LA.a, LB.a), b = Math.min(LA.b, LB.b);
        return b > a ? { orient: LA.orient, fixed: LA.fixed, a, b, sideOfA: side } : null;
    };
    return hit('E', 'W') || hit('W', 'E') || hit('S', 'N') || hit('N', 'S');
}

function overlapArea(A: Room, B: Room): number {
    const w = Math.min(A.x2, B.x2) - Math.max(A.x1, B.x1);
    const h = Math.min(A.y2, B.y2) - Math.max(A.y1, B.y1);
    return w > 0 && h > 0 ? w * h : 0;
}

function placeAlong(a: number, b: number, width: number, margin: number, at: number): number {
    const free = Math.max(0, (b - a) - width - 2 * margin);
    return a + margin + width / 2 + free * at;
}

// ── Validation ───────────────────────────────────────────────────────────────

export function validatePlan(plan: Plan): Validation {
    const errors: string[] = [];
    const warnings: string[] = [];
    const notes: string[] = [...(plan.layoutNotes ?? [])];
    const byId = new Map(plan.rooms.map(r => [r.id, r]));
    const name = (id: string) => byId.get(id)?.name ?? id;
    const rules = rulesFor(plan.brief.buildingType);
    const pack = PACKS[plan.brief.buildingType] ?? PACKS[DEFAULT_BUILDING_TYPE];
    const rule = (r: Room) => rules[r.type] ?? rules.other;

    // Overlaps
    const overlaps: string[] = [];
    for (let i = 0; i < plan.rooms.length; i++) {
        for (let j = i + 1; j < plan.rooms.length; j++) {
            const a = overlapArea(plan.rooms[i], plan.rooms[j]);
            if (a > 0.01 * 1e6) { const A = plan.rooms[i], B = plan.rooms[j]; overlaps.push(`"${A.name}" (x ${fmt(A.x1)}–${fmt(A.x2)}, y ${fmt(A.y1)}–${fmt(A.y2)}) and "${B.name}" (x ${fmt(B.x1)}–${fmt(B.x2)}, y ${fmt(B.y1)}–${fmt(B.y2)}) overlap by ${m2(a).toFixed(1)} m²`); }
        }
    }
    if (overlaps.length) errors.push(`Rooms overlap: ${overlaps.slice(0, 5).join('; ')}${overlaps.length > 5 ? '…' : ''}. Adjacent rooms must share an edge, not intersect.`);

    // Sizes
    const areas = plan.rooms.map(r => {
        const w = r.x2 - r.x1, h = r.y2 - r.y1;
        return { id: r.id, name: r.name, type: r.type, w, h, area: m2(w * h) };
    });
    for (const r of plan.rooms) {
        const k = rule(r);
        if (k.outdoor) continue;
        const w = r.x2 - r.x1, h = r.y2 - r.y1, area = m2(w * h), dim = Math.min(w, h) / 1000;
        const tag = `${r.name} (${fmt(w)} × ${fmt(h)} m, ${area.toFixed(1)} m²)`;
        if ((k.hardArea && area < k.hardArea) || (k.hardDim && dim < k.hardDim)) {
            errors.push(`${tag} is too small for ${an(k.label)} ${k.label.toLowerCase()} — minimum about ${k.hardArea} m² and ${k.hardDim} m wide.`);
        } else if ((k.softArea && area < k.softArea) || (k.softDim && dim < k.softDim)) {
            warnings.push(`${tag} is cramped for ${an(k.label)} ${k.label.toLowerCase()} — aim for ${k.softArea}+ m² and ${k.softDim}+ m wide.`);
        } else if (k.hardMax && area > k.hardMax) {
            errors.push(`${tag} is far too large for ${an(k.label)} ${k.label.toLowerCase()} — about ${k.softMax} m² is generous. Shrink it and give the space to a neighbouring room (or make it a different room type).`);
        } else if (k.softMax && area > k.softMax) {
            warnings.push(`${tag} is oversized for ${an(k.label)} ${k.label.toLowerCase()} — about ${k.softMax} m² is generous; consider giving some of that space to a neighbouring room.`);
        }
    }

    // Footprint coverage
    const indoor = plan.rooms.filter(r => !rule(r).outdoor);
    const internalArea = indoor.reduce((s, r) => s + m2((r.x2 - r.x1) * (r.y2 - r.y1)), 0);
    if (plan.rooms.length) {
        const bx1 = Math.min(...plan.rooms.map(r => r.x1)), by1 = Math.min(...plan.rooms.map(r => r.y1));
        const bx2 = Math.max(...plan.rooms.map(r => r.x2)), by2 = Math.max(...plan.rooms.map(r => r.y2));
        const box = m2((bx2 - bx1) * (by2 - by1));
        const covered = plan.rooms.reduce((s, r) => s + m2((r.x2 - r.x1) * (r.y2 - r.y1)), 0);
        const gap = box > 0 ? 1 - covered / box : 0;
        if (!overlaps.length && gap > COVERAGE_GAP_WARN) {
            warnings.push(`About ${(gap * 100).toFixed(0)}% of the ${fmt(bx2 - bx1)} × ${fmt(by2 - by1)} m footprint is not assigned to any room — add a room, an outdoor space, or tighten the layout so walls meet.`);
        }
    }

    // ── Who can reach whom ────────────────────────────────────────────────────
    const computeReach = (specs: DoorSpec[]) => {
        const nodeDoors = new Map<string, Set<string>>();
        const link = (x: string, y: string) => { (nodeDoors.get(x) ?? nodeDoors.set(x, new Set()).get(x)!).add(y); };
        for (const d of specs) { link(d.from, d.to); link(d.to, d.from); }
        const entryDoors = specs.filter(d => (d.from === EXTERIOR || d.to === EXTERIOR) && d.kind !== 'vehicle');
        const reached = new Set<string>();
        const queue: string[] = [];
        for (const d of entryDoors) {
            const id = d.from === EXTERIOR ? d.to : d.from;
            if (reached.has(id)) continue;
            reached.add(id);
            if (rule(byId.get(id)!).transit || rule(byId.get(id)!).outdoor) queue.push(id);
        }
        while (queue.length) {
            const cur = queue.shift()!;
            for (const n of nodeDoors.get(cur) ?? []) {
                if (n === EXTERIOR || reached.has(n)) continue;
                reached.add(n);
                const k = rule(byId.get(n)!);
                if (k.transit || k.outdoor) queue.push(n);
            }
        }
        // dependent rooms (ensuite, robe, pantry, storage) hang off a reached room
        let grew = true;
        while (grew) {
            grew = false;
            for (const r of plan.rooms) {
                if (reached.has(r.id) || !rule(r).dependent) continue;
                if ([...(nodeDoors.get(r.id) ?? [])].some(n => reached.has(n))) { reached.add(r.id); grew = true; }
            }
        }
        return { nodeDoors, entryDoors, reached };
    };

    // Doors the model asked for between rooms that do not touch cannot be drawn. Dropping them (and saying
    // so) is better than failing the plan: the connectivity repair below, or the reachability check after
    // it, deals with any room that ends up cut off.
    const touchingNames = (r: Room) => plan.rooms.filter(o => o.id !== r.id && sharedWall(r, o)).map(o => o.name);
    const doorSpecs: DoorSpec[] = [];
    for (const d of plan.doors) {
        if (d.from !== EXTERIOR && d.to !== EXTERIOR) {
            const A = byId.get(d.from)!, B = byId.get(d.to)!;
            if (!sharedWall(A, B)) {
                notes.push(`The door ${A.name} → ${B.name} was ignored because those rooms do not share a wall (${A.name} touches: ${touchingNames(A).join(', ') || 'nothing'}; ${B.name} touches: ${touchingNames(B).join(', ') || 'nothing'}).`);
                continue;
            }
        }
        doorSpecs.push(d);
    }

    // A room with no usable way in is the most common layout slip, and the fix is mechanical: put a door
    // between it and the best already-reachable room it touches (circulation first, then the longest
    // shared wall). Say so, rather than failing the plan and costing a model round trip.
    {
        const minWall = mm(DOOR.defaultInterior) + 2 * DOOR.wallMargin * 1000;
        for (let guard = 0; guard < plan.rooms.length + 2; guard++) {
            const { reached, entryDoors } = computeReach(doorSpecs);
            if (!entryDoors.length) break; // no front door: nothing to connect to (reported below)
            let added = false;
            for (const r of plan.rooms) {
                const k = rule(r);
                if (reached.has(r.id) || k.outdoor) continue;
                const cands = plan.rooms
                    .filter(n => n.id !== r.id && reached.has(n.id))
                    .filter(n => k.dependent && (r.type === 'ensuite' || r.type === 'robe') ? (n.type === 'bedroom' || n.type === 'master_bedroom') : (rule(n).transit || rule(n).outdoor || !!k.dependent))
                    .map(n => ({ n, sw: sharedWall(r, n) }))
                    .filter(c => c.sw && c.sw.b - c.sw.a >= minWall)
                    .map(c => ({ n: c.n, score: (rule(c.n).circulation ? 1e7 : 0) + (c.sw!.b - c.sw!.a) }))
                    .sort((a, b) => b.score - a.score);
                if (!cands.length) continue;
                doorSpecs.push({ from: cands[0].n.id, to: r.id, at: 0.5, width: mm(DOOR.defaultInterior), kind: 'swing' });
                notes.push(`${r.name} had no usable way in, so a door was added from ${cands[0].n.name}. Add your own door if you want it elsewhere.`);
                added = true;
                break;
            }
            if (!added) break;
        }
    }

    // Resolve doors onto walls
    const doors: PlacedOpening[] = [];
    const clashes = (orient: 'H' | 'V', fixed: number, center: number, width: number, others: PlacedOpening[]) =>
        others.some(p => p.orient === orient && p.fixed === fixed && Math.abs(p.center - center) < (p.width + width) / 2);
    const AT_TRIES = [0.5, 0.25, 0.75, 0.15, 0.85];
    doorSpecs.forEach((d, i) => {
        const label = `Door ${name(d.from)} → ${name(d.to)}`;
        if (d.from === EXTERIOR || d.to === EXTERIOR) {
            const room = byId.get(d.from === EXTERIOR ? d.to : d.from)!;
            const spot = findExteriorSpot(room, d.side, d.width, DOOR.wallMargin * 1000, plan.rooms);
            if (!spot) { errors.push(`${label}: ${room.name} has no outside wall long enough for a ${fmt(d.width)} m door. Its exterior sides: ${describeExteriorSides(room, plan.rooms)}.`); return; }
            if (spot.moved) notes.push(`${label}: the ${d.side} side of ${room.name} is not an outside wall, so the door was placed on its ${spot.side} side instead.`);
            const L = sideLine(room, spot.side);
            const centers = [d.at, ...AT_TRIES].map(at => placeAlong(spot.a, spot.b, d.width, DOOR.wallMargin * 1000, at));
            const center = centers.find(c => !clashes(L.orient, L.fixed, c, d.width, doors)) ?? centers[0];
            doors.push({ orient: L.orient, fixed: L.fixed, center, width: d.width, side: spot.side, room: room.id, kind: d.kind, door: d });
            return;
        }
        const A = byId.get(d.from)!, B = byId.get(d.to)!;
        const sw = sharedWall(A, B);
        if (!sw) return; // filtered out above; defensive
        if (sw.b - sw.a < d.width + 2 * DOOR.wallMargin * 1000) {
            const fits = sw.b - sw.a - 2 * DOOR.wallMargin * 1000;
            if (fits < DOOR.minWidth * 1000) {
                errors.push(`${label}: the shared wall is only ${fmt(sw.b - sw.a)} m long — too short for even a ${fmt(DOOR.minWidth * 1000)} m door with margins. Make the rooms share a longer wall.`);
                return;
            }
            notes.push(`${label}: the shared wall is only ${fmt(sw.b - sw.a)} m, so the door was narrowed from ${fmt(d.width)} m to ${fmt(fits)} m.`);
            d = { ...d, width: fits };
        }
        const centers = [d.at, ...AT_TRIES].map(at => placeAlong(sw.a, sw.b, d.width, DOOR.wallMargin * 1000, at));
        const center = centers.find(c => !clashes(sw.orient, sw.fixed, c, d.width, doors)) ?? centers[0];
        doors.push({ orient: sw.orient, fixed: sw.fixed, center, width: d.width, side: sw.sideOfA, room: A.id, other: B.id, kind: d.kind, door: d });
        void i;
    });
    // Doors overlapping each other on one wall
    for (let i = 0; i < doors.length; i++) for (let j = i + 1; j < doors.length; j++) {
        const p = doors[i], q = doors[j];
        if (p.orient === q.orient && p.fixed === q.fixed && Math.abs(p.center - q.center) < (p.width + q.width) / 2) {
            errors.push(`Two doors overlap on the same wall (${name(p.room)} / ${name(p.other ?? q.room)}). Give them different "at" values or different walls.`);
        }
    }

    // Resolve windows onto exterior walls
    const windows: PlacedOpening[] = [];
    plan.windows.forEach(w => {
        const room = byId.get(w.room)!;
        const margin = WINDOW.sideMargin * 1000;
        const spot = findExteriorSpot(room, w.side, WINDOW.minWidth * 1000, margin, plan.rooms);
        if (!spot) { errors.push(`Window in ${room.name}: the room has no outside wall to put it on. Its exterior sides: ${describeExteriorSides(room, plan.rooms)}.`); return; }
        if (spot.moved) notes.push(`The ${w.side} side of ${room.name} is not an outside wall, so its window was placed on the ${spot.side} side instead.`);
        const width = Math.min(w.width, spot.b - spot.a - 2 * margin);
        const L = sideLine(room, spot.side);
        const centers = [w.at, ...AT_TRIES].map(at => placeAlong(spot.a, spot.b, width, margin, at));
        const center = centers.find(c => !clashes(L.orient, L.fixed, c, width, doors) && !clashes(L.orient, L.fixed, c, width, windows));
        if (center === undefined) { notes.push(`A window in ${room.name} (${spot.side} side) was dropped because that wall has no free space for it next to a door.`); return; }
        windows.push({ orient: L.orient, fixed: L.fixed, center, width, side: spot.side, room: room.id });
    });

    // Reachability (after the automatic door repair above)
    const { nodeDoors, entryDoors, reached } = computeReach(doorSpecs);
    if (!entryDoors.length) {
        const entrance = plan.rooms.filter(r => ['entry', 'hall', 'corridor', 'living', 'family', 'reception', 'lobby', 'foyer', 'waiting', 'shopfloor', 'dining_hall'].includes(r.type))
            .map(r => `${r.name} (exterior sides: ${describeExteriorSides(r, plan.rooms)})`);
        errors.push('There is no front door. Add { "from": "exterior", "to": <room id>, "side": N|E|S|W } on a room with an outside wall' + (entrance.length ? ': ' + entrance.join('; ') : '') + '.');
    }
    for (const r of plan.rooms) {
        if (reached.has(r.id) || !entryDoors.length) continue;
        const hasDoor = (nodeDoors.get(r.id)?.size ?? 0) > 0;
        const msg = !hasDoor
            ? `${r.name} has no door — add one from the room it should open from.`
            : `${r.name} can only be reached by walking through a bedroom, bathroom or other private room (or is cut off). It touches: ${touchingNames(r).join(', ') || 'nothing'}. Move it so it touches the hall, entry or living area, or move a hall next to it.`;
        if (r.type === 'garage') warnings.push(`${r.name} is not connected to the house by a door.`);
        else errors.push(msg);
    }
    for (const r of plan.rooms) {
        if ((r.type === 'ensuite') && ![...(nodeDoors.get(r.id) ?? [])].some(n => { const t = byId.get(n)?.type; return t === 'bedroom' || t === 'master_bedroom'; })) {
            warnings.push(`${r.name} (ensuite) does not open to a bedroom.`);
        }
    }

    // A habitable room with no window is the most common slip and always the same fix, so make
    // it ourselves (and say so) rather than rejecting the plan and costing a model round trip.
    // Only a room with no exterior wall at all is left as an error below.
    const sunSide: Side | undefined = plan.brief.hemisphere === 'south' ? 'N' : plan.brief.hemisphere === 'north' ? 'S' : undefined;
    const autoWindow = (r: Room): { opening: PlacedOpening; side: Side } | undefined => {
        const margin = WINDOW.sideMargin * 1000;
        const area = m2((r.x2 - r.x1) * (r.y2 - r.y1));
        const want = Math.min(2400, Math.max(1200, Math.round((area * WINDOW.lightRatio / 1.2) * 1000 / 100) * 100));
        let best: { score: number; side: Side; opening: PlacedOpening } | undefined;
        for (const side of SIDES) {
            for (const [a, b] of exteriorIntervals(r, side, plan.rooms)) {
                if (b - a < WINDOW.minWidth * 1000 + 2 * margin) continue;
                const L = sideLine(r, side);
                const width = Math.min(want, b - a - 2 * margin);
                for (const at of [0.5, 0.25, 0.75]) {
                    const center = placeAlong(a, b, width, margin, at);
                    if (doors.some(d => d.orient === L.orient && d.fixed === L.fixed && Math.abs(d.center - center) < (d.width + width) / 2)) continue;
                    const score = width + (side === sunSide ? 1e6 : 0);
                    if (!best || score > best.score) best = { score, side, opening: { orient: L.orient, fixed: L.fixed, center, width, side, room: r.id } };
                    break;
                }
            }
        }
        return best;
    };
    for (const r of plan.rooms) {
        if (!rule(r).habitable) continue;
        const hasWindow = windows.some(w => w.room === r.id) || doors.some(d => d.room === r.id && !d.other && d.kind !== 'vehicle');
        if (hasWindow) continue;
        const added = autoWindow(r);
        if (added) {
            windows.push(added.opening);
            notes.push(`${r.name} had no window, so a ${(added.opening.width / 1000).toFixed(1)} m window was added on its ${added.side} side. Specify one yourself if you want a different position.`);
        }
    }

    // Windows & light
    const winWidth = new Map<string, number>();
    for (const w of windows) winWidth.set(w.room, (winWidth.get(w.room) ?? 0) + w.width);
    for (const r of plan.rooms) {
        const k = rule(r), area = m2((r.x2 - r.x1) * (r.y2 - r.y1));
        const ww = winWidth.get(r.id) ?? 0;
        const extDoor = doors.some(d => d.room === r.id && !d.other && d.kind !== 'vehicle');
        if (k.habitable) {
            if (ww === 0 && !extDoor) errors.push(`${r.name} is a habitable room with no window. Add one on an exterior wall (a side with no neighbouring room).`);
            else if (ww > 0 && (ww / 1000) * 1.2 < area * WINDOW.lightRatio) {
                warnings.push(`${r.name} glazing looks small for its ${area.toFixed(1)} m² (about ${(((ww / 1000) * 1.2) / area * 100).toFixed(0)}% of floor area; ~10% is typical for natural light).`);
            }
        } else if (ww === 0 && (r.type === 'bathroom' || r.type === 'ensuite' || r.type === 'wc' || r.type === 'laundry')) {
            notes.push(`${r.name} has no window, so it needs mechanical extraction.`);
        }
    }

    // Circulation share
    const circ = indoor.filter(r => rule(r).circulation).reduce((s, r) => s + m2((r.x2 - r.x1) * (r.y2 - r.y1)), 0);
    if (internalArea > 0 && circ / internalArea > pack.circulationMax) {
        warnings.push(`Circulation (entry, hall, corridor, stairs) is ${(circ / internalArea * 100).toFixed(0)}% of the internal area; aim for under ${(pack.circulationMax * 100).toFixed(0)}% for ${pack.label.toLowerCase()}. Shorten the corridors or fold them into usable space.`);
    }
    if (plan.brief.buildingType !== 'residential' && entryDoors.filter(d => d.kind !== 'vehicle').length < 2) {
        notes.push('Public and commercial buildings normally need more than one exit; this plan has one external door. Confirm egress, travel distances and accessible routes with the fire designer — the validator does not check them.');
    }

    // Brief
    if (plan.brief.bedrooms !== undefined) {
        const n = plan.rooms.filter(r => r.type === 'bedroom' || r.type === 'master_bedroom' || r.type === 'hotel_room').length;
        if (n !== plan.brief.bedrooms) errors.push(`The brief asks for ${plan.brief.bedrooms} bedroom${plan.brief.bedrooms === 1 ? '' : 's'} but the plan has ${n} (rooms of type bedroom, master_bedroom or hotel_room). A study or office does not count.`);
    }
    if (plan.brief.hemisphere) {
        const sun: Side = plan.brief.hemisphere === 'south' ? 'N' : 'S';
        const living = plan.rooms.filter(r => r.type === 'living' || r.type === 'family');
        if (living.length && !living.some(r => windows.some(w => w.room === r.id && w.side === sun))) {
            warnings.push(`No living-area window faces ${sun} (the sun side in the ${plan.brief.hemisphere}ern hemisphere) — consider moving living to that side.`);
        }
    }

    return { errors, warnings, notes, areas, internalArea, doors, windows };
}

export function describeValidation(v: Validation): string {
    const lines: string[] = [];
    if (v.errors.length) { lines.push('ERRORS (fix these):'); v.errors.forEach(e => lines.push(`- ${e}`)); }
    if (v.warnings.length) { lines.push('WARNINGS (consider):'); v.warnings.forEach(w => lines.push(`- ${w}`)); }
    if (v.notes.length) { lines.push('NOTES:'); v.notes.forEach(n => lines.push(`- ${n}`)); }
    return lines.join('\n');
}
