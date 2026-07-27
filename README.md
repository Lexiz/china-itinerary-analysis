# China Itinerary Analysis

Live: **https://lexiz.github.io/china-itinerary-analysis/**

A self-contained review canvas — "How late each day really ends". One time-bar per day
(to hotel arrival); unfold any day for a per-activity table (Start · End · Default ·
Suggested[researched] · Actual · Travel). No build framework, no external assets.

## Update it
1. In the app repo, refresh the itinerary snapshot from Notion: `npm run sync`.
2. Here: `./build.sh` (regenerates `index.html` from the snapshot + researched durations).
3. `git add -A && git commit -m "update analysis" && git push` — live in ~1 min.

## What's in build/
- `generate-vizdata.mjs` — reads the app snapshot → `viz-data.json`
- `generate-canvas.mjs` — `viz-data.json` + `canvas-style.html` + `researched.json` → the page
- `researched.json` / `research/*.json` — 181 real-world visit durations (10-agent research)
- `venues-by-city.json` — the venue list that seeded the research

Assumes the app snapshot at `~/ClaudeCode/sandbox/China/app/data/snapshot.json`.
