// Phase 2 of the rework: turn each city curator's ordered stop list into a real, timed day.
//
// The curators decide WHAT and IN WHAT ORDER. This file decides WHEN, deterministically:
//
//   start(next) = start(prev) + dwell(prev) + travel(prev→next) + SLACK
//
// with these non-negotiables:
//   - a HUB (flight/ferry/train) holds its clock time and occupies its full buffer
//   - an arrival hub opens the day; nothing may precede it
//   - a departure hub closes the day; the chain is shifted BODILY EARLIER if it would miss check-in
//   - dwell = the researched advice minutes (a ceiling, never padded)
//   - same-building steps (hotel breakfast, bag drop) cost ZERO travel
//   - meals sit in their window unless a check-in deadline overrides them
//
// Output: build/rebuilt.json — the new committed plan, plus each city's deprioritised ideas.
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { travel, km, SAME_PLACE_KM } from './lib-travel.mjs';

const V = JSON.parse(readFileSync(new URL('./viz-data.json', import.meta.url)));
const SNAP = JSON.parse(readFileSync('/Users/alexlisitzky/ClaudeCode/sandbox/China/app/data/snapshot.json', 'utf8'));
const RES = JSON.parse(readFileSync(new URL('./researched.json', import.meta.url)));
const CLOSE = JSON.parse(readFileSync(new URL('./closing.json', import.meta.url)));
const COORDS = JSON.parse(readFileSync(new URL('./coords.json', import.meta.url)));
const ZERO = new Set(JSON.parse(readFileSync(new URL('./zero-legs.json', import.meta.url))).legs.map(l => `${l.from}|${l.to}`));

