# Floor-plan eval

A fixed set of briefs, run through the real agent loop against the live backend and scored, so a change to prompts, rules or models can be judged by numbers and not by looking at one plan.

## Run it

```
npm run compile
FB_KEY=<licence key> npm run eval:plans -- --model fast            # cheap, no Pro allowance
FB_KEY=<licence key> npm run eval:plans -- --model pro --only house-3bed,gp-clinic
```

| Flag | Meaning |
|---|---|
| `--model pro` (default) | The product path: Sonnet at low effort. Spends the licence's monthly Pro allowance — roughly 8 requests per brief. |
| `--model fast` | The Haiku path. No Pro allowance. Much less reliable at this task, so useful as a floor and for cheap iteration on the validator. |
| `--only a,b` | Run just these brief ids. |
| `--repeat N` | Run each brief N times. Models are noisy; use this before deciding anything. |
| `--timeout S` | Per-brief limit (default 300 s). |
| `--out file` | Where to write the JSON (default `eval/floorplan/results/`, git-ignored). |

`FB_KEY` is used for the run only and is never written to disk.

## What is scored

For every brief the runner re-reads the plan the run saved and re-validates it with the same validator the tool uses, so the score does not depend on what the model claims.

- **PASS** — the saved plan has no validation errors *and* meets the brief (bedroom count, required room types, room counts, internal area range, building type).
- **WEAK** — the plan is valid but misses the brief (for example 3 bedrooms when 4 were asked for).
- **FAIL** — no valid plan within the timeout.

Also recorded: seconds to the first valid plan, model requests, plans submitted and rejected, validator warnings on the final plan, and the rooms and area. The summary gives the pass rate, valid rate and means.

## Compare two runs

```
node eval/floorplan/compare.js before.json after.json
```

A single run per brief is a weak signal. Use `--repeat 3` or more for decisions, and keep the briefs the same between runs you compare.

## Adding briefs

Edit `briefs.json`. Each entry is `{ id, prompt, expect }`, where `expect` can hold:

- `buildingType` — one of the building-type packs (`residential`, `office`, `education`, `healthcare`, `retail`, `hotel`).
- `bedrooms` — exact count of `bedroom` + `master_bedroom` rooms.
- `roomCounts` — exact counts by room type, e.g. `{ "classroom": 4 }`.
- `mustInclude` — room types that must appear at least once.
- `area` — `[min, max]` internal floor area in m².

The test suite checks that every brief names a supported building type and real room types, so typos are caught before a costly run.

## Limits

- It measures *validity against the brief and the validator's rules*, not design quality. A plan can pass and still be mediocre; the warnings count and your own eye remain part of the judgement.
- It cannot see the rendered image or judge aesthetics.
- Runs hit the production backend and the Anthropic models, so results vary day to day.
