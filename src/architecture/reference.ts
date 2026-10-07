// Architectural reference data used by the floor-plan validator and returned on
// demand by the architecture_reference tool. Organised as BUILDING-TYPE PACKS:
// a pack bundles the room types, size rules, circulation limits and guidance for
// one kind of building. The validator picks the pack from brief.buildingType, so
// supporting a new typology means adding a pack — nothing else changes.
//
// IMPORTANT — provenance and licensing. Everything here is a generally published
// rule of thumb or a widely cited code figure, restated in our own words. It is
// NOT copied from Neufert's Architects' Data, the Metric Handbook, Architectural
// Graphic Standards or any other copyrighted work, and none of their tables are
// reproduced; they are cited as places to look (Neufert in particular spans
// almost every building type). Numbers are guideline defaults, vary by
// jurisdiction, and are not a substitute for the local building code, fire
// engineering or a licensed designer. Users can add their own licensed material
// under <workspace>/.freebird/references/ — see the architecture_reference tool.
//
// Maturity: 'residential' is the most developed pack. The others are STARTER
// packs — conservative minimums and a few key rules, meant to be deepened.

export interface RoomRule {
    /** Below this area (m²) or short side (m) the room is flagged as an error. */
    hardArea: number; hardDim: number;
    /** Below these the room is flagged as a warning (cramped, but conceivable). */
    softArea: number; softDim: number;
    /** Upper bounds (m²): above softMax the room is flagged as oversized, above hardMax it is rejected as absurd. */
    softMax?: number; hardMax?: number;
    /** Needs natural light from an exterior window. */
    habitable?: boolean;
    /** Counts as circulation for the circulation-share check. */
    circulation?: boolean;
    /** May be passed through to reach other rooms (not a private/leaf room). */
    transit?: boolean;
    /** Not roofed / not counted as internal floor area. */
    outdoor?: boolean;
    /** Reached only from a parent room (ensuite, robe, store) rather than from circulation. */
    dependent?: boolean;
    label: string;
    fill: string;
}

// [hardArea, hardDim, softArea, softDim]
const R = (hA: number, hD: number, sA: number, sD: number, label: string, fill: string, extra: Partial<RoomRule> = {}): RoomRule =>
    ({ hardArea: hA, hardDim: hD, softArea: sA, softDim: sD, label, fill, ...extra });

export interface BuildingPack {
    id: string;
    label: string;
    maturity: 'developed' | 'starter';
    /** Room types specific to this building type (common ones are always available). */
    rooms: Record<string, RoomRule>;
    /** Max share of internal area that should be circulation before warning. */
    circulationMax: number;
    /** Overrides for common rooms (e.g. wider corridors in a clinic). */
    overrides?: Record<string, Partial<RoomRule>>;
    /** Guidance returned by architecture_reference, keyed by topic. */
    topics: Record<string, string>;
}

// ── Room types every building has ───────────────────────────────────────────
export const COMMON_ROOMS: Record<string, RoomRule> = {
    entry:        R(1.5, 1.0, 2.5, 1.3, 'Entry', '#f4f1ea', { circulation: true, transit: true }),
    hall:         R(0, 0.8, 0, 1.0, 'Hall', '#f1f2ee', { circulation: true, transit: true }),
    corridor:     R(0, 0.8, 0, 1.0, 'Corridor', '#f1f2ee', { circulation: true, transit: true }),
    stairs:       R(3, 0.9, 4, 1.0, 'Stairs', '#f1f2ee', { circulation: true, transit: true }),
    lift:         R(2, 1.4, 2.5, 1.6, 'Lift', '#eceef1', { circulation: true }),
    wc:           R(0.9, 0.8, 1.3, 0.9, 'WC', '#e3f0f2'),
    accessible_wc: R(3.5, 1.5, 4.4, 1.9, 'Accessible WC', '#e3f0f2'),
    storage:      R(0.8, 0.7, 1.5, 0.9, 'Storage', '#efefef', { dependent: true }),
    plant:        R(1.5, 1.0, 3, 1.5, 'Plant', '#e8e8e8', { dependent: true }),
    cleaner:      R(1, 0.8, 1.5, 1.0, 'Cleaner', '#efefef', { dependent: true }),
    alfresco:     R(0, 0, 0, 0, 'Alfresco', '#e9f3e4', { outdoor: true, transit: true }),
    courtyard:    R(0, 0, 0, 0, 'Courtyard', '#e4f0e0', { outdoor: true, transit: true }),
    other:        R(0, 0, 0, 0, 'Room', '#f3f3f3', {})
};

