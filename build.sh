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
node build/replan.mjs
node build/generate-canvas.mjs
node build/generate-timetable.mjs
# The Notion propagation workbook is derived from the same rebuilt plan the canvas renders,
# so the two can never disagree about what we agreed.
node build/generate-notion-sync.mjs
../venv/bin/python build/build-notion-xlsx.py
cp build/china-day-load.html index.html
echo "Rebuilt index.html. Now:  git add -A && git commit -m update && git push   → live in ~1 min at https://lexiz.github.io/china-itinerary-analysis/"
