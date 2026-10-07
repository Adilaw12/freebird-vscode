// Floor-plan spec: parsing, geometry and validation. Pure (no vscode import).
//
// The model proposes rooms/doors/windows as structured data; this module checks
// the design the way a reviewer would (can you walk to every room? does every
// bedroom have a window? are the rooms big enough?) and the renderer then draws
// it deterministically, so labels and dimensions are computed, never typed by
// the model. Internally everything is integer millimetres to avoid float drift
// when comparing wall coordinates.

import {
    rulesFor, roomTypesFor, PACKS, DEFAULT_BUILDING_TYPE, DOOR, WINDOW, COVERAGE_GAP_WARN
} from './reference';

export type Side = 'N' | 'E' | 'S' | 'W';
export type DoorKind = 'swing' | 'open' | 'sliding' | 'vehicle';
export const EXTERIOR = 'exterior';

export interface Room { id: string; name: string; type: string; x1: number; y1: number; x2: number; y2: number; }
export interface DoorSpec { from: string; to: string; side?: Side; at: number; width: number; kind: DoorKind; }
export interface WindowSpec { room: string; side: Side; at: number; width: number; }
export interface Brief { buildingType: string; bedrooms?: number; hemisphere?: 'south' | 'north'; }
export interface Plan { brief: Brief; rooms: Room[]; doors: DoorSpec[]; windows: WindowSpec[]; }

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
const num = (v: unknown): number | undefined => {
    const n = typeof v === 'string' ? Number(v) : v;
    return typeof n === 'number' && Number.isFinite(n) ? n : undefined;
};

// ── Parsing ──────────────────────────────────────────────────────────────────