// ── Packs ───────────────────────────────────────────────────────────────────
const RESIDENTIAL: BuildingPack = {
    id: 'residential', label: 'Residential (house, townhouse, unit)', maturity: 'developed', circulationMax: 0.15,
    rooms: {
        living:         R(10, 2.8, 14, 3.3, 'Living', '#fff7e8', { habitable: true, transit: true }),
        family:         R(10, 2.8, 14, 3.3, 'Family', '#fff7e8', { habitable: true, transit: true }),
        dining:         R(6.5, 2.4, 9, 2.7, 'Dining', '#fff4e0', { habitable: true, transit: true }),
        kitchen:        R(5, 1.9, 8, 2.4, 'Kitchen', '#eef5e8', { habitable: true, transit: true }),
        pantry:         R(0.8, 0.8, 1.5, 1.0, 'Pantry', '#eef5e8', { dependent: true }),
        laundry:        R(2, 1.3, 3, 1.5, 'Laundry', '#e8f1f5'),
        mudroom:        R(2, 1.2, 3, 1.5, 'Mud room', '#f1f2ee', { circulation: true, transit: true }),
        bedroom:        R(6.5, 2.2, 9, 2.7, 'Bedroom', '#eaf0fb', { habitable: true }),
        master_bedroom: R(9, 2.8, 12, 3.2, 'Master bedroom', '#f8ecef', { habitable: true }),
        ensuite:        R(2.2, 1.2, 3.5, 1.5, 'Ensuite', '#e3f0f2', { dependent: true }),
        bathroom:       R(2.8, 1.3, 3.5, 1.5, 'Bathroom', '#e3f0f2'),
        robe:           R(1, 0.8, 2, 1.2, 'Robe', '#efeaf6', { dependent: true }),
        study:          R(4.5, 2, 6, 2.4, 'Study', '#eaf0fb', { habitable: true }),
        garage:         R(12, 2.8, 15, 3.0, 'Garage', '#eceef1', { transit: true })
    },
    topics: {
        rooms: `RESIDENTIAL ROOM SIZES — guideline defaults (flagged by the validator; local code and the client's brief override)
Bedroom: aim 9–12 m², short side ≥ 2.7 m (below ~6.5 m² / 2.2 m is rejected). Master: aim 12–16 m², short side ≥ 3.2 m.
Living/family: 14–25 m², short side ≥ 3.3 m. Dining: 9–12 m². Kitchen: 8–14 m², short side ≥ 2.4 m (galley minimum ~2.1 m).
Bathroom ≥ 3.5 m² (1.5 m short side); ensuite ≥ 3.5 m²; WC ≥ 1.3 m² (0.9 × 1.5). Laundry ≥ 3 m². Study ≥ 6 m².
Walk-in robe ≥ 2 m² (1.2 m short side). Entry ≥ 2.5 m². Single garage ≥ 3.0 × 5.5 m; double ≥ 5.4 × 5.5 m.
Ceiling height: habitable rooms commonly ≥ 2.4 m; 2.7 m feels generous.`,
        kitchen: `KITCHEN
Work triangle (sink–cooktop–fridge): each leg ~1.2–2.7 m, total ≤ ~7.9 m. Work aisle 1.0–1.2 m (≥ 1.2 m for two cooks).
Bench depth 0.6 m, wall cupboards above at 0.45–0.6 m clear; pantry near the kitchen and the entry from the garage helps grocery runs.
Island needs ≥ 1.0 m clear on all working sides.`,
        bedroom: `BEDROOMS & BATHROOMS
Bed footprints (approx.): double 1.4 × 1.9 m, queen 1.5 × 2.0 m, king 1.8 × 2.0 m. Leave ~0.6–0.9 m beside and at the foot of the bed.
Wardrobe depth 0.6 m; a walk-in needs ≥ 1.2 m width plus hanging depth on each side (~2 m² minimum).
Bathroom: shower ≥ 0.9 × 0.9 m; WC centre ≥ 0.4 m from a side wall with ≥ 0.6 m clear in front; basin clear space ~0.7 m wide.
Group wet areas (bathroom, ensuite, laundry, kitchen) on shared or stacked walls to keep plumbing short.`,
        orientation: `ORIENTATION & PASSIVE DESIGN
Southern hemisphere (e.g. Australia, NZ): glaze and open living areas to the NORTH for winter sun; shade north windows in summer with eaves ~0.45–0.6 m per metre of window height; keep west glazing small.
Northern hemisphere: the same logic mirrored — living to the SOUTH. Aim for cross-ventilation: openings on two sides of the main rooms.
Garages, laundries and storage make good buffers on the hot (west) side. Bedrooms often suit the cool side (east in hot climates).`,
        zoning: `RESIDENTIAL ZONING
Separate day (living/kitchen/dining) and night (bedrooms) zones; a bedroom must not be reached through another bedroom or a bathroom. Ensuite and robe open only to their bedroom.
Entry should give a route to the living zone without exposing bedrooms. Garage connects to the house through a mud room, laundry or hall.
Put noisy rooms (living, garage) away from bedrooms, or buffer them with robes/storage/hall. Keep circulation under ~15% of the area.`
    }
};