const SLACK = 8;
// Default meal windows = "not before". A day may override them in rebuild/<city>.json via
// `mealWindows`, which is how a day buys an early start or an early dinner to catch a closing
// time or a sunset — rather than the times being a fixed convention the plan has to fight.
const MEAL_WIN = { breakfast: 7 * 60, lunch: 12 * 60, dinner: 18 * 60 };
// Fallback only. A meal's real length is the researched advice for it (35/60/90), read through
// dwellOf like every other stop — hard-coding 45 for breakfast was the one place the plan
// contradicted its own Advice column, and it cost 10 min at the front of every single day.
const MEAL_DUR = { breakfast: 45, lunch: 60, dinner: 90 };
const hhmm = m => `${String(Math.floor(((m % 1440) + 1440) % 1440 / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const tkc = t => { const m = String(t || '').match(/(\d{1,2}):(\d{2})/); return m ? (+m[1]) * 60 + (+m[2]) : null; };
const hubAnchor = st => tkc(st.hub.role === 'depart' ? st.hub.beThereBy : st.hub.arriveTime) ?? st.abs ?? 0;
const DAY_START = 8 * 60, DAWN_START = 5 * 60 + 30;

// Real routed legs beat any model. Index every routed pair (both directions) by place name.
const idToName = new Map();
for (const p of SNAP.places) idToName.set(p.id, (p.shortLabel || p.name || '').trim());
const realLeg = new Map();
for (const d of SNAP.days) for (const l of (d.legs || [])) {
  const a = idToName.get(l.fromPlaceId), b = idToName.get(l.toPlaceId);
  if (!a || !b) continue;
  // A routed leg is only trustworthy if BOTH ends were routed from the right place. When a coord is
  // corrected in coords.json, every cached leg touching it was measured from the wrong position and
  // must be thrown away — otherwise "routed beats estimated" preserves the very error we just fixed.
  // (Mutianyu → Sanlitun came back as a 27-min metro because the toboggan had been sitting downtown.)
  if (COORDS[a] || COORDS[b]) continue;
  const mode = l.recommended, m = (l[mode] || {}).minutes;
  if (m == null) continue;
  for (const k of [`${a}|${b}`, `${b}|${a}`]) if (!realLeg.has(k)) realLeg.set(k, { mode, minutes: m, km: (l[mode] || {}).km ?? null, estimated: false });
}

const placeByName = new Map();
for (const p of SNAP.places) for (const k of [(p.shortLabel || '').trim(), (p.name || '').trim()]) if (k && !placeByName.has(k)) placeByName.set(k, p);

// index every stop the snapshot knows, per city+day, so we can reuse its data
const stopIndex = new Map();
for (const d of V) for (const st of d.stops) stopIndex.set(`${d.city}|${st.name}`, st);

const dir = new URL('./rebuild/', import.meta.url);
const plans = {};
for (const f of readdirSync(dir).filter(x => x.endsWith('.json') && !x.startsWith('_in_'))) {
  const j = JSON.parse(readFileSync(new URL(f, dir), 'utf8'));
  if (j && j.city) plans[j.city] = j;
}

const out = {}, report = [];
for (const day of V) {
  const plan = plans[day.city];
  if (!plan) continue;
  const dayPlan = (plan.days || []).find(x => x.day === day.day);
  if (!dayPlan) continue;

  // --- gather the pieces of this day -------------------------------------------------
  const hubs = day.stops.filter(s => s.hub);
  const arriveHub = hubs.find(s => s.hub.role === 'arrive');
  const departHub = hubs.find(s => s.hub.role === 'depart');
  const hotelStop = day.stops.find(s => s.ptype === 'Hotel');
  const mealStops = day.stops.filter(s => s.meal);
  const GENERIC_MEAL = /^(breakfast|lunch|dinner)\b/i;
  // A generic "Breakfast/Lunch/Dinner" has no real location of its own — its Notion coords are
  // stale placeholders. It is eaten wherever you already are, so:
  //   · travel INTO a meal is genuinely zero (co-located with the stop before it)
  //   · travel OUT of a meal must be measured from that same anchor, NOT zeroed.
  // The old code zeroed both directions, which silently deleted real legs (Breakfast → Temple of
  // Heaven is 5 km, and was being drawn as free) and left blanks in the travel column.
  // When a day OPENS with breakfast there is no real stop behind it, and falling back to the meal
  // itself measured from its stale placeholder coord — Zhangjiajie d3 read the 28 km run to the
  // Zhangjiajie-city bus as a 22-minute walk. The hotel is where you eat breakfast, so anchor there.
  const anchorOf = (rows, fallback) => {
    for (let i = rows.length - 1; i >= 0; i--) if (!GENERIC_MEAL.test(rows[i].name)) return rows[i].name;
    return hotelStop?.name || fallback;
  };
  const hop = (fromName, toName) => {
    if (GENERIC_MEAL.test(toName)) return { mode: 'none', minutes: 0, km: 0, estimated: false, coloc: true };
    if (!fromName) return { mode: 'none', minutes: 0, km: 0, estimated: false, coloc: true };
    // A cableway/lift IS the journey to the place it serves — its dwell already contains the ride.
    if (ZERO.has(`${fromName}|${toName}`)) return { mode: 'none', minutes: 0, km: 0, estimated: false, coloc: true };
    const r = realLeg.get(`${fromName}|${toName}`);
    if (r) return r;
    return travel(coordOf(fromName), coordOf(toName), day.city);
  };
  // Resolve the origin through the meal anchor, then hop.
  const legTo = (rows, toName) => {
    const prev = rows[rows.length - 1];
    if (!prev) return { mode: 'none', minutes: 0, km: 0, estimated: false, coloc: true };
    return hop(anchorOf(rows, prev.name), toName);
  };
  const coordOf = name => {
    const fix = COORDS[name];                       // a corrected coord always wins
    if (fix && fix.lat != null) return { lat: fix.lat, lng: fix.lng };
    const st = stopIndex.get(`${day.city}|${name}`);
    if (st && st.lat != null) return { lat: st.lat, lng: st.lng };
    const p = placeByName.get(name);
    return p?.coord || null;
  };
  const dwellOf = name => {
    const st = stopIndex.get(`${day.city}|${name}`);
    return st?.res ?? RES[name]?.m ?? st?.adv ?? 45;
  };
  const mealDur = m => {
    const st = stopIndex.get(`${day.city}|${m.name}`);
    return st?.res ?? RES[m.name]?.m ?? MEAL_DUR[m.meal];
  };
  // Per-day meal windows, e.g. "mealWindows": { "breakfast": "06:30", "dinner": "17:00" }
  const MW = { ...MEAL_WIN };
  for (const [k, v] of Object.entries(dayPlan.mealWindows || {})) { const t = tkc(v); if (t != null) MW[k] = t; }
  // Per-day stop timing, e.g.
  //   "stopTimes": { "Lion Hill sunset": { "notBefore": "19:00" },
  //                  "Impression Lijiang": { "at": "13:00" } }
  // `notBefore` holds a stop until a real-world moment the chain knows nothing about — sunset, or
  // dark. `at` pins it to a fixed clock time: a scheduled showtime you queue for, not a slot the
  // chain is free to slide. Without these, a stop literally named "sunset" gets scheduled whenever
  // the chain happens to arrive, which on Lijiang d2 was four hours early.
  const ST = dayPlan.stopTimes || {};
  const stopFloor = name => { const s = ST[name]; return s ? (tkc(s.at) ?? tkc(s.notBefore) ?? null) : null; };
  const stopPinned = name => !!(ST[name] && ST[name].at);
  // Closing times cap a dwell — a stop cannot run past the hour the doors shut. The researched
  // advice stays visible as the advice; what changes is how much of it this day can actually buy.
  const capDwell = (name, start, dwell) => {
    const c = CLOSE[name]; if (!c) return { dwell, cap: null };
    const closes = tkc(c.closes), lastEntry = tkc(c.lastEntry);
    if (closes == null) return { dwell, cap: null };
    if (lastEntry != null && start > lastEntry)
      return { dwell: Math.max(0, closes - start), cap: { closes: c.closes, lastEntry: c.lastEntry, lost: dwell - Math.max(0, closes - start), tooLate: true, conf: c.conf } };
    if (start + dwell > closes)
      return { dwell: closes - start, cap: { closes: c.closes, lastEntry: c.lastEntry, lost: start + dwell - closes, tooLate: false, conf: c.conf } };
    return { dwell, cap: null };
  };

  // --- assemble the ordered sequence ------------------------------------------------
  const seq = [];
  const transit = arriveHub && departHub && hubAnchor(departHub) < hubAnchor(arriveHub);
  if (transit) { seq.push({ kind: 'hub', name: departHub.name, st: departHub });
                 seq.push({ kind: 'hub', name: arriveHub.name, st: arriveHub }); }
  else if (arriveHub) seq.push({ kind: 'hub', name: arriveHub.name, st: arriveHub });
  if (arriveHub && hotelStop && !(dayPlan.stops || []).includes(hotelStop.name))
    seq.push({ kind: 'sight', name: hotelStop.name, st: hotelStop });
  const journeyDup = n => transit && /\b(cruise|ferry|train|flight)\b/i.test(n);
  const absorbed = [];
  for (const n of (dayPlan.stops || [])) {
    if (journeyDup(n)) { absorbed.push(n); continue; }   // the sailing IS the gap between the hubs
    const st = stopIndex.get(`${day.city}|${n}`);
    seq.push({ kind: 'sight', name: n, st: st || null });
  }
  if (departHub && !transit) seq.push({ kind: 'hub', name: departHub.name, st: departHub });

  // insert meals at their windows, between sights, in order
  const meals = mealStops.map(m => ({ kind: 'meal', name: m.name, meal: m.meal, st: m }));

  // --- chain it ---------------------------------------------------------------------
  const hasDeadline = !!departHub;
  function chain(shift) {
    const rows = []; let missed = null;
    const pending = [...meals];
    // Seed the clock so a meal whose window is already open lands BEFORE the first sight,
    // instead of the old behaviour where breakfast turned up after the Panda Base.
    let clock = null;
    if (!arriveHub && !transit) {
      const firstSight = seq.find(x => x.kind === 'sight');
      const dawnFirst = firstSight && /dawn|sunrise|mist|balloon/i.test(firstSight.name);
      clock = dawnFirst ? DAWN_START : (meals.some(m => m.meal === 'breakfast') ? MW.breakfast + (hasDeadline ? shift : 0) : DAY_START + (hasDeadline ? shift : 0));
    }
    const emit = (item, start, dwell, tr, cap) => rows.push({ ...item, s: start, d: dwell, travelIn: tr, cap: cap || null });

    for (let i = 0; i < seq.length; i++) {
      const it = seq[i];
      // Nothing left but the train/flight: a meal whose window has not opened yet must WAIT for it,
      // not be skipped. The normal rule below only fires a meal that is already due, so a morning
      // that ran out of sights before noon dropped lunch entirely — Furong d2 sat idle 08:42→13:15
      // with no lunch at all, and the departure day simply never ate.
      if (it.kind === 'hub' && it.st.hub?.role === 'depart' && clock != null) {
        const anchor = hubAnchor(it.st);
        while (pending.length) {
          const m = pending[0];
          const win = MW[m.meal] + (hasDeadline ? shift : 0);
          const t = legTo(rows, m.name);
          const start = Math.max(clock + t.minutes + SLACK, win);
          const dur = mealDur(m);
          if (start + dur + SLACK > anchor) break;      // genuinely no room before check-in
          emit(pending.shift(), start, dur, t);
          clock = start + dur;
        }
      }
      // a meal is due if its window has opened and a sight isn't mid-flow
      while (pending.length && clock != null) {
        const m = pending[0];
        const win = MW[m.meal] + (hasDeadline ? shift : 0);
        if (clock + 0 < win) break;
        const t = legTo(rows, m.name);
        // The first thing in the day has nothing to travel from — it starts exactly at its window,
        // not a slack period after it, so "breakfast 06:30" means 06:30.
        const start = rows.length ? Math.max(clock + t.minutes + SLACK, win) : win;
        const md = mealDur(m);
        emit(pending.shift(), start, md, t);
        clock = start + md;
      }

      if (it.kind === 'hub') {
        const h = it.st.hub;
        const anchor = hubAnchor(it.st);
        const d = h.dwell ?? 60;
        if (h.role === 'arrive') { emit(it, anchor, d, { minutes: 0, mode: 'none' }); clock = anchor + d; }
        else {
          const t = legTo(rows, it.name);
          const earliest = clock == null ? anchor : clock + t.minutes + SLACK;
          if (earliest > anchor + 1) missed = { name: it.name, by: Math.round(earliest - anchor), beThereBy: h.beThereBy };
          emit(it, anchor, d, t);
          clock = anchor + d;
        }
        continue;
      }

      const t = legTo(rows, it.name);
      const dawn = /dawn|sunrise|mist|balloon/i.test(it.name);
      let start = clock == null ? (dawn ? DAWN_START : DAY_START) : clock + t.minutes + SLACK;
      const floor = stopFloor(it.name);
      if (floor != null) {
        // A pinned showtime that the chain cannot physically reach is a real conflict, not something
        // to quietly slide past — record it and let the day report it.
        if (stopPinned(it.name) && start > floor) it.lateFor = { at: hhmm(floor), by: start - floor };
        start = Math.max(start, floor);
      }
      const { dwell, cap } = capDwell(it.name, start, dwellOf(it.name));
      emit(it, start, dwell, t, cap);
      clock = start + dwell;
    }
    // any meal never triggered (e.g. dinner after the last sight) lands at the end
    for (const m of pending) {
      const t = legTo(rows, m.name);
      const start = Math.max((clock ?? MW[m.meal]) + t.minutes + SLACK, MW[m.meal] + (hasDeadline ? shift : 0));
      // never schedule a meal after the day has already flown out
      if (departHub && start > (departHub.abs ?? Infinity)) continue;
      const md = mealDur(m);
      emit(m, start, md, t);
      clock = start + md;
    }
    rows.sort((a, b) => a.s - b.s);
    return { rows, missed, end: clock };
  }

  let res = chain(0);
  // if the chain cannot reach a locked check-in, pull the whole day earlier (never re-derive backwards)
  if (res.missed) { const r2 = chain(-res.missed.by); if (!r2.missed) res = r2; else res = r2; }

  // --- home leg ---------------------------------------------------------------------
  let endMin = res.end;
  if (!departHub && res.rows.length) {
    const last = res.rows[res.rows.length - 1];
    const hc = hotelStop ? coordOf(hotelStop.name) : null;
    // Measure home from the last REAL place — if the day ends on a generic dinner, its stale
    // placeholder coords would otherwise invent a commute that isn't there.
    const fromName = anchorOf(res.rows, last.name);
    const t = travel(coordOf(fromName), hc, day.city, { fallback: day.homeMin ?? 20 });
    endMin = last.s + last.d + t.minutes;
    res.homeTravel = t;
  }

  out[`${day.city}|${day.day}`] = {
    city: day.city, day: day.day, date: day.date,
    theme: dayPlan.theme || '', why: dayPlan.why || '',
    endMin, homeTravel: res.homeTravel || null,
    missed: res.missed || null, absorbed: absorbed.length ? absorbed : null,
    stops: res.rows.map(r => ({
      name: r.name, s: r.s, d: r.d, kind: r.kind, meal: r.meal || null,
      travelIn: r.travelIn ? { mode: r.travelIn.mode, minutes: r.travelIn.minutes, km: r.travelIn.km ?? null, est: !!r.travelIn.estimated, coloc: !!r.travelIn.coloc } : null,
      advice: RES[r.name]?.m ?? null, cap: r.cap || null, lateFor: r.lateFor || null,
      hub: r.st?.hub || null,
    })),
  };
  report.push(`${day.city} d${day.day}: ${res.rows.length} stops → ${hhmm(endMin)}${endMin >= 1440 ? ' +1' : ''}${res.missed ? ' ⚠ MISSES ' + res.missed.name : ''}`);
}

const ideas = {};
for (const [city, p] of Object.entries(plans)) if (p.ideas?.length) ideas[city] = p.ideas;

// --- ideas, attributed to the day they came FROM -------------------------------------------
// An idea belongs under the day it was originally planned for, not floated across the whole city.
// This is derived, never hand-maintained: diff the original Notion day-assignment against the new
// plan, so as we rebalance days the attribution stays right on its own.
//   · parked → in the original schedule, in no new day
//   · moved  → in the new plan, but on a different day than it started on
const SKIP = /^(breakfast|lunch|dinner|back to the hotel)\b/i;
const whyOf = (city, name) => (plans[city]?.ideas || []).find(i => i.name === name)?.why || null;
const ideasByDay = {};
const movesByDay = {};
for (const city of Object.keys(plans)) {
  const origDay = new Map();               // name → original Notion day
  // Ideas are SIGHTS you chose not to do. Meals, hotels and transport legs are structure — a
  // "Chengdu East → Guanghan" in the Ideas table reads as a sight you cut, when it is just the way
  // you get to Sanxingdui and is already implied by that stop.
  for (const d of V.filter(x => x.city === city))
    for (const st of d.stops)
      if (!SKIP.test(st.name) && !st.hub && st.ptype !== 'Hotel' && st.ptype !== 'Transport' && !origDay.has(st.name)) origDay.set(st.name, d.day);

  // Read the day from what was ACTUALLY chained, not from the curator's stop list — the builder
  // also inserts stops of its own (the hotel check-in). Reading the list alone reported a stop as
  // "parked" while it sat scheduled in the day right above the Ideas table.
  const newDay = new Map();                // name → day in the rebuilt plan
  for (const dp of (plans[city].days || [])) for (const n of (dp.stops || [])) newDay.set(n, dp.day);
  for (const [k, d] of Object.entries(out)) {
    if (!k.startsWith(`${city}|`)) continue;
    for (const s of d.stops) if (!SKIP.test(s.name) && !s.hub) newDay.set(s.name, d.day);
  }

  for (const [name, od] of origDay) {
    const nd = newDay.get(name) ?? null;
    const key = `${city}|${od}`;
    if (nd == null) {
      (ideasByDay[key] ||= []).push({ name, why: whyOf(city, name), status: 'parked', from: od });
    } else if (nd !== od) {
      (movesByDay[key] ||= []).push({ name, status: 'moved', from: od, to: nd });
      (movesByDay[`${city}|${nd}`] ||= []).push({ name, status: 'gained', from: od, to: nd });
    }
  }
  // An idea written by hand that was never in the original schedule at all still needs a home:
  // attribute it to the city's first day so it stays visible rather than vanishing.
  const ptypeOf = n => { for (const d of V) { const s = d.stops.find(x => x.name === n); if (s) return s.ptype; } return null; };
  for (const i of (plans[city].ideas || [])) {
    if (origDay.has(i.name) || newDay.has(i.name)) continue;   // scheduled after all → not an idea
    if (['Transport', 'Hotel'].includes(ptypeOf(i.name))) continue;   // structure, not a sight you cut
    const firstDay = (plans[city].days || [])[0]?.day ?? 1;
    (ideasByDay[`${city}|${firstDay}`] ||= []).push({ ...i, status: 'parked', from: null });
  }
}
writeFileSync(new URL('./rebuilt.json', import.meta.url), JSON.stringify({ days: out, ideas, ideasByDay, movesByDay, notes: Object.fromEntries(Object.entries(plans).map(([c, p]) => [c, p.notes || []])) }, null, 1));
console.log(report.join('\n'));
console.log(`\nrebuilt ${Object.keys(out).length} days · ideas in ${Object.keys(ideas).length} cities · ${Object.values(out).filter(d => d.missed).length} missing a locked deadline`);