export function parsePlan(input: unknown): { plan?: Plan; errors: string[] } {
    const errors: string[] = [];
    let raw: any = input;
    if (typeof raw === 'string') {
        try { raw = JSON.parse(raw); } catch { return { errors: ['spec is not valid JSON.'] }; }
    }
    if (!raw || typeof raw !== 'object') return { errors: ['spec must be an object with a "rooms" array.'] };
    if (!Array.isArray(raw.rooms) || raw.rooms.length === 0) return { errors: ['spec.rooms must be a non-empty array.'] };
    if (raw.rooms.length > 60) return { errors: ['spec.rooms has more than 60 rooms — simplify.'] };

    const buildingType = String(raw.brief?.buildingType ?? DEFAULT_BUILDING_TYPE).toLowerCase();
    if (!PACKS[buildingType]) return { errors: [`brief.buildingType "${buildingType}" is not supported. Use one of: ${Object.keys(PACKS).join(', ')}.`] };
    const rules = rulesFor(buildingType);
    const validTypes = roomTypesFor(buildingType);

    const rooms: Room[] = [];
    const seen = new Set<string>();
    raw.rooms.forEach((r: any, i: number) => {
        const id = String(r?.id ?? '').trim();
        const label = id || `rooms[${i}]`;
        if (!id) { errors.push(`rooms[${i}] needs an "id".`); return; }
        if (id === EXTERIOR) { errors.push(`room id "${EXTERIOR}" is reserved.`); return; }
        if (seen.has(id)) { errors.push(`duplicate room id "${id}".`); return; }
        seen.add(id);
        const type = String(r?.type ?? 'other');
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

    return errors.length ? { errors } : { plan: { brief, rooms, doors, windows }, errors };
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
    const notes: string[] = [];
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
            if (a > 0.01 * 1e6) overlaps.push(`"${plan.rooms[i].name}" and "${plan.rooms[j].name}" overlap by ${m2(a).toFixed(1)} m²`);
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
            errors.push(`${tag} is too small for a ${k.label.toLowerCase()} — minimum about ${k.hardArea} m² and ${k.hardDim} m wide.`);
        } else if ((k.softArea && area < k.softArea) || (k.softDim && dim < k.softDim)) {
            warnings.push(`${tag} is cramped for a ${k.label.toLowerCase()} — aim for ${k.softArea}+ m² and ${k.softDim}+ m wide.`);
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

    // Resolve doors onto walls
    const doors: PlacedOpening[] = [];
    plan.doors.forEach((d, i) => {
        const label = `Door ${name(d.from)} → ${name(d.to)}`;
        if (d.from === EXTERIOR || d.to === EXTERIOR) {
            const room = byId.get(d.from === EXTERIOR ? d.to : d.from)!;
            const side = d.side!;
            const segs = exteriorIntervals(room, side, plan.rooms).filter(([a, b]) => b - a >= d.width + 2 * DOOR.wallMargin * 1000);
            if (!segs.length) { errors.push(`${label}: no exterior wall on the ${side} side of ${room.name} long enough for a ${fmt(d.width)} m door.`); return; }
            const [a, b] = segs.sort((p, q) => (q[1] - q[0]) - (p[1] - p[0]))[0];
            const L = sideLine(room, side);
            doors.push({ orient: L.orient, fixed: L.fixed, center: placeAlong(a, b, d.width, DOOR.wallMargin * 1000, d.at), width: d.width, side, room: room.id, kind: d.kind, door: d });
            return;
        }
        const A = byId.get(d.from)!, B = byId.get(d.to)!;
        const sw = sharedWall(A, B);
        if (!sw) { errors.push(`${label}: the rooms do not share a wall, so the door has nowhere to go. Make them touch (same x or y edge) or route through a hall.`); return; }
        if (sw.b - sw.a < d.width + 2 * DOOR.wallMargin * 1000) {
            errors.push(`${label}: the shared wall is only ${fmt(sw.b - sw.a)} m long — too short for a ${fmt(d.width)} m door plus margins.`); return;
        }
        doors.push({ orient: sw.orient, fixed: sw.fixed, center: placeAlong(sw.a, sw.b, d.width, DOOR.wallMargin * 1000, d.at), width: d.width, side: sw.sideOfA, room: A.id, other: B.id, kind: d.kind, door: d });
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
        const segs = exteriorIntervals(room, w.side, plan.rooms).filter(([a, b]) => b - a >= WINDOW.minWidth * 1000 + 2 * margin);
        if (!segs.length) { errors.push(`Window in ${room.name} on the ${w.side} side: that side has no exterior wall (another room is behind it) or it is too short.`); return; }
        const [a, b] = segs.sort((p, q) => (q[1] - q[0]) - (p[1] - p[0]))[0];
        const width = Math.min(w.width, b - a - 2 * margin);
        const L = sideLine(room, w.side);
        const opening: PlacedOpening = { orient: L.orient, fixed: L.fixed, center: placeAlong(a, b, width, margin, w.at), width, side: w.side, room: room.id };
        const clash = doors.find(d => d.orient === opening.orient && d.fixed === opening.fixed && Math.abs(d.center - opening.center) < (d.width + opening.width) / 2);
        if (clash) { errors.push(`Window in ${room.name} (${w.side}) overlaps a door — move it with a different "at".`); return; }
        windows.push(opening);
    });

    // Reachability
    const nodeDoors = new Map<string, Set<string>>();
    const link = (x: string, y: string) => { (nodeDoors.get(x) ?? nodeDoors.set(x, new Set()).get(x)!).add(y); };
    for (const d of plan.doors) { link(d.from, d.to); link(d.to, d.from); }
    const entryDoors = plan.doors.filter(d => (d.from === EXTERIOR || d.to === EXTERIOR) && d.kind !== 'vehicle');
    if (!entryDoors.length) errors.push('There is no front door. Add a door from "exterior" to your entry or hall with a "side".');
    const reached = new Set<string>();
    const queue: string[] = [];
    for (const d of entryDoors) { const id = d.from === EXTERIOR ? d.to : d.from; if (!reached.has(id)) { reached.add(id); if (rule(byId.get(id)!).transit || rule(byId.get(id)!).outdoor) queue.push(id); } }
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
    for (const r of plan.rooms) {
        if (reached.has(r.id) || !entryDoors.length) continue;
        const hasDoor = (nodeDoors.get(r.id)?.size ?? 0) > 0;
        const msg = !hasDoor
            ? `${r.name} has no door — add one from the room it should open from.`
            : `${r.name} can only be reached by walking through a bedroom, bathroom or other private room (or is cut off). Connect it to the hall, entry or living area.`;
        if (r.type === 'garage') warnings.push(`${r.name} is not connected to the house by a door.`);
        else errors.push(msg);
    }
    for (const r of plan.rooms) {
        if ((r.type === 'ensuite') && ![...(nodeDoors.get(r.id) ?? [])].some(n => { const t = byId.get(n)?.type; return t === 'bedroom' || t === 'master_bedroom'; })) {
            warnings.push(`${r.name} (ensuite) does not open to a bedroom.`);
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