const OFFICE: BuildingPack = {
    id: 'office', label: 'Office / workplace', maturity: 'starter', circulationMax: 0.25,
    rooms: {
        reception:   R(8, 2.4, 12, 3.0, 'Reception', '#fff4e0', { habitable: true, transit: true }),
        open_office: R(15, 3.5, 30, 5.0, 'Open office', '#eef3fb', { habitable: true, transit: true }),
        office:      R(6, 2.0, 9, 2.4, 'Office', '#eaf0fb', { habitable: true }),
        meeting:     R(8, 2.4, 12, 2.8, 'Meeting room', '#f1ecf8', { habitable: true }),
        breakout:    R(8, 2.4, 14, 3.0, 'Breakout', '#eef5e8', { habitable: true, transit: true }),
        kitchenette: R(3.5, 1.5, 6, 2.0, 'Kitchenette', '#eef5e8'),
        server:      R(3, 1.5, 5, 1.8, 'Server / comms', '#e8e8e8', { dependent: true }),
        print:       R(2, 1.2, 4, 1.5, 'Print / copy', '#efefef', { dependent: true })
    },
    overrides: { corridor: { hardDim: 1.0, softDim: 1.5 }, hall: { hardDim: 1.0, softDim: 1.5 } },
    topics: {
        office: `OFFICE (starter guidance — verify against the brief, code and fire/egress advice)
Rule-of-thumb planning: ~10–14 m² of gross floor area per person overall; ~6–8 m² per desk for open-plan work area. A desk is ~1.4–1.6 m × 0.7–0.8 m with ~1.0 m of chair/circulation space.
Cellular office 9–12 m² (short side ≥ 2.4 m). Meeting room ≈ 1.5–2.5 m² per seat. Reception ≥ 12 m² with sightlines to the entry.
Corridors ≥ 1.2 m (1.5 m+ where two people pass often). Provide an accessible WC on each level and a lift above ground floor. Plan for ≥ 2 exits and discuss egress with the fire designer.
Daylight: keep workstations within ~6–8 m of glazing; put meeting rooms and services on the core, not on the facade.`
    }
};

const EDUCATION: BuildingPack = {
    id: 'education', label: 'Education (school, early learning)', maturity: 'starter', circulationMax: 0.25,
    rooms: {
        classroom:  R(36, 5.0, 50, 6.0, 'Classroom', '#eef3fb', { habitable: true }),
        staffroom:  R(15, 3.0, 25, 4.0, 'Staff room', '#fff4e0', { habitable: true }),
        admin:      R(8, 2.4, 14, 3.0, 'Admin', '#eaf0fb', { habitable: true }),
        library:    R(40, 5.0, 80, 7.0, 'Library', '#f1ecf8', { habitable: true }),
        hall:       R(100, 8.0, 200, 10.0, 'Hall', '#f4f1ea', { habitable: true, transit: true }),
        lab:        R(55, 6.0, 70, 7.0, 'Science lab', '#e8f1f5', { habitable: true }),
        art:        R(50, 5.5, 65, 6.5, 'Art studio', '#fdf0f0', { habitable: true }),
        canteen:    R(30, 4.0, 60, 6.0, 'Canteen', '#eef5e8', { habitable: true, transit: true })
    },
    overrides: { corridor: { hardDim: 1.5, softDim: 2.0 }, hall: { hardDim: 1.5, softDim: 2.0 } },
    topics: {
        education: `EDUCATION (starter guidance — school size rules are set by the education authority; check them)
Classroom: typically ~2.0–2.5 m² per pupil → about 55–65 m² for 25–30 pupils, with a short side ≥ 6 m so rows and group work fit; north (southern hemisphere) or south light is steadier than low east/west sun.
Corridors ≥ 1.8–2.0 m (many children moving at once); toilets near classrooms but not opening straight into them; at least one accessible WC; stairs with generous landings and handrails at child heights.
Group classrooms around shared learning space; keep noisy rooms (hall, music, canteen) acoustically separated from quiet ones (library, classrooms). Plan multiple exits and discuss egress with the fire designer.`
    }
};

