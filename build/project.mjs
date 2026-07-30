/**
 * viz-data.json → rebuilt.json — a PROJECTION, not a plan.
 *
 * This replaced `rebuild.mjs`, and the difference is the whole point.
 *
 * `rebuild.mjs` formed its own plan: it re-chained every day from the researched
 * durations (`start + dwell + travel + 8`), capped dwells at closing times and
 * parked whatever no longer fit. That was the right tool when Notion stored
 * hand-maintained start times that had drifted — the canvas had to work out what
 * the day would really look like, because nothing else could.
 *
 * Postgres does that now, and does it as the source of truth: `recalc()` chains
 * every day from `planned_dwell_min` into the trigger-guarded `schedule` table,
 * and only `recalc()` may write it. So a second chainer here is no longer a
 * safety net, it is a **second oracle** — and it had drifted into disagreeing
 * with the database on 35 of 37 days, by up to nine hours. The canvas was
 * showing a rework that was never applied while the app showed the real plan.
 *
 * So nothing here decides anything. Every clock time is copied from the snapshot,
 * which is `recalc()`'s output. What this file still does is ANNOTATE — the
 * researched advice, the closing-time overrun — because an annotation cannot
 * disagree with the plan it describes; it only says something about it.
 *
 * If a day looks wrong on the canvas now, the plan is wrong in Postgres. That is
 * the property worth having.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const V = JSON.parse(readFileSync(new URL('./viz-data.json', import.meta.url)));
const CLOSE = JSON.parse(readFileSync(new URL('./closing.json', import.meta.url)));
const RES = JSON.parse(readFileSync(new URL('./researched.json', import.meta.url)));

const tk = (t) => { const m = String(t || '').match(/(\d{1,2}):(\d{2})/); return m ? +m[1] * 60 + +m[2] : null; };
const normn = (x) => String(x || '').replace(/&amp;/g, '&').trim();

/**
 * Does this stop run past the hour its doors shut?
 *
 * REPORTED, NEVER APPLIED. `rebuild.mjs` used this to shorten the dwell, which
 * made the canvas's day diverge from the database's. Here it is a flag on a stop
 * whose length is whatever Postgres says it is — the same choice the app makes
 * for `opens_at`: state the conflict, let a person decide.
 */
function capOf(name, start, dwell) {
  const c = CLOSE[normn(name)];
  if (!c || !c.closes) return null;
  const closes = tk(c.closes);
  if (closes == null || start == null || dwell == null) return null;
  const clock = ((start % 1440) + 1440) % 1440;      // compare within the day it happens on
  const lastEntry = c.lastEntry ? tk(c.lastEntry) : null;
  const tooLate = lastEntry != null ? clock > lastEntry : clock >= closes;
  const over = clock + dwell - closes;
  if (over <= 0 && !tooLate) return null;
  return { closes: c.closes, lastEntry: c.lastEntry || null, lost: Math.max(0, over), tooLate, conf: c.conf || null };
}

/** The leg INTO a stop is the leg out of the one before it. */
function travelInto(prev) {
  if (!prev || prev.rec == null) return { mode: 'none', minutes: 0, km: null, est: false, coloc: false };
  const minutes = prev.rec === 'walk' ? prev.w : prev.rec === 'metro' ? prev.me : prev.dd;
  return {
    mode: prev.rec, minutes: minutes ?? 0, km: null,
    // Every leg on the page is a routed one now: they come out of the `leg` table,
    // which Google filled. The estimator that used to fill the gaps belonged to the
    // planner and went with it.
    est: false,
    coloc: minutes === 0,
  };
}

const days = {};
const ideasByDay = {};

