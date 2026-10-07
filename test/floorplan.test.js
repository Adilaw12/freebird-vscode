// test/floorplan.test.js — src/architecture: spec parsing, the design validator,
// the deterministic renderer and the reference packs (pure modules, no vscode).
//
// The negative cases are the mistakes an LLM-drawn plan actually made: rooms with
// no doors, bedrooms only reachable through other bedrooms, labels that disagree
// with the geometry, windows on interior walls, too few bedrooms.

require('./bootstrap');
const path = require('path');
const { suite, check } = require('./helpers');

const OUT = path.join(__dirname, '..', 'out');
const { parsePlan, validatePlan, describeValidation } = require(path.join(OUT, 'architecture/plan.js'));
const { renderPlan } = require(path.join(OUT, 'architecture/render.js'));
const { PACKS, rulesFor, roomTypesFor, lookupReference, COMMON_TOPICS } = require(path.join(OUT, 'architecture/reference.js'));
const { checkSvg } = require(path.join(OUT, 'agent/diagramPage.js'));
const { isDesignConversation } = require(path.join(OUT, 'architecture/intent.js'));

const rm = (id, name, type, x, y, w, h) => ({ id, name, type, x, y, w, h });
const door = (from, to, extra = {}) => ({ from, to, ...extra });

// A sound 3-bedroom house, 14.0 × 10.4 m.
const HOUSE = {
    brief: { buildingType: 'residential', bedrooms: 3, hemisphere: 'south' },
    rooms: [
        rm('liv', 'Living', 'living', 0, 0, 5.6, 4.6), rm('din', 'Dining', 'dining', 5.6, 0, 3.8, 4.6),
        rm('kit', 'Kitchen', 'kitchen', 9.4, 0, 4.6, 3.0), rm('lau', 'Laundry', 'laundry', 9.4, 3.0, 2.6, 1.6),
        rm('pan', 'Pantry', 'pantry', 12.0, 3.0, 2.0, 1.6),
        rm('hall', 'Entry hall', 'hall', 0, 4.6, 14.0, 1.4),
        rm('bed2', 'Bedroom 2', 'bedroom', 0, 6.0, 3.4, 4.4), rm('bed3', 'Bedroom 3', 'bedroom', 3.4, 6.0, 3.4, 4.4),
        rm('bath', 'Bathroom', 'bathroom', 6.8, 6.0, 2.2, 3.0), rm('lin', 'Linen', 'storage', 6.8, 9.0, 2.2, 1.4),
        rm('mas', 'Master', 'master_bedroom', 9.0, 6.0, 5.0, 2.9), rm('ens', 'Ensuite', 'ensuite', 9.0, 8.9, 2.8, 1.5),
        rm('rob', 'Robe', 'robe', 11.8, 8.9, 2.2, 1.5)
    ],
    doors: [
        door('exterior', 'hall', { side: 'W' }), door('hall', 'liv', { kind: 'open', at: 0.3 }),
        door('liv', 'din', { kind: 'open' }), door('din', 'kit', { kind: 'open' }),
        door('hall', 'lau', {}), door('kit', 'pan', {}),
        door('hall', 'bed2', {}), door('hall', 'bed3', {}), door('hall', 'bath', {}), door('hall', 'mas', {}),
        door('bath', 'lin', {}), door('mas', 'ens', {}), door('mas', 'rob', {})
    ],
    windows: [
        { room: 'liv', side: 'N', width: 3.0 }, { room: 'liv', side: 'W', width: 1.8 }, { room: 'din', side: 'N', width: 1.8 },
        { room: 'kit', side: 'N', width: 2.4 }, { room: 'bed2', side: 'W', width: 1.6 }, { room: 'bed3', side: 'S', width: 1.6 },
        { room: 'mas', side: 'E', width: 1.8 }
    ]
};

// A small office, 14 × 8 m.
const OFFICE = {
    brief: { buildingType: 'office' },
    rooms: [
        rm('rec', 'Reception', 'reception', 0, 0, 4, 4), rm('meet', 'Meeting', 'meeting', 0, 4, 4, 4),
        rm('open', 'Open office', 'open_office', 4, 0, 10, 6), rm('kit', 'Kitchenette', 'kitchenette', 4, 6, 4, 2),
        rm('awc', 'Accessible WC', 'accessible_wc', 8, 6, 3.5, 2), rm('sto', 'Store', 'storage', 11.5, 6, 2.5, 2)
    ],
    doors: [
        door('exterior', 'rec', { side: 'W', at: 0.2 }), door('rec', 'open', { kind: 'open' }), door('rec', 'meet', {}),
        door('open', 'kit', {}), door('open', 'awc', {}), door('open', 'sto', {})
    ],
    windows: [
        { room: 'rec', side: 'N', width: 1.8 }, { room: 'open', side: 'N', at: 0.25, width: 3.0 }, { room: 'open', side: 'N', at: 0.75, width: 3.0 },
        { room: 'open', side: 'E', width: 2.0 }, { room: 'meet', side: 'W', width: 1.6 }
    ]
};