const HEALTHCARE: BuildingPack = {
    id: 'healthcare', label: 'Healthcare (clinic, GP, consulting suite)', maturity: 'starter', circulationMax: 0.3,
    rooms: {
        waiting:    R(8, 2.4, 14, 3.0, 'Waiting', '#fff4e0', { habitable: true, transit: true }),
        reception:  R(6, 2.0, 10, 2.5, 'Reception', '#fff4e0', { habitable: true, transit: true }),
        consult:    R(9, 2.7, 12, 3.0, 'Consult', '#eaf0fb', { habitable: true }),
        treatment:  R(12, 3.0, 16, 3.6, 'Treatment', '#e3f0f2', { habitable: true }),
        procedure:  R(16, 3.5, 20, 4.0, 'Procedure', '#f8ecef'),
        sterilise:  R(6, 2.0, 9, 2.4, 'Sterilising', '#e8f1f5', { dependent: true }),
        staff:      R(8, 2.4, 14, 3.0, 'Staff room', '#eef5e8', { habitable: true })
    },
    overrides: { corridor: { hardDim: 1.5, softDim: 1.8 }, hall: { hardDim: 1.5, softDim: 1.8 } },
    topics: {
        healthcare: `HEALTHCARE / CLINIC (starter guidance — healthcare design is heavily regulated; use the relevant health facility guidelines)
Consult room ~12–16 m² (≥ 9 m² absolute minimum) with room to turn a wheelchair (1.5 m) and a clear side for the examination couch; treatment room ~14–18 m².
Corridors ≥ 1.5–1.8 m for patient flow, 2.4 m+ where beds/trolleys pass. Separate clean and dirty flows; place sterilising near treatment, hand-basins at every clinical room.
Accessible WC close to waiting; privacy at reception (no overheard conversations); direct, short route from entry to reception. Plan for ≥ 2 exits and confirm egress and infection-control requirements with the authority.`
    }
};

const RETAIL: BuildingPack = {
    id: 'retail', label: 'Retail & hospitality (shop, café, restaurant)', maturity: 'starter', circulationMax: 0.25,
    rooms: {
        shopfloor:   R(20, 3.5, 40, 5.0, 'Shop floor', '#fff4e0', { habitable: true, transit: true }),
        stockroom:   R(6, 1.8, 12, 2.5, 'Stockroom', '#efefef', { dependent: true }),
        fitting:     R(1.8, 1.2, 2.5, 1.5, 'Fitting room', '#efeaf6', { dependent: true }),
        dining_hall: R(15, 3.5, 30, 5.0, 'Dining', '#fff4e0', { habitable: true, transit: true }),
        bar:         R(6, 1.8, 10, 2.5, 'Bar / counter', '#f1ecf8', { habitable: true }),
        commercial_kitchen: R(12, 3.0, 20, 4.0, 'Kitchen', '#eef5e8'),
        coolroom:    R(4, 1.8, 6, 2.2, 'Coolroom', '#e3f0f2', { dependent: true }),
        staff_room:  R(4, 1.8, 8, 2.4, 'Staff', '#eef5e8', { dependent: true })
    },
    topics: {
        retail: `RETAIL & HOSPITALITY (starter guidance — food premises also have health-authority layout rules)
Shop: main aisles ≥ 1.5 m, secondary ≥ 1.2 m; entry sightline to the back wall; fitting rooms ≥ 1.2 × 1.5 m with one accessible room; counter near the entry.
Café/restaurant: ~1.2–1.8 m² of dining floor per seat (more for table service), kitchen ≈ 30–40% of the dining area; keep back-of-house (kitchen, coolroom, staff) on one service route with its own door and deliveries away from customers.
Accessible WC and customer toilets if seating exceeds the local threshold; ≥ 2 exits for any public space of size — confirm egress with the fire designer.`
    }
};

