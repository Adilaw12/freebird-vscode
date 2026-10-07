# Architecture design tools — references and extending them

Freebird's `create_floor_plan` tool turns a structured spec into a validated, deterministically drawn plan, and `architecture_reference` serves design guidance to the model. This page explains where the guidance comes from and how to add to it.

## How it fits together

| Piece | File | Job |
|---|---|---|
| Reference packs | `src/architecture/reference.ts` | Room types, size limits, circulation limits and guidance text, one pack per building type |
| Spec + validator | `src/architecture/plan.ts` | Parses the model's JSON spec and reviews it: reachability, windows, sizes, brief |
| Renderer | `src/architecture/render.ts` | Draws the plan from the spec — dimensions are computed, never typed by the model |
| Tools | `src/agent/tools.ts` | `create_floor_plan`, `architecture_reference`, and the existing `create_drawing` |

Supported building types today: `residential` (most developed), and **starter** packs for `office`, `education`, `healthcare`, `retail`, `hotel`. Starter packs carry conservative minimums and a few key rules; deepen them as real use shows what is missing.

## Provenance and licensing

All figures in `reference.ts` are generally published rules of thumb or widely cited code figures, **restated in our own words**. Nothing is copied from Neufert's *Architects' Data*, the *Metric Handbook*, *Architectural Graphic Standards* or any other copyrighted work, and none of their tables are reproduced. They are cited as places to look — Neufert in particular covers almost every building type.

The numbers are guideline defaults. They vary by jurisdiction and are **not** a substitute for the local building code, fire engineering or a licensed designer. The tool tells the model to describe its output as a concept sketch.

## Adding your own reference material

Users who own or are licensed to keep reference material (for example notes from Neufert for an office, school or clinic) can drop `.md` or `.txt` files into:

```
<workspace>/.freebird/references/
```

`architecture_reference` searches them by keyword and by file name, so name files after the topic or building type (`office-layouts.md`, `school-classroom-sizes.txt`). Files over 200 KB are skipped, and the folder honours the usual ignore rules. This material stays on the user's machine and in their workspace; Freebird does not redistribute it.

## Adding a building type

1. In `reference.ts`, add a `BuildingPack`: its room types (`hardArea`, `hardDim`, `softArea`, `softDim`, plus flags), a `circulationMax`, optional `overrides` for common rooms (wider corridors), and `topics` (guidance text).
2. Register it in `PACKS`.
3. Add cases to `test/floorplan.test.js` — a known-good plan and one that must fail.

Room flags that drive the validator:

- `habitable` — needs a window on an exterior wall.
- `transit` — may be walked through to reach other rooms (hall, open office, foyer). Rooms without it are private leaves (bedroom, classroom, consult room).
- `dependent` — reached from a parent room (ensuite, robe, store).
- `circulation` — counts toward the circulation share.
- `outdoor` — not roofed; excluded from internal area and window rules.

## What the validator does not check

Fire egress and travel distances, structural validity, plumbing and services, planning-scheme setbacks, and accessibility compliance. For public and commercial types it adds a note reminding the model and the user to involve a fire designer. Treat every plan as a concept sketch.