for (const d of V) {
  const key = `${d.city}|${d.day}`;

  // Bonus stops ride along on the timeline but are not part of the chain, and the
  // hotel return is the day's end marker rather than a stop you spend time at.
  const stops = d.stops
    .filter((s) => s.abs != null && !s.home)
    .sort((a, b) => a.abs - b.abs)
    .map((s, i, arr) => ({
      name: s.name,
      icon: s.icon || null,
      s: s.abs,
      d: s.act ?? s.adv ?? 0,
      kind: s.hub ? 'hub' : s.meal ? 'meal' : 'sight',
      meal: s.meal,
      bonus: s.bonus || undefined,
      hub: s.hub,
      travelIn: travelInto(i === 0 ? null : arr[i - 1]),
      advice: s.res ?? RES[normn(s.name)]?.m ?? null,
      cap: capOf(s.name, s.abs, s.act),
    }));

  // The end of the day, as a row rather than only a chip on the bar.
  //
  // Kept OUT of `stops` on purpose. `stops` is the set the agrees-with-Postgres gate
  // walks, and its contract is that every entry is a row in the database — the hotel
  // return is not one, it is derived by the app's builder from "where do you sleep
  // tonight". Putting it in that array would have made the gate report a phantom stop
  // on 35 days, or forced it to learn an exception, and an exception in the one check
  // that keeps this page honest is a bad trade for a table row.
  const homeSrc = d.stops.find((s) => s.home);
  const homeStop = homeSrc
    ? {
        name: homeSrc.name,
        icon: homeSrc.icon || 'hotel',
        pid: homeSrc.pid || null,
        s: homeSrc.abs ?? d.endMin,
        // arriving home is not a dwell — the day simply ends here
        d: 0,
        // where the hotel is, so the last row of the table can be a pin like every
        // other row: the day ends somewhere, and "where am I sleeping relative to
        // all this?" is a fair question to ask of the map
        lat: homeSrc.lat ?? null,
        lng: homeSrc.lng ?? null,
        travelIn: d.home ? { mode: d.homeMode, minutes: d.homeMin, km: d.homeKm, est: false, coloc: false } : null,
      }
    : null;

  days[key] = {
    city: d.city,
    day: d.day,
    date: d.date,
    homeStop,
    // The day's own theme, from Postgres. `rebuild.mjs` also carried a `why`
    // paragraph written by the city curators to justify ITS arrangement — printing
    // that above a different day's times would explain a plan nobody is looking at.
    theme: d.theme,
    why: null,
    endMin: d.endMin,
    homeTravel: d.home ? { mode: d.homeMode, minutes: d.homeMin, km: d.homeKm, estimated: false } : null,
    // A day misses a locked departure when the chain puts a stop somewhere it
    // cannot be — which is exactly what the app's own feasibility check reports,
    // so it is read from there rather than recomputed.
    missed: (() => {
      const bad = d.stops.find((s) => s.impossible);
      if (!bad) return null;
      const hub = d.stops.find((s) => s.hub?.role === 'depart');
      return { name: bad.name, beThereBy: hub?.hub?.beThereBy ?? '—', reason: bad.impossible };
    })(),
    absorbed: null,
    mealsDecided: d.mealsDecided || { lunch: null, dinner: null },
    stops,
  };

  // Carry the idea's IDENTITY through, not just its label. `id` is what /api/meal
  // needs as a placeId and `meals` is which slots the catalogue thinks it suits —
  // without them the canvas can list a restaurant but not offer to use it, which is
  // the difference between a report and a tool.
  if (d.ideas?.length) ideasByDay[key] = d.ideas.map((i) => ({
    name: i.name, icon: i.icon || null, why: i.kind, res: i.res,
    id: i.id || null, meals: i.meals || [], kind: i.kind, full: i.full || i.name,
    booking: i.booking || null,
    lat: i.lat ?? null, lng: i.lng ?? null,
  }));
}

// `movesByDay` listed stops the planner shifted between days. Nothing moves stops
// now except a person, in the app, so there is nothing to list.
const out = { days, ideasByDay, movesByDay: {}, notes: {} };
writeFileSync(new URL('./rebuilt.json', import.meta.url), JSON.stringify(out));

const ends = Object.values(days).map((x) => x.endMin);
const late = ends.filter((m) => m > 21 * 60 + 30).length;
const past = ends.filter((m) => m >= 1440).length;
const hhmm = (m) => `${String(Math.floor(((m % 1440) + 1440) % 1440 / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}${m >= 1440 ? '⁺¹' : ''}`;
console.log(`projected ${Object.keys(days).length} days straight from the snapshot — no re-chaining`);
console.log(`  home after 21:30: ${late} · after midnight: ${past} · latest ${hhmm(Math.max(...ends))}`);
console.log(`  capped by closing time: ${Object.values(days).flatMap((x) => x.stops).filter((s) => s.cap).length} stops`);
console.log(`  misses a locked departure: ${Object.values(days).filter((x) => x.missed).length} days`);