const HOSPITALITY: BuildingPack = {
    id: 'hotel', label: 'Hotel / short-stay accommodation', maturity: 'starter', circulationMax: 0.3,
    rooms: {
        lobby:      R(15, 3.0, 30, 5.0, 'Lobby', '#fff4e0', { habitable: true, transit: true }),
        hotel_room: R(14, 3.0, 18, 3.5, 'Guest room', '#eaf0fb', { habitable: true }),
        ensuite:    R(2.8, 1.4, 3.5, 1.6, 'Ensuite', '#e3f0f2', { dependent: true }),
        back_of_house: R(8, 2.4, 15, 3.0, 'Back of house', '#efefef', { dependent: true })
    },
    overrides: { corridor: { hardDim: 1.2, softDim: 1.5 } },
    topics: {
        hotel: `HOTEL / ACCOMMODATION (starter guidance)
Guest room ~16–25 m² including ensuite (≥ 14 m² absolute); bay width ≥ 3.3–3.6 m so a king bed plus walkway fits; stack bathrooms back-to-back along a service core.
Corridors ≥ 1.5 m; provide lifts above two storeys, accessible rooms in the proportion the local code requires, and ≥ 2 independent exits per floor — confirm with the fire designer.
Acoustics: separate lifts, ice machines and plant from guest rooms with a buffer; stagger entry doors so they don't face each other.`
    }
};

// Upper bounds for a house. Without them a plan can be "valid" while an ensuite is the size of the master
// bedroom and the WC is an 18 m² strip — a fast model will happily fill rows with whatever sizes make the
// rectangles tile. Only the residential pack has them: public buildings legitimately have huge halls and
// foyers, and their packs can add limits when real use shows what is sensible.
const RESIDENTIAL_MAX_AREA: Record<string, [number, number]> = {
    ensuite: [8, 14], bathroom: [10, 15], wc: [3, 6], laundry: [8, 14], pantry: [5, 9], robe: [8, 14], storage: [6, 12],
    entry: [10, 18], study: [16, 28], kitchen: [25, 45], dining: [25, 40], bedroom: [20, 32], master_bedroom: [30, 45],
    living: [50, 80], family: [50, 80], hall: [25, 45], mudroom: [8, 14], cleaner: [3, 6], garage: [45, 70]
};
for (const [type, [softMax, hardMax]] of Object.entries(RESIDENTIAL_MAX_AREA)) {
    if (RESIDENTIAL.rooms[type]) { RESIDENTIAL.rooms[type].softMax = softMax; RESIDENTIAL.rooms[type].hardMax = hardMax; }
    else (RESIDENTIAL.overrides ??= {})[type] = { softMax, hardMax };
}

export const PACKS: Record<string, BuildingPack> = {
    residential: RESIDENTIAL, office: OFFICE, education: EDUCATION,
    healthcare: HEALTHCARE, retail: RETAIL, hotel: HOSPITALITY
};
export const DEFAULT_BUILDING_TYPE = 'residential';

/** Merged room rules for a building type (common rooms + pack rooms + pack overrides). */
export function rulesFor(buildingType: string): Record<string, RoomRule> {
    const pack = PACKS[buildingType] ?? PACKS[DEFAULT_BUILDING_TYPE];
    const out: Record<string, RoomRule> = { ...COMMON_ROOMS };
    for (const [k, v] of Object.entries(pack.overrides ?? {})) out[k] = { ...out[k], ...v };
    return { ...out, ...pack.rooms };
}

export function roomTypesFor(buildingType: string): string[] { return Object.keys(rulesFor(buildingType)); }

