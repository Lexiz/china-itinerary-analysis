// Build the Notion propagation set: the single, regenerated answer to
// "what do I have to change in Notion, per place, to make it match the reworked plan?"
//
// This is deliberately DERIVED, never hand-kept. Every time we agree a change on the canvas and
// re-run the build, this file is rewritten from rebuilt.json vs the Notion snapshot (viz-data.json),
// so the workbook can never drift from what the canvas shows.
//
// Output: build/notion-sync.json  →  (python) china-notion-sync.xlsx
import { readFileSync, writeFileSync } from 'node:fs';

const V = JSON.parse(readFileSync(new URL('./viz-data.json', import.meta.url)));
const RB = JSON.parse(readFileSync(new URL('./rebuilt.json', import.meta.url)));
const RES = JSON.parse(readFileSync(new URL('./researched.json', import.meta.url)));

const hhmm = m => m == null ? '' : `${String(Math.floor(((m % 1440) + 1440) % 1440 / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const dayOver = m => m == null ? '' : (m >= 1440 ? ' (+1)' : '');
const SKIP_HOTEL = /^back to the hotel/i;

// --- index the ORIGINAL Notion state, per place ------------------------------------------------
// A real sight is one page that may change day, so it is keyed by name alone. A generic
// "Breakfast/Lunch/Dinner" is a per-day row, not a shared page — keying those by name alone made
// every day's breakfast match day 1's and report a bogus "MOVE day 1 → 2".
const GENERIC_MEAL = /^(breakfast|lunch|dinner)\b/i;
const okey = (city, name, day) => GENERIC_MEAL.test(name) ? `${city}|${name}|${day}` : `${city}|${name}`;
const orig = new Map();
for (const d of V) for (const st of d.stops) {
  const k = okey(d.city, st.name, d.day);
  if (!orig.has(k)) orig.set(k, { day: d.day, date: d.date, start: st.abs ?? null, dur: st.res ?? st.adv ?? null, order: st.order ?? null });
}
const dateOf = new Map(V.map(d => [`${d.city}|${d.day}`, d.date]));
const cityOrder = [...new Set(V.map(d => d.city))];

const schedule = [], changes = [], legs = [];

for (const city of cityOrder) {
  for (const d of V.filter(x => x.city === city)) {
    const day = RB.days[`${city}|${d.day}`];
    if (!day) continue;
    const stops = day.stops;
    stops.forEach((s, i) => {
      const next = stops[i + 1] || null;
      // "travel to next" is the leg OUT of this stop — i.e. the next stop's travelIn — and for the
      // last stop of the day it is the leg home.
      const t = next ? next.travelIn : (day.homeTravel ? { ...day.homeTravel, est: day.homeTravel.estimated } : null);
      const dest = next ? next.name : 'Hotel (home)';
      const o = orig.get(okey(city, s.name, d.day)) || null;
      const newStart = s.s, newEnd = s.s + s.d;

      const row = {
        city, day: d.day, date: d.date, order: (i + 1) * 10,
        activity: s.name,
        kind: s.hub ? 'Transport' : s.meal ? 'Food' : 'Sight',
        newStart: hhmm(newStart) + dayOver(newStart),
        newEnd: hhmm(newEnd) + dayOver(newEnd),
        newDurMin: s.d,
        durBasis: (s.cap
          ? `CUT SHORT BY CLOSING TIME: closes ${s.cap.closes}${s.cap.lastEntry ? `, last entry ${s.cap.lastEntry}` : ''}; `
            + `${s.cap.lost} min less than the ${s.advice} min advice${s.cap.tooLate ? '; ARRIVES AFTER LAST ENTRY' : ''}. `
          : '') + (RES[s.name]?.basis || (s.hub ? 'Locked hub buffer' : '')),
        durConf: RES[s.name]?.conf || '',
        toNext: dest,
        travelMode: t ? (t.coloc ? 'none (same place)' : t.mode) : '',
        travelMin: t ? t.minutes : '',
        travelKm: t && t.km != null ? t.km : '',
        travelSource: t ? (t.coloc ? 'co-located' : t.est ? 'estimated (fitted model)' : 'routed (real leg)') : '',
        origDay: o ? o.day : '(new to plan)',
        origStart: o ? hhmm(o.start) : '',
        origDurMin: o ? o.dur : '',
        action: '',
      };

      // What actually has to change in Notion for this place
      const acts = [];
      if (!o) acts.push('ADD to plan');
      else {
        if (o.day !== d.day) acts.push(`MOVE day ${o.day} → ${d.day}`);
        if (o.start !== newStart) acts.push(`RETIME ${hhmm(o.start)} → ${hhmm(newStart)}`);
        if (o.dur != null && o.dur !== s.d) acts.push(`DURATION ${o.dur}m → ${s.d}m`);
        if (o.order !== row.order) acts.push(`ORDER ${o.order} → ${row.order}`);
      }
      row.action = acts.length ? acts.join('; ') : 'no change';
      schedule.push(row);
      if (acts.length) changes.push(row);

      if (t && !t.coloc && t.minutes) legs.push({
        city, day: d.day, date: d.date,
        from: s.name, to: dest,
        mode: t.mode, minutes: t.minutes, km: t.km ?? '',
        source: t.est ? 'estimated (fitted model)' : 'routed (real leg)',
      });
    });
  }
}

// --- parked + moved ----------------------------------------------------------------------------
const ideas = [], moves = [];
for (const [key, list] of Object.entries(RB.ideasByDay || {})) {
  const [city, dy] = key.split('|');
  for (const i of list) ideas.push({
    city, origDay: +dy, date: dateOf.get(key) || '',
    activity: i.name, adviceMin: RES[i.name]?.m ?? '',
    action: 'REMOVE from this day in Notion — keep the page, mark it unscheduled/idea',
    why: i.why || 'Did not fit the reworked day',
  });
}
for (const [key, list] of Object.entries(RB.movesByDay || {})) {
  const [city, dy] = key.split('|');
  for (const m of list) if (m.status === 'moved') moves.push({
    city, activity: m.name, fromDay: m.from, toDay: m.to,
    adviceMin: RES[m.name]?.m ?? '',
    action: `Change this page's day: ${m.from} → ${m.to}`,
  });
}

// dedupe hotel-return pseudo-stops that Notion carries but the rebuild absorbs into the home leg
const out = {
  generated: 'regenerate with ./build.sh — never edit this file by hand',
  schedule: schedule.filter(r => !SKIP_HOTEL.test(r.activity)),
  changes: changes.filter(r => !SKIP_HOTEL.test(r.activity)),
  ideas, moves, legs,
};
writeFileSync(new URL('./notion-sync.json', import.meta.url), JSON.stringify(out, null, 1));
console.log(`notion-sync: ${out.schedule.length} stops · ${out.changes.length} need a Notion edit · ${ideas.length} parked · ${moves.length} day-moves · ${legs.length} legs`);
