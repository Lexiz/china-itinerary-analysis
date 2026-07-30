# China Itinerary Analysis

Live: **https://lexiz.github.io/china-itinerary-analysis/**

A self-contained review canvas — "How late each day really ends". One time-bar per day
(to hotel arrival); unfold any day for a per-activity table, the researched advice, the
travel legs and a route map. No build framework, no external assets: `index.html` opens
from a `file://` URL.

## Direction of truth

This matters more than anything else in the repo, because it has now been got wrong twice —
in opposite directions.

```
Postgres  ──recalc()──▶  schedule  ──npm run sync──▶  snapshot.json
                                                            │
                                          viz-data.json ◀────┘
                                                │
                                         rebuilt.json  ──▶  index.html / timetable.csv
```

**Postgres is the source of truth.** Everything on this page is a rendering of it. The app
(`china-trip-app`) edits it directly; this repo only reads.

**Nothing here forms a plan.** `project.mjs` copies clock times out of the snapshot — which are
`recalc()`'s output, written into the trigger-guarded `schedule` table that only `recalc()` may
write. If a day looks wrong on this page, the plan is wrong in the database, and that is the
property worth having.

### The two failures this rule exists to prevent

**First, circularity.** The canvas was built to read a *pre-review* snapshot and propose a plan.
Once that plan was written back, input became output: `replan.mjs` re-chained days that were
already chained and printed Chengdu d3 as 46:03 above rows correctly reading 22:11.

**Then, a second oracle.** `rebuild.mjs` replaced it — and it too formed a plan, re-chaining all
37 days from the researched durations, capping dwells at closing times and parking whatever no
longer fit. That was the right tool while Notion held hand-maintained start times. It stopped
being right the moment Postgres began chaining them properly, and nothing said so: **the page
disagreed with the database on 35 of 37 days, by up to nine hours** — showing a rework that was
never applied, while the app showed the real plan. The page looked authoritative and described a
plan that did not exist.

`rebuild.mjs` is gone. `project.mjs` cannot drift by construction, and
**`build/check-against-db.mjs` proves it against the live database** — every stop's start time,
in both directions. Run it whenever the page changes:

```bash
DATABASE_URL=… npm run check
```

### What each stage is allowed to do

| Stage | May | May not |
| --- | --- | --- |
| `generate-vizdata.mjs` | describe the snapshot — times, coordinates, travel legs, researched advice, the day's ideas | form any verdict |
| `project.mjs` | reshape it for the renderer; **annotate** (advice, closing-time overrun) | change a single clock time |
| `generate-canvas.mjs` | form the late/fits verdict **once**, in `verdict()` | consult a second source |

Annotations are safe where a plan is not: an annotation says something *about* the times, so it
cannot contradict them. The closing-time flag is the example — it used to shorten a stop, which
changed the plan; now it reports that the stop runs past closing and leaves the decision to a
person. That is the same choice the app makes for "you arrive 08:40, it opens at 09:00".

Retired, deliberately (do not reintroduce):

| Gone | Why |
| --- | --- |
| `replan.mjs` / `replanned.json` | the circular second opinion |
| `rebuild.mjs` / `build/rebuild/` | the second oracle — see above |
| `proposals.json` | hand-agreed overrides on top of a second opinion |
| the `FIX` advice table | pre-review advice; the review happened |
| `split-days.json` | fixed at the source — the transit date now yields two real day records |
| `generate-notion-sync.mjs`, `build-notion-xlsx.py` | "what must I change in Notion?" — there is nothing to propagate to; Notion was decommissioned 29 Jul 2026 |

## The plan as it stands

As of the 30 Jul 2026 re-plan: **27 days home by 21:30 · 10 later, each with a stated cause ·
0 missed departures.** The latest finish is the Shanghai red-eye itself, which is a flight, not
an over-packed day. (The live numbers are in the page header — the build prints them and the
gate checks them against Postgres, so if this paragraph ever disagrees with the page, the page
is the one to trust.)

## Update it

1. In the app repo, refresh the snapshot from Postgres: `npm run sync`.
2. Here: `./build.sh`.
3. `DATABASE_URL=… npm run check` — the page must agree with the database.
4. `git add -A && git commit -m "update analysis" && git push` — live in ~1 min.

## What's in build/

- `generate-vizdata.mjs` — app snapshot → `viz-data.json` (descriptive only)
- `project.mjs` — `viz-data.json` → `rebuilt.json`, the renderer's shape, no re-chaining
- `generate-canvas.mjs` — `rebuilt.json` + `viz-data.json` + `canvas-style.html` → the page
- `check-against-db.mjs` — the gate: does the page agree with Postgres?
- `generate-timetable.mjs` — the same plan as CSV
- `researched.json` / `research2/*.json` — 187 researched real-world visit durations
- `closing.json` — structured closing times, for the overrun annotation
- `night.json`, `coords.json` — night classification, hand-corrected coordinates

Assumes the app snapshot at `~/ClaudeCode/sandbox/China/app/data/snapshot.json`.

## This repo is public

`index.html` embeds the Maps JS key on purpose — key `5046dd22`, restricted by HTTP referrer to
`lexiz.github.io` and localhost and to `maps-backend` only. Copied anywhere else it is inert;
that restriction, not secrecy, is what protects it. The server-side key (`7372a1ce`,
geocode/routes/places) has **no** referrer restriction — a server sends no referrer — so it must
**never** appear here. `build/gmaps-key.txt` is gitignored. Before pushing, check the **commit
range**, not just the working tree — that distinction is what leaked a key once already.

There was a `PUBLISH=1 ./build.sh` that blanked the key for the public build, left from when a
single unrestricted key did both jobs. It outlived its reason, and on 30 Jul 2026 a stale comment
in `generate-canvas.mjs` still recommended it: the flag was used, and the published page carried
37 days of tables with every per-day map replaced by "route map hidden" — for no security gain,
because the committed key was the restricted one the whole time. The flag is gone. **This file was
correct while that comment was wrong**, so if the two ever disagree again, verify against
`gcloud services api-keys list` rather than believing either.

`node_modules/` is gitignored too. The page has no dependencies; the manifest exists only so
`check-against-db.mjs` has a Postgres driver.
