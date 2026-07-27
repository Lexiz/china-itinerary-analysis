#!/bin/bash
# Rebuild the analysis page from the CURRENT itinerary snapshot, then commit & push to update the live page.
# Prereq: refresh the app snapshot from Notion first (in the app dir: `npm run sync`).
set -e
cd "$(dirname "$0")"
node build/generate-vizdata.mjs
node build/generate-canvas.mjs
cp build/china-day-load.html index.html
echo "Rebuilt index.html. Now:  git add -A && git commit -m update && git push   → live in ~1 min at https://lexiz.github.io/china-itinerary-analysis/"