// Words models reach for that mean one of our room types. Mapping them (and saying so) avoids a failed
// call over a synonym.
const TYPE_ALIASES: Record<string, string> = {
    utility: 'laundry', 'laundry room': 'laundry', lounge: 'living', 'living room': 'living', 'family room': 'family', 'rumpus': 'family',
    'dining room': 'dining', 'master': 'master_bedroom', 'master bedroom': 'master_bedroom', 'main bedroom': 'master_bedroom', 'bed': 'bedroom',
    'guest bedroom': 'bedroom', 'kids bedroom': 'bedroom', bath: 'bathroom', 'main bathroom': 'bathroom', toilet: 'wc', powder: 'wc', 'powder room': 'wc',
    'walk-in robe': 'robe', 'walk in robe': 'robe', wir: 'robe', wardrobe: 'robe', closet: 'robe', 'walk-in closet': 'robe', office: 'study', 'home office': 'study',
    foyer: 'entry', 'entry hall': 'hall', passage: 'corridor', hallway: 'hall', 'double garage': 'garage', 'single garage': 'garage', carport: 'garage',
    patio: 'alfresco', deck: 'alfresco', verandah: 'alfresco', porch: 'alfresco', balcony: 'alfresco', yard: 'courtyard', linen: 'storage', 'linen cupboard': 'storage', cupboard: 'storage'
};

/** The valid type for what the model wrote: itself, a known synonym, or undefined. */
export function canonicalRoomType(buildingType: string, written: string): string | undefined {
    const valid = roomTypesFor(buildingType);
    const key = written.trim().toLowerCase();
    if (valid.includes(key)) return key;
    const alias = TYPE_ALIASES[key];
    return alias && valid.includes(alias) ? alias : undefined;
}

/**
 * One line of comfortable minimums ("bedroom 9 m² / 2.7 m wide, …") for the room types that have size
 * rules, generated from the same table the validator uses so the two cannot drift. It goes in the
 * create_floor_plan description so the model gets sizes right the first time instead of being told
 * "too small" a round trip later.
 */
export function sizeSummary(buildingType: string): string {
    const rules = rulesFor(buildingType);
    return Object.entries(rules)
        .filter(([, k]) => !k.outdoor && (k.softArea > 0 || k.softDim > 0))
        .map(([type, k]) => `${type} ${k.softArea ? k.softArea + ' m²' : ''}${k.softArea && k.softDim ? ' / ' : ''}${k.softDim ? k.softDim + ' m wide' : ''}`)
        .join(', ');
}

// ── Openings & general thresholds ───────────────────────────────────────────
export const DOOR = {
    defaultInterior: 0.82,   // common hinged leaf width (m)
    defaultEntry: 0.92,
    defaultGarageVehicle: 2.4,
    minWidth: 0.7,
    /** Wall length a door needs beyond its own width, so it is not jammed into a corner. */
    wallMargin: 0.2
};
export const WINDOW = {
    defaultWidth: 1.5,
    minWidth: 0.4,
    sideMargin: 0.2,
    /** Glazing as a share of floor area commonly required for natural light in habitable rooms. */
    lightRatio: 0.10
};
export const WALL = { exterior: 0.2, interior: 0.1 };
export const COVERAGE_GAP_WARN = 0.08;       // unassigned share of the footprint (warn above)

// ── Topic text for the architecture_reference tool ──────────────────────────
const typeList = () => Object.values(PACKS)
    .map(p => `  ${p.id} (${p.label}, ${p.maturity}): ${Object.keys(p.rooms).join(', ')}`).join('\n');

