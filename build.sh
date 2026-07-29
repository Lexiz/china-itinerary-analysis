#!/bin/bash
# Rebuild the analysis page from the CURRENT plan, then commit & push to update the live page.
#
# Prereq: refresh the app snapshot from POSTGRES first — in the app repo, `npm run sync`.
# (This used to say "from Notion". Notion was decommissioned on 29 Jul 2026; the app builds
# its snapshot from Supabase Postgres and has no other source.)
set -e
cd "$(dirname "$0")"

# 1. The snapshot, described. Times, coordinates, travel legs, researched advice, the day's
#    ideas. Forms no opinion.
node build/generate-vizdata.mjs

# 2. Project that into the shape the page renders. NOT a plan — every clock time is copied
#    from the snapshot, which is recalc()'s output in the database.
#
#    `rebuild.mjs` used to sit here and re-chain all 37 days itself. That was the right tool
#    while Notion held hand-maintained start times, and became a second oracle the moment
#    Postgres began chaining them properly: it had drifted into disagreeing with the database
#    on 35 of 37 days, by up to nine hours, so the canvas was showing a rework that was never
#    applied while the app showed the real plan. One oracle now, and it is the database.
node build/project.mjs

# 3. The page.
node build/generate-canvas.mjs

# 4. The same plan as a spreadsheet.
node build/generate-timetable.mjs

# generate-notion-sync.mjs + build-notion-xlsx.py used to run here, producing
# china-notion-sync.xlsx — "what do I have to change in Notion, per place, to make it match
# the plan?". There is nothing to propagate to any more: the app edits Postgres directly.

# 5. The gate: the page must agree with the database. Skipped (loudly) without a DATABASE_URL,
#    because a check that silently does nothing is worse than no check.
if [ -n "$DATABASE_URL" ]; then
  node build/check-against-db.mjs
else
  echo "!! DATABASE_URL not set — skipping the agrees-with-Postgres check"
fi

cp build/china-day-load.html index.html
# ../canvas/index.html was the local no-cache review copy, from when this repo lived in a
# scratchpad beside a served directory. It is its own checkout now, so index.html IS the copy
# under review — one less way for two versions to exist at once.
echo "Rebuilt index.html. Now:  git add -A && git commit -m update && git push   → live in ~1 min at https://lexiz.github.io/china-itinerary-analysis/"