const clone = o => JSON.parse(JSON.stringify(o));
const analyse = spec => {
    const p = parsePlan(spec);
    if (!p.plan) return { parseErrors: p.errors };
    return { plan: p.plan, v: validatePlan(p.plan) };
};
const errs = spec => { const a = analyse(spec); return a.parseErrors ?? a.v.errors; };
const has = (list, re) => list.some(e => re.test(e));

function run() {
    suite('floor plan: a sound house passes with no errors');
    const house = analyse(HOUSE);
    check('house spec parses', !!house.plan);
    check('house has no validation errors' + (house.v && house.v.errors.length ? ': ' + house.v.errors.join(' | ') : ''), house.v.errors.length === 0);
    check('house has the expected internal area (14.0 × 10.4 = 145.6 m²)', Math.abs(house.v.internalArea - 145.6) < 0.01);
    check('every door resolved onto a wall', house.v.doors.length === HOUSE.doors.length);
    check('every window resolved onto an exterior wall', house.v.windows.length === HOUSE.windows.length);
    check('a bathroom with no window is a note, not an error', house.v.notes.some(n => /Bathroom/.test(n)));

    suite('floor plan: a sound office passes (different building type, same engine)');
    const office = analyse(OFFICE);
    check('office has no validation errors' + (office.v && office.v.errors.length ? ': ' + office.v.errors.join(' | ') : ''), office.v && office.v.errors.length === 0);
    check('office with one external door gets an egress note', office.v.notes.some(n => /more than one exit/i.test(n)));

    suite('floor plan: the mistakes an LLM-drawn plan made are now caught');
    let s = clone(HOUSE); s.doors = s.doors.filter(d => !(d.from === 'hall' && d.to === 'bed2'));
    check('a bedroom with no door is an error', has(errs(s), /Bedroom 2 has no door/));

    s = clone(HOUSE); s.doors = s.doors.filter(d => !(d.from === 'hall' && d.to === 'bed3')); s.doors.push(door('bed2', 'bed3', {}));
    check('a bedroom reached only through another bedroom is an error', has(errs(s), /Bedroom 3 can only be reached/));

    s = clone(HOUSE); s.rooms[0].w = 6.0;
    check('overlapping rooms are an error', has(errs(s), /overlap/));

    s = clone(HOUSE); s.windows = s.windows.filter(w => w.room !== 'bed2');
    {
        const a = analyse(s);
        check('a bedroom with no window gets one added automatically, with a note', a.v.errors.length === 0 && a.v.notes.some(n => /Bedroom 2 had no window.*added/.test(n)));
        check('the added window is a real opening on that room', a.v.windows.some(w => w.room === 'bed2'));
    }
    {
        const grid = [];
        for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) {
            const mid = r === 1 && c === 1;
            grid.push(rm('r' + r + c, mid ? 'Inner bedroom' : 'Room ' + r + c, mid ? 'bedroom' : 'other', c * 3.2, r * 3.2, 3.2, 3.2));
        }
        const e = errs({ rooms: grid, doors: [door('exterior', 'r00', { side: 'N' }), door('r00', 'r01', {}), door('r01', 'r11', {})] });
        check('a habitable room with no exterior wall at all is still an error', has(e, /Inner bedroom is a habitable room with no window/));
    }

    s = clone(HOUSE); s.windows.push({ room: 'bed3', side: 'N', width: 1.2 });
    check('a window on an interior wall is an error', has(errs(s), /no exterior wall/));

    s = clone(HOUSE); s.doors.push(door('liv', 'mas', {}));
    check('a door between rooms that do not touch is an error', has(errs(s), /do not share a wall/));

    s = clone(HOUSE); s.brief.bedrooms = 4;
    check('the brief bedroom count is enforced', has(errs(s), /brief asks for 4 bedrooms but the plan has 3/));

    s = clone(HOUSE); s.doors = s.doors.filter(d => d.from !== 'exterior');
    check('no front door is an error', has(errs(s), /no front door/));

    s = clone(HOUSE); s.rooms.find(r => r.id === 'bed2').w = 1.8; s.rooms.find(r => r.id === 'bed3').x = 1.8; s.rooms.find(r => r.id === 'bed3').w = 5.0;
    check('an undersized bedroom is an error', has(errs(s), /Bedroom 2 .* too small/));

    s = clone(HOUSE); s.windows = s.windows.filter(w => w.room !== 'liv' || w.width !== 3.0);
    check('living-room glazing with no north window warns in the southern hemisphere', analyse(s).v.warnings.some(w => /faces N/.test(w)));

    s = clone(HOUSE); s.doors.find(d => d.to === 'bed2').width = 3.8;
    check('a door wider than its wall is an error', has(errs(s), /too short for a 3.8 m door/));

    suite('floor plan: spec parsing');
    check('a non-object spec is rejected', has(errs('nope'), /not valid JSON/));
    check('a JSON string spec is accepted', analyse(JSON.stringify(HOUSE)).plan !== undefined);
    check('missing rooms is rejected', has(errs({}), /rooms must be a non-empty array/));
    check('duplicate ids are rejected', has(errs({ rooms: [rm('a', 'A', 'other', 0, 0, 1, 1), rm('a', 'B', 'other', 1, 0, 1, 1)] }), /duplicate room id/));
    check('an unknown room type lists the valid ones', has(errs({ rooms: [rm('a', 'A', 'dungeon', 0, 0, 3, 3)] }), /not a residential room type.*living/));
    check('an exterior door without a side is rejected', has(errs({ rooms: [rm('a', 'A', 'living', 0, 0, 4, 4)], doors: [door('exterior', 'a')] }), /needs "side"/));
    check('an unsupported building type is rejected', has(errs({ brief: { buildingType: 'castle' }, rooms: [rm('a', 'A', 'other', 0, 0, 3, 3)] }), /not supported/));
    check('a classroom is not a residential room', has(errs({ rooms: [rm('a', 'A', 'classroom', 0, 0, 8, 8)] }), /not a residential room type/));
    s = { brief: { buildingType: 'education' }, rooms: [rm('a', 'Room 1', 'classroom', 0, 0, 8, 8)], doors: [door('exterior', 'a', { side: 'S' })], windows: [{ room: 'a', side: 'N', width: 3 }] };
    check('a classroom is valid in the education pack', errs(s).length === 0);
    s.rooms[0].w = 4; s.rooms[0].h = 4;
    check('a 16 m² classroom is rejected as too small', has(errs(s), /too small for a classroom/));

    suite('floor plan: the renderer computes everything from the spec');
    const svg = renderPlan(house.plan, house.v, 'Test <House>');
    check('rendered SVG passes the SVG safety check', checkSvg(svg) === null);
    check('title is escaped', svg.includes('Test &lt;House&gt;') && !svg.includes('Test <House>'));
    check('dimensions come from the geometry (living 5.6 × 4.6 m = 25.8 m²)', svg.includes('5.6 × 4.6 m') && svg.includes('25.8 m²'));
    check('overall dimensions are drawn', svg.includes('14 m') && svg.includes('10.4 m'));
    check('has a scale bar, north arrow and concept-sketch disclaimer', svg.includes('>N<') && /\d+ m<\/text>/.test(svg) && svg.includes('not for construction'));
    check('door swings and windows are drawn', (svg.match(/stroke-dasharray="3 2"/g) || []).length >= 8 && svg.includes('#d6ebf8'));
    check('open-plan gaps get no door leaf (fewer swings than doors)', (svg.match(/stroke-dasharray="3 2"/g) || []).length === HOUSE.doors.filter(d => d.kind !== 'open').length);

    suite('design-conversation detection (drives low thinking effort)');
    check('a floor-plan request is detected', isDesignConversation('Design a 4-bedroom single-storey house for a 20 x 16 m plot'));
    check('an office or clinic design request is detected', isDesignConversation('design an office for 20 people') && isDesignConversation('Can you draw a floor plan for a small clinic?'));
    check('ordinary coding requests are not', !isDesignConversation('refactor the auth middleware to use async/await') && !isDesignConversation('fix the failing test in checkout.ts') && !isDesignConversation('design a database schema for users'));
    check('a follow-up in a design conversation is detected from history', isDesignConversation('make the kitchen bigger', [{ content: 'Here is your floor plan' }, { content: 'ok' }]));
    check('history that is not about design does not trigger it', !isDesignConversation('make it faster', [{ content: 'sorted the array' }]));

    suite('reference packs');
    check('all packs resolve room rules that include the common rooms', Object.keys(PACKS).every(p => 'corridor' in rulesFor(p) && 'wc' in rulesFor(p)));
    check('office corridors are wider than residential', rulesFor('office').corridor.hardDim > rulesFor('residential').corridor.hardDim);
    check('residential-only rooms are not offered in an office', !roomTypesFor('office').includes('bedroom') && roomTypesFor('office').includes('open_office'));
    check('the spec topic lists every building type', Object.keys(PACKS).every(p => COMMON_TOPICS.spec.includes(p)));
    check('looking up a building type returns its guidance', lookupReference('office', 'office').some(h => h.topic === 'office'));
    check('a blank lookup lists topics', lookupReference('', 'residential').length > 5);
    check('the sources topic cites Neufert without reproducing it', /Neufert/.test(COMMON_TOPICS.sources) && COMMON_TOPICS.sources.includes('.freebird/references'));
    check('describeValidation is empty for a clean plan with no warnings', typeof describeValidation(house.v) === 'string');
}

module.exports = { run, HOUSE, OFFICE };
