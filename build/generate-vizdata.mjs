import { readFileSync, writeFileSync } from 'node:fs';
const s = JSON.parse(readFileSync('/Users/alexlisitzky/ClaudeCode/sandbox/China/app/data/snapshot.json', 'utf8'));
const RES = JSON.parse(readFileSync(new URL('./researched.json', import.meta.url))); // researched visit durations
const NIGHT = JSON.parse(readFileSync(new URL('./night.json', import.meta.url)));    // night/dusk/show/any per place
const COORDS = JSON.parse(readFileSync(new URL('./coords.json', import.meta.url))); // corrected coords (see its _readme)
const placeById = new Map(s.places.map(p => [p.id, p]));
const normn = x => String(x || '').replace(/&amp;/g, '&').trim();
const tk = t => { const m = (t || '').match(/(\d{1,2}):(\d{2})/); return m ? (+m[1]) * 60 + (+m[2]) : null; };
const cityById = new Map(s.cities.map(c => [c.id, c]));
const addDays = (iso, n) => { const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
// The hand-written FIX table that used to live here was pre-review advice — "Drop Mutianyu night
// tour", "3 museums too many". It went because two disagreeing opinions on one page is worse than
// none; the plan itself is whatever Postgres holds, and this file only describes it.
const out = [];
for (const d of s.days) {
  const c = cityById.get(d.cityId);
  const acts = (d.activities || []).filter(a => !a.away);
  const real = acts.filter(a => !a.isHotelReturn && a.placeId && a.time && !a.bonus);
  if (!real.length) continue;
  const home = acts.find(a => a.isHotelReturn);
  const legByFrom = new Map((d.legs || []).map(l => [l.fromPlaceId, l]));
  const lunch = real.find(a => a.meal === 'lunch'), dinner = real.find(a => a.meal === 'dinner');
  const jammed = real.filter(a => a.time === '~23:59').length;
  // Unwrap the day across midnight, so a stop that really happens after 00:00 scores 1440+.
  //
  // The old rule was "any backward step in array order starts a new day". Both halves of that were
  // wrong once the reviewed plan came back from Notion. Array order is Sequence order, and Sequence
  // ties: Chengdu d3 files its two transfer legs at 20/30 next to Lunch at 30, so 10:58 was read
  // after 12:28, counted as a midnight roll, and pushed the whole afternoon +1440 — the day "ended"
  // at 46:03. And a plain backward step is far more often a mis-sequenced stop than a real rollover.
  //
  // So: read the day in (Sequence, clock) order, and only wrap on the shape a real rollover has —
  // late evening followed by early morning. Fenghuang d1's 22:37 → 08:36 shuttle still wraps (that
  // shuttle genuinely is the next morning); Chengdu d3's 12:28 → 10:58 no longer does.
  const LATE = 20 * 60, EARLY = 10 * 60;
  const absOf = new Map();
  {
    const ordered = acts
      .map((a, i) => ({ a, i, cm: tk(a.time) }))
      .filter(x => x.cm != null)
      .sort((x, y) => (x.a.order ?? 1e9) - (y.a.order ?? 1e9) || x.cm - y.cm || x.i - y.i);
    let base = 0, prevClock = -1;
    for (const { a, cm } of ordered) {
      if (prevClock >= LATE && cm <= EARLY) base += 1440;
      absOf.set(a, base + cm);
      prevClock = cm;
    }
  }
  const last = real[real.length - 1];
  const startMin = absOf.get(real[0]) ?? tk(real[0].time);
  let endMin, homeMode = null, homeKm = null, homeMin = null;
  if (home) {
    const leg = last.placeId ? legByFrom.get(last.placeId) : null;
    const mode = leg?.recommended;
    homeMin = leg ? (leg[mode]?.minutes ?? leg.didi?.minutes ?? 0) : 0;
    homeMode = mode; homeKm = leg ? (leg[mode]?.km ?? null) : null;
    endMin = absOf.get(home) ?? ((absOf.get(last) ?? tk(last.time)) + (last.visitDuration ?? last.advisedDuration ?? 60) + homeMin); // arrive home
  } else {
    endMin = (absOf.get(last) ?? tk(last.time)) + (last.advisedDuration ?? 60); // departure day, no return
  }
  // NB: no verdict is formed here. Whether a day is late is decided exactly once, in
  // generate-canvas's verdict() — see README "Direction of truth". This file only reports
  // what the snapshot says, and the snapshot is recalc()'s output. `endMin` in particular is
  // the literal last clock of the day record, which on Fenghuang d1 is next morning's
  // departure shuttle; it is descriptive, not a judgement.
  // per-activity breakdown for the unfold: start · end · suggested · actual · travel→next
  const fmt = m => { const x = ((m % 1440) + 1440) % 1440; return String(Math.floor(x / 60)).padStart(2, '0') + ':' + String(x % 60).padStart(2, '0'); };
  const legBy = new Map((d.legs || []).map(l => [l.fromPlaceId, l]));
  const stops = acts.map(a => {
    const start = tk(a.time);
    const act = a.isHotelReturn ? null : (a.visitDuration ?? null);
    const leg = (!a.isHotelReturn && a.placeId) ? legBy.get(a.placeId) : null;
    const nm = normn(a.shortTitle || a.title);
    const rr = a.isHotelReturn ? null : RES[nm];
    const pl = placeById.get(a.placeId);
    // night level drives replanning: only 'night'/'show' are locked after dark, 'any' is free to move to daytime
    const night = a.isHotelReturn ? null : (NIGHT.places[normn(pl?.name)] || 'any');
    const f = a.flight || null;
    // a hub's dwell IS its buffer: 3h at Pudong is 3h of the day gone, not a gap
    const hubDwell = f ? (f.role === 'depart' ? (f.bufferMin ?? null) : (f.clearMin ?? null)) : null;
    return {
      night, ptype: pl?.type || null, slot: pl?.slot || null,
      order: a.order ?? null, bonus: !!a.bonus, impossible: a.impossible || null, abs: absOf.get(a) ?? null,
      hub: f ? {
        role: f.role, mode: f.mode, number: f.number || null, approx: !!f.approx,
        terminal: f.terminal || null, route: f.routeLabel || null, booked: !!f.booked,
        departTime: f.departTime || null, arriveTime: f.arriveTime || null,
        beThereBy: f.beThereBy || null, clearBy: f.clearBy || null, dwell: hubDwell,
      } : null,
      mustArriveBy: leg?.mustArriveBy || null, mustArriveLabel: leg?.mustArriveLabel || null,
      // for the per-day map — a corrected coord wins, so the map can't draw a stop 60 km from where it is
      lat: COORDS[nm]?.lat ?? pl?.coord?.lat ?? null, lng: COORDS[nm]?.lng ?? pl?.coord?.lng ?? null,
      hours: pl?.hours || null,                                   // opening hours (free text, sparse)
      booking: pl?.bookingRequired ? (pl?.booked ? 'booked' : 'to-book') : null,
      t: a.time ? a.time.replace('~', '') : '',
      end: (start != null && act != null) ? fmt(start + act) : null,
      name: (a.shortTitle || a.title || '').slice(0, 46),
      adv: a.isHotelReturn ? null : (a.advisedDuration ?? null),
      res: rr?.m ?? null,       // researched real-world suggested minutes
      resnote: rr?.n || '', resbasis: rr?.basis || '', resconf: rr?.conf || '',
      act,
      meal: a.meal || null,
      risk: a.risk || null,
      home: !!a.isHotelReturn,
      w: leg ? (leg.walk?.minutes ?? null) : null,
      me: leg ? (leg.metro?.minutes ?? null) : null,
      dd: leg ? (leg.didi?.minutes ?? null) : null,
      rec: leg ? leg.recommended : null,
    };
  });
  // Suggestions parked against this day. In Postgres an idea is simply a place no
  // committed stop references, carrying the day it wants to land on — so this is
  // read straight off the snapshot rather than being a by-product of a planner
  // deciding what to drop.
  const ideas = (s.ideas || [])
    .filter((p) => p.cityId === d.cityId && p.day === d.cityDay)
    .map((p) => ({
      name: normn(p.shortLabel || p.name).slice(0, 46),
      kind: p.type === 'Food' ? (p.meal?.length ? p.meal.join('/').toLowerCase() : 'food') : 'activity',
      res: RES[normn(p.shortLabel || p.name)]?.m ?? p.advisedDuration ?? null,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  out.push({ city: c.name, accent: c.accent, order: c.order, day: d.cityDay, date: addDays(c.dates.start, d.cityDay - 1),
    theme: d.theme || null,
    startMin, endMin, lunchMin: lunch ? tk(lunch.time) : null, dinnerMin: dinner ? tk(dinner.time) : null,
    nStops: real.length, jammed, home: !!home, homeMode, homeMin, homeKm,
    // Daylight, straight from the snapshot — which reads it from `day`, which got it
    // from the city's own coordinates. The canvas shades the timeline dark from DUSK
    // (civil twilight) rather than sunset: there is roughly half an hour of usable
    // light after the sun goes down, and shading from sunset would darken the exact
    // slots the re-plan deliberately put dusk stops in.
    sunrise: d.sunrise || null, sunset: d.sunset || null,
    dawn: d.dawn || null, dusk: d.dusk || null,
    isArrival: !!d.isArrival, isDeparture: !!d.isDeparture, ideas, stops });
}
// The split-days pass that used to live here is gone, and so is build/split-days.json. It existed
// because Notion filed a whole transit date under the DESTINATION city, so the origin-city morning
// (wake, check out, travel) vanished. Moving the Zhujiang Wharf transfer onto Guilin fixed that at
// the source: Notion now yields Guilin d2 (breakfast 05:39 + the 07:00 wharf call) and Yangshuo d1
// (arrival onward) as two real day records. The pass had silently stopped matching and was warning
// rather than splitting — a rewrite of data we no longer need to rewrite.

out.sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : a.order - b.order);
writeFileSync(new URL('./viz-data.json', import.meta.url), JSON.stringify(out));
const max = Math.max(...out.map(d => d.endMin));
console.log('days:', out.length, '— descriptive only; the plan itself comes from Postgres');
console.log('max endMin (home arrival):', max, '=', Math.floor(max / 60) + ':' + String(max % 60).padStart(2, '0'), max > 1560 ? '→ EXCEEDS 02:00 axis' : '(within axis)');
console.log('latest homes:', out.filter(d => d.endMin > 1440).sort((a, b) => b.endMin - a.endMin).slice(0, 6).map(d => `${d.city} d${d.day} ${Math.floor(d.endMin/60)}:${String(d.endMin%60).padStart(2,'0')}`).join(' · '));
