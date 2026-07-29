# China Itinerary Analysis

Live: **https://lexiz.github.io/china-itinerary-analysis/**

A self-contained review canvas — "How late each day really ends". One time-bar per day
(to hotel arrival); unfold any day for a per-activity table (Start · End · Default ·
Suggested[researched] · Actual · Travel). No build framework, no external assets.

## Direction of truth

This matters more than anything else in the repo, because for a while it was circular and the
page started disagreeing with itself.

```
Notion  ──sync──▶  snapshot.json  ──▶  viz-data.json  ──▶  rebuilt.json  ──▶  canvas / CSV / xlsx
  ▲                                                                                    │
  └──────────────────── scripts/apply-plan.mjs (deliberate, reviewed) ◀────────────────┘
```

**Notion is the source of truth.** Everything downstream is a read-only view of it.

**The canvas is a view plus an editing workspace.** It never writes to Notion on its own. When a
review pass produces changes, they go back through `scripts/apply-plan.mjs` (in the app repo) as a
deliberate, reviewed act — never as a side effect of a build.

**The canvas must never re-derive what it already wrote.** This is the rule that was broken. The
canvas was built to read a *pre-review* snapshot and propose a plan. Once that plan was applied to
Notion, the input became the output, and every pass that "recomputed" the day was re-deriving
already-derived times. `replan.mjs` chained each day forward from the snapshot a second time and
read Chengdu d3 as 46:03 and Fenghuang d1 as 33:26 — while the rows directly underneath, drawn
from `rebuilt.json`, correctly said 22:11 and 23:01. The header cards were driven by the first
number and the rows by the second.

So there is now exactly one plan and exactly one verdict:

- **`viz-data.json` is descriptive.** It reports what the snapshot says — times, coordinates,
  researched durations, travel legs. It forms no opinion. It carries no `flagged`, no `sev`, no
  advice table. Its `endMin` is the literal last clock in the Notion day record, which on
  Fenghuang d1 is next morning's departure shuttle; it is a fact, not a judgement.
- **`rebuilt.json` is the committed plan.** `rebuild.mjs` is the only thing that decides what a
  day looks like.
- **`generate-canvas.mjs` forms the verdict once**, in `verdict()`, and reads `rebuilt.json` to do
  it. Header cards, city counts, the bad-only filter, the row badge, the bar's end marker and the
  bar's tooltip all resolve through that one function. If they ever disagree again, it is because
  something started consulting a second oracle — don't add one.
- **`timetable.csv`, `china-notion-sync.xlsx` and the canvas** are three renderings of
  `rebuilt.json`, so they cannot disagree about what was agreed.

Retired, deliberately (do not reintroduce):

| Gone | Why |
| --- | --- |
| `replan.mjs` / `replanned.json` | The second opinion. Circular once the plan was in Notion. |
| `proposals.json` | Hand-agreed overrides on top of that second opinion. |
| the `FIX` advice table | Pre-review advice ("3 museums too many"). The review happened; the outcome is `rebuilt.json`. |
| `split-days.json` | Notion filed a whole transit date under the destination city, hiding the origin-city morning. Fixed at the source — moving the Zhujiang Wharf transfer to Guilin means Notion now yields **Guilin d2** (breakfast 05:39 + the 07:00 wharf call) and **Yangshuo d1** as two real day records. The pass had already stopped matching and was warning instead of splitting. |

The current state of the plan: **26 days home by 21:30, 11 later and reviewed & accepted, 0 missed
departures, 0 missed showtimes, 2 capped stops** (Hongya Cave, Golden Whip Stream). The latest
finish is Shanghai d6 at 02:10⁺¹ — that is a red-eye airport call, not an over-packed day.

## Update it
1. In the app repo, refresh the itinerary snapshot from Notion: `npm run sync`.
2. Here: `./build.sh` (regenerates `index.html`, the `:8210` review copy, the CSV and the workbook).
3. `git add -A && git commit -m "update analysis" && git push` — live in ~1 min.

## What's in build/
- `generate-vizdata.mjs` — reads the app snapshot → `viz-data.json` (descriptive only)
- `rebuild.mjs` — `viz-data.json` → `rebuilt.json`, the committed plan
- `generate-canvas.mjs` — `rebuilt.json` + `viz-data.json` + `canvas-style.html` → the page
- `generate-timetable.mjs` / `generate-notion-sync.mjs` / `build-notion-xlsx.py` — the same plan as
  CSV and as the Notion propagation workbook
- `researched.json` / `research/*.json` — 181 real-world visit durations (10-agent research)
- `venues-by-city.json` — the venue list that seeded the research

Assumes the app snapshot at `~/ClaudeCode/sandbox/China/app/data/snapshot.json`.

## This repo is public
`index.html` embeds the Maps JS key on purpose — it is key `5046dd22`, restricted by HTTP referrer
to `lexiz.github.io` and localhost. The server-side key (`7372a1ce`, geocode/directions/routes) must
**never** appear here. `build/gmaps-key.txt` is gitignored. `PUBLISH=1 ./build.sh` omits the key
entirely. Before pushing, check the **commit range**, not just the working tree — that distinction
is what leaked a key once already.
