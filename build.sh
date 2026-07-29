#!/bin/bash
# Rebuild the analysis page from the CURRENT itinerary snapshot, then commit & push to update the live page.
# Prereq: refresh the app snapshot from Notion first (in the app dir: `npm run sync`).
set -e
cd "$(dirname "$0")"
node build/generate-vizdata.mjs
# Re-chain the committed plan. This MUST sit after generate-vizdata and before the canvas: rebuild
# reads viz-data (which carries the researched durations), so running it by hand beforehand silently
# chains the day against stale advice — a CCTV bumped 30→60 min simply didn't appear.
node build/rebuild.mjs
# replan.mjs used to run here. It re-chained every day from the snapshot to produce a second opinion
# — which was fine while the snapshot was the pre-review plan, and became circular the moment the
# reviewed plan was written back to Notion. rebuild.mjs is the only thing that forms a plan now.
node build/generate-canvas.mjs
node build/generate-timetable.mjs
# The Notion propagation workbook is derived from the same rebuilt plan the canvas renders,
# so the two can never disagree about what we agreed.
node build/generate-notion-sync.mjs
../venv/bin/python build/build-notion-xlsx.py
cp build/china-day-load.html index.html
# ../canvas/index.html is what the local no-cache server on :8210 serves. It used to be copied by
# hand, so the page under review could be an older build than the one being published — one more
# way for two versions of the truth to exist at once.
mkdir -p ../canvas && cp build/china-day-load.html ../canvas/index.html
echo "Rebuilt index.html (and the :8210 review copy). Now:  git add -A && git commit -m update && git push   → live in ~1 min at https://lexiz.github.io/china-itinerary-analysis/"