export const COMMON_TOPICS: Record<string, string> = {
    spec: `FLOOR PLAN SPEC (create_floor_plan). Units are METRES. North is up; x grows east (right), y grows south (down).
PREFERRED: describe the plan as nested rows and columns (no coordinates, so rooms cannot overlap or leave gaps):
{
  "brief": { "buildingType": "residential", "bedrooms": 3, "hemisphere": "south" },     // all optional; buildingType picks the rule pack
  "layout": { "w": 14, "items": [                          // the root stacks rows from north (top) to south (bottom)
    { "h": 4.6, "items": [                                 // a row 4.6 m tall; its items run west to east
        { "id": "liv", "name": "Living", "type": "living", "w": 5.6 },
        { "id": "din", "name": "Dining", "type": "dining", "w": 3.8 },
        { "w": 4.6, "items": [                           // a column inside the row: items stack north to south
            { "id": "kit", "name": "Kitchen", "type": "kitchen", "h": 3.0 },
            { "id": "lau", "name": "Laundry", "type": "laundry" } ] } ] },   // an unsized item shares what is left
    { "h": 1.4, "items": [ { "id": "hall", "name": "Hall", "type": "hall" } ] }
  ] },
  "doors": [
    { "from": "exterior", "to": "hall", "side": "W" },          // front door; 'side' = which wall of 'to'
    { "from": "hall", "to": "liv", "at": 0.3, "kind": "open" },   // 'at' 0..1 along the shared wall; 'open' = open-plan gap, no leaf (also 'sliding', 'vehicle')
    { "from": "liv", "to": "din", "kind": "open" }
  ],
  "windows": [ { "room": "liv", "side": "N", "width": 3 } ]
}
Sizes along a row are "w", along a column "h"; the layout's "w" and each row's "h" fix the overall size. A door needs two rooms that SHARE A WALL: neighbours in a row touch, and across rows rooms touch where their x-ranges overlap.
ALTERNATIVE (more error-prone): "rooms": [ { "id": "liv", "name": "Living", "type": "living", "x": 0, "y": 0, "w": 5.5, "h": 4.2 } ] with absolute metres; rooms must not overlap and neighbours must share an edge exactly.
Rules: every non-outdoor room needs a door route from the front door that does not pass through a private room (bedroom, office, classroom, consult room...). Every habitable room needs a window on an exterior side (one is added for you if you forget). Do NOT write dimensions or areas — they are computed.
Building types and their room types (common types — entry, hall, corridor, stairs, lift, wc, accessible_wc, storage, plant, cleaner, alfresco, courtyard, other — work in all):
${typeList()}`,

    process: `DESIGN PROCESS (do these in order, briefly, before calling create_floor_plan)
1. Brief: confirm or state assumptions — building type, site/plot size, storeys, capacity or bedrooms, must-haves, hemisphere/orientation. Ask only if truly ambiguous. Call architecture_reference for the building type.
2. Program: list rooms with target areas, then group them into zones (public/private, front/back-of-house, day/night, clean/dirty, noisy/quiet).
2b. Size the BUILDING, not the plot: a 4-bedroom house is typically 180-250 m² including the garage (about 15 × 12 m) — leave setbacks and garden around it. Check each room against the size guidance so no room is absurdly large or small.
3. Adjacency: what must touch, what must be apart, what must be reachable only through something else (privacy, hygiene, security).
4. Layout on a grid: place zones as blocks, keep circulation short and legible, align walls, put the main entry on the street/arrival side.
5. Openings: a door for every connection you intend (no sealed rooms), windows on every habitable room's exterior wall, an accessible route and more than one exit for public buildings.
6. Call create_floor_plan. If it reports errors, fix exactly those and call it again. Then look at the render and check it against the brief.`,

    doors: `DOORS, WINDOWS, CLEARANCES (general)
Hinged door leaf ~0.82 m (0.72–0.92); entry/public doors ~0.92–1.0 m; wheelchair-accessible clear opening ≥ 0.85 m (US ADA 0.815 m / 32 in). Double doors 1.2–1.8 m.
Corridors: ≥ 0.9 m residential minimum, 1.0–1.2 m comfortable, ≥ 1.2–1.5 m in public/commercial buildings, wider where trolleys or crowds pass.
Leave ≥ 0.2 m of wall beside a door so it is not jammed into a corner; avoid doors that swing into each other or into a circulation route.
Natural light: glazing ≈ 10% of floor area for habitable rooms; openable ventilation ≈ 5% (typical of the Australian NCC and many codes).
Windows sit on exterior walls only; rooms without windows (toilets, stores) need mechanical extraction.`,

    circulation: `CIRCULATION, SECURITY & EGRESS (general)
Keep circulation lean — limits differ by building type (the validator flags when it exceeds the pack's). Make the route legible: entry → reception/foyer → destinations.
Separate public from private/staff areas; control access with doors that can be locked or supervised. Keep noisy rooms away from quiet ones or buffer them with storage/circulation.
Public and commercial buildings need more than one exit, protected paths of travel and maximum travel distances set by the local building code — these are life-safety rules: involve a fire engineer or licensed designer. The validator only reminds you; it does not check egress compliance.`,

    stairs: `STAIRS (typical code ranges; verify locally)
Australia (NCC): riser 115–190 mm, going 240–355 mm, and 550 ≤ 2R+G ≤ 700 mm; headroom ≥ 2.0 m.
US (IRC): max riser ~196 mm (7¾ in), min tread ~254 mm (10 in), headroom ≥ ~2.03 m (6 ft 8 in). Commercial/public stairs usually have stricter, shallower limits.
Comfortable rule of thumb (Blondel): 2R + G ≈ 600–630 mm. Straight flight width ≥ 0.9–1.0 m residential, ≥ 1.0–1.2 m+ public. Landing as deep as the stair is wide.
Plan area: a straight stair for a 2.7 m storey height (about 15 risers) needs ~3.6–4.0 m of run plus landings.`,

    accessibility: `ACCESSIBILITY
Step-free entry, ≥ 1.0 m corridors (1.2–1.5 m in public buildings), ≥ 0.85 m clear doors, a 1.5 m turning circle in bathrooms/bedrooms/kitchens/consulting rooms (AS 1428.1 / ADA use 1.5 m).
Accessible WC with side transfer space (~0.9 m) and ≥ 1.9 × 2.3 m in many standards; a lift where there is more than one public level. Standards differ by country — treat these as a prompt to check, not a compliance statement.`,

    landscape: `LANDSCAPE (site-plan basics)
Paths ≥ 0.9–1.2 m; driveway single 3.0 m, double 5.4–6.0 m; parking bay 2.5 × 5.5 m (accessible bays wider); setbacks and site coverage are set by the local planning scheme — ask for them.
Plant spacing = mature width, not nursery size; group by water need; keep large trees ≥ their mature height from footings; choose species for the local climate zone — do not guess species without the region.`,

    sources: `WHERE THESE FIGURES COME FROM / WHERE TO LOOK (not reproduced here)
General: Neufert, Architects' Data (Wiley) — covers almost every building type; Metric Handbook (Routledge); Architectural Graphic Standards (Wiley); Ching, Building Construction Illustrated and Architecture: Form, Space & Order; Alexander, A Pattern Language.
Codes: National Construction Code (Australia, free online), ADA Standards (US, free), International Building/Residential Codes (US), UK Approved Documents (free), AS 1428.1 (paid), NKBA Kitchen & Bath Planning Guidelines.
By building type: Australasian Health Facility Guidelines and UK Health Building Notes (healthcare); UK BB103 area guidelines and state school facility standards (education); British Council for Offices Guide (offices); local planning schemes for setbacks and coverage.
To make this tool use your own licensed notes (for example excerpts you are allowed to keep from Neufert for an office, school or clinic), save .md or .txt files in <workspace>/.freebird/references/ — optionally named after the building type — and call architecture_reference with a keyword.`
};

