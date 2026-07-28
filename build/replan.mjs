// Re-times EVERY day of the itinerary, writing build/replanned.json.
//
// TWO STANDING RULES (both learned the hard way):
//
//   NEVER REMOVE ANYTHING. Every stop stays on the timeline, always. Cutting is the traveller's
//   decision, never the planner's. Our job is to plot the day honestly — if it runs to 26:31,
//   that is the finding, not something to hide by quietly deleting stops.
//
//   NEVER REORDER. The given sequence encodes geography and physical dependency that the data
//   does not spell out — e.g. Beijing d3's "Toboggan down" IS the descent from Mutianyu Great
//   Wall, so it cannot be shuffled next to CCTV in the city centre. An earlier version moved
//   evening stops into daytime gaps and produced exactly that nonsense. Reordering is a human
//   call, made per day during review (and recorded by hand in proposals.json).
//
// What this pass DOES do, mechanically and safely:
//   1. Durations  → the researched "suggested" time (fallback: our by-type default).
//   2. Meals      → snap to their window, never to a time they drifted to on an overflowing day.
//   3. Anchors    → shows/flights hold their clock time, but only if that time is believable.
//   4. Reports    → the honest home-arrival time, plus which stops COULD move to daytime — as a
//                   suggestion for the review, never applied automatically.
import { readFileSync, writeFileSync } from 'node:fs';
import { hhmm, tkc } from './lib-plan.mjs';

const DATA = JSON.parse(readFileSync(new URL('./viz-data.json', import.meta.url)));
const TARGET = 21 * 60 + 30;        // home-by goal
const EVENING = 18 * 60 + 30;       // "in the evening" threshold
const LATEST_REAL_ANCHOR = 22 * 60; // past this, a "fixed" time is overflow noise, not a real showtime
const MEAL_WINDOW = { breakfast: [7 * 60, 8 * 60 + 30], lunch: [12 * 60, 14 * 60], dinner: [18 * 60 + 30, 20 * 60] };

const dur = st => st.res ?? st.adv ?? st.act ?? 30;
const legOut = st => {              // travel leaving this stop, in its recommended mode
  const m = st.rec === 'walk' ? st.w : st.rec === 'metro' ? st.me : st.rec === 'didi' ? st.dd : null;
  return m ?? st.dd ?? st.me ?? st.w ?? 20;
};
const isFixed = st => !!st.hub || st.ptype === 'Transport' || st.ptype === 'Show' || st.night === 'show';
const isAltVenue = st => st.ptype === 'Food' && !st.meal;   // shortlist venue, kept but flagged

const out = {};
let over = 0, fits = 0, suggestions = 0;

for (const day of DATA) {
  const stops = (day.stops || []).filter(s => !s.home && s.t && !s.bonus);
  if (stops.length < 2) continue;

  // forward-schedule in the ORIGINAL order — nothing added, nothing removed, nothing moved
  let clock = stops[0].abs ?? tkc(stops[0].t), conflict = null;
  const hubMiss = [];   // locked departures/arrivals the plan cannot honour
  // Per the chain rule: a check-in deadline OVERRIDES the meal floors. Beijing d5's 05:39
  // breakfast is not a mistake — it is what making the 07:40 Daxing check-in costs.
  const hasDeadline = stops.some(x => x.hub && x.hub.role === 'depart');
  const plan = [];
  const seenMeal = new Set();
  for (const st of stops) {
    const d = st.hub ? (st.hub.dwell ?? dur(st)) : dur(st);
    const anchor = st.abs ?? tkc(st.t);
    let start = clock;
    const realMeal = st.meal && !seenMeal.has(st.meal);
    if (st.hub) {
      // A hub is physical fact, not preference: you cannot land early or check in late.
      // It always holds its clock time — including a red-eye whose check-in falls after 22:00,
      // which the overflow-noise rule below would otherwise discard.
      if (anchor > start) start = anchor;
      else {
        if (start - anchor > 10) hubMiss.push(`${st.name}: ${st.hub.role === 'depart'
          ? `must be there ${st.hub.beThereBy}, plan arrives ${hhmm(start)}` : `lands ${st.hub.arriveTime}`} (${start - anchor}m late)`);
        start = anchor;
      }
    }
    else if (realMeal) { seenMeal.add(st.meal); if (!hasDeadline) start = Math.max(start, MEAL_WINDOW[st.meal][0]); }
    else if (isFixed(st) && anchor != null && anchor <= LATEST_REAL_ANCHOR) {
      if (anchor > start) start = anchor;
      else if (start - anchor > 10) conflict = st.name;
    }
    plan.push({ s: start, d, st });
    clock = start + d + legOut(st);
  }

  const last = plan[plan.length - 1];
  const endMin = last.s + last.d + (day.home ? (day.homeMin ?? 0) : 0);
  const overBy = endMin > TARGET ? endMin - TARGET : 0;
  overBy ? over++ : fits++;

  // advisory only — what a human could choose to move or drop to bring the day back
  const couldMove = stops.filter(st => st.night === 'any' && !st.meal && !isFixed(st)
    && tkc(st.t) != null && tkc(st.t) >= EVENING).map(st => st.name);
  const altVenues = stops.filter(isAltVenue).map(st => st.name);
  suggestions += couldMove.length + altVenues.length;

  const bits = ['retimed to suggested durations'];
  if (hubMiss.length) bits.push(`${hubMiss.length} locked ${hubMiss.length > 1 ? 'deadlines' : 'deadline'} MISSED`);
  if (overBy) bits.push(`${Math.floor(overBy / 60)}h${String(overBy % 60).padStart(2, '0')} over — your call what gives`);

  out[`${day.city}|${day.day}`] = {
    status: 'proposed', generated: true,
    conflict: conflict || undefined,
    hubMiss: hubMiss.length ? hubMiss : undefined,
    needsDecision: overBy ? true : undefined,
    overBy: overBy || undefined,
    couldMove: couldMove.length ? couldMove : undefined,
    altVenues: altVenues.length ? altVenues : undefined,
    title: bits.join(' · '),
    homeNew: endMin >= 1440 ? hhmm(endMin) + ' +1' : hhmm(endMin),
    newEndMin: endMin,
    new: plan.map(p => ({
      s: p.s, d: p.d, label: p.st.name,
      kind: p.st.meal ? 'meal' : isFixed(p.st) ? 'log' : 'sight',
    })),
  };
}

writeFileSync(new URL('./replanned.json', import.meta.url), JSON.stringify(out, null, 1));
console.log(`retimed ${Object.keys(out).length} days · nothing removed, nothing reordered · ${fits} home by 21:30 · ${over} over · ${suggestions} suggestions raised for review`);