export interface ReferenceHit { topic: string; text: string; }

/**
 * Reference text matching `query`, within a building type. A blank query returns
 * the topic index for that type. Pack topics come first, then the common ones.
 */
export function lookupReference(query: string, buildingType?: string): ReferenceHit[] {
    const pack = buildingType ? PACKS[buildingType] : undefined;
    const all: Record<string, string> = { ...COMMON_TOPICS, ...(pack?.topics ?? {}) };
    // If the query names a building type, include that pack's topics too.
    const q = query.trim().toLowerCase();
    for (const p of Object.values(PACKS)) {
        if (q && (q === p.id || q.includes(p.id) || p.label.toLowerCase().includes(q))) Object.assign(all, p.topics);
    }
    const names = Object.keys(all);
    if (!q) return names.map(topic => ({ topic, text: all[topic] }));
    const exact = names.filter(t => t === q);
    if (exact.length) return exact.map(topic => ({ topic, text: all[topic] }));
    const words = q.split(/\s+/).filter(Boolean);
    return names.filter(t => words.some(w => t.includes(w) || all[t].toLowerCase().includes(w))).map(topic => ({ topic, text: all[topic] }));
}

export function listTopics(): string {
    const packs = Object.values(PACKS).map(p => `${p.id} (${p.maturity}): ${Object.keys(p.topics).join(', ')}`).join(' | ');
    return `Common topics: ${Object.keys(COMMON_TOPICS).join(', ')}. Building-type topics — ${packs}.`;
}
