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
    // the place this block IS, so the canvas can open the same detail the app shows
    const pid = a.placeId || null;
    const f = a.flight || null;
    // a hub's dwell IS its buffer: 3h at Pudong is 3h of the day gone, not a gap
    const hubDwell = f ? (f.role === 'depart' ? (f.bufferMin ?? null) : (f.clearMin ?? null)) : null;
    return {
      // The Material Symbol the app shows for this stop — computed ONCE in the app's
      // sync layer (Place.typeIcon; hubs get their leg icon on the Activity), so both
      // surfaces draw the same glyph from the same field.
      icon: a.typeIcon || null,
      night, pid, ptype: pl?.type || null, slot: pl?.slot || null,
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
    .filter((p) => p.cityId === d.cityId && (p.day === d.cityDay || p.suggestedAllDays))
    .map((p) => ({
      name: normn(p.shortLabel || p.name).slice(0, 46),
      icon: p.typeIcon || null,
      kind: p.type === 'Food' ? (p.meal?.length ? p.meal.join('/').toLowerCase() : 'food') : 'activity',
      res: RES[normn(p.shortLabel || p.name)]?.m ?? p.advisedDuration ?? null,
      // The identity a button needs. `id` is what /api/meal expects as `placeId`,
      // and `meals` says which slots this venue is actually a candidate for — so the
      // page offers "Add to lunch" only where the catalogue says lunch is plausible.
      id: p.id,
      meals: (p.meal || []).map((m) => m.toLowerCase()),
      full: p.name,
      booking: p.bookingRequired ? (p.booked ? 'booked' : 'to-book') : null,
      // Where it actually is. A suggestion you cannot place on the map is a name and
      // nothing else — "is this on the way, or across town?" is the first question you
      // ask of one, and until now the page could not answer it. Same corrected-coord
      // precedence the committed stops use, so an idea and the stop it might become
      // cannot be drawn in two different places.
      lat: COORDS[normn(p.shortLabel || p.name)]?.lat ?? p.coord?.lat ?? null,
      lng: COORDS[normn(p.shortLabel || p.name)]?.lng ?? p.coord?.lng ?? null,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  out.push({ city: c.name, cityId: d.cityId, accent: c.accent, order: c.order, day: d.cityDay, date: addDays(c.dates.start, d.cityDay - 1),
    theme: d.theme || null,
    startMin, endMin, lunchMin: lunch ? tk(lunch.time) : null, dinnerMin: dinner ? tk(dinner.time) : null,
    nStops: real.length, jammed, home: !!home, homeMode, homeMin, homeKm,
    // Is each meal actually DECIDED? Not "does a stop exist" — every day has lunch
    // and dinner slots and they all carry a Food type and an id, so presence says
    // nothing. `state` is the snapshot's own verdict: 'open' means no venue, anything
    // else means one is chosen (to-book / booked / arranged). Without this the canvas
    // disabled 34 of its 39 add-buttons on days whose slots were empty.
    mealsDecided: {
      lunch: d.meals?.lunch?.state && d.meals.lunch.state !== 'open'
        ? (placeById.get(d.meals.lunch.placeId)?.name || 'chosen') : null,
      dinner: d.meals?.dinner?.state && d.meals.dinner.state !== 'open'
        ? (placeById.get(d.meals.dinner.placeId)?.name || 'chosen') : null,
    },
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

// Whole-trip headline stats, shared with the mobile app's activity semantics.
// `activityCount` is the number shown on each day card: every scheduled row that
// actually belongs to that day, including its meal slots and hotel return, while
// excluding away/bonus alternatives. Summing those day counts keeps the hero in
// lockstep with the activity tables instead of counting catalogue Place records.
const routeModes = {
  walk: { count: 0, km: 0, minutes: 0 },
  metro: { count: 0, km: 0, minutes: 0 },
  didi: { count: 0, km: 0, minutes: 0 },
};
for (const d of s.days) {
  for (const leg of (d.legs || [])) {
    const mode = leg.recommended;
    const choice = routeModes[mode] && leg[mode];
    if (!choice || choice.minutes == null) continue;
    routeModes[mode].count += 1;
    routeModes[mode].km += choice.km || 0;
    routeModes[mode].minutes += choice.minutes;
  }
}
writeFileSync(new URL('./trip-stats.json', import.meta.url), JSON.stringify({
  days: s.trip.stats.days,
  nights: s.trip.stats.nights,
  cities: s.trip.stats.cities,
  distanceKm: s.trip.stats.distanceKm,
  distanceLabel: s.trip.stats.distanceLabel,
  activities: s.days.reduce((n, d) => n + (d.activityCount || 0), 0),
  flights: s.trip.stats.flights,
  trains: s.trip.stats.trains,
  routes: routeModes,
}));

// Booking manager sidecar. These are the exact booking records the mobile screen
// renders, not a second scan of activity labels. Keeping the calculated opening date,
// release clock and channel together lets the static Canvas apply the same Beijing-
// time availability rules in the browser without exposing the full app snapshot.
writeFileSync(new URL('./bookings.json', import.meta.url), JSON.stringify((s.bookings || []).map((b) => ({
  source: b.source,
  id: b.id,
  cityId: b.cityId || null,
  cityName: b.cityName || null,
  accent: b.accent || null,
  day: b.day ?? null,
  date: b.date || null,
  dateLabel: b.dateLabel || null,
  name: b.name,
  zh: b.zh || null,
  icon: b.icon || 'event',
  time: b.time || null,
  number: b.number || null,
  ref: b.ref || null,
  booked: !!b.booked,
  bookFrom: b.bookFrom || null,
  bookFromLabel: b.bookFromLabel || null,
  bookFromTime: b.bookFromTime || null,
  channel: b.channel || null,
  bookingLink: b.bookingLink || null,
}))));

// ---- place details, for the canvas's own detail panel ----------------------
//
// Written as a SIDECAR rather than folded into viz-data.json, which is an array
// that project.mjs consumes positionally — changing its shape to carry a lookup
// map would be a contract change for a rendering convenience.
//
// The fields are exactly what the app's place sheet shows, read from the same
// snapshot the app renders, so the two cannot describe the same venue differently.
// `blocks` is flattened to plain paragraphs: the canvas has no RichText renderer
// and inventing a second one is how two descriptions of one place start to drift.
const flat = (blocks) => (blocks || [])
  .map((b) => b.type === 'bulleted_list'
    ? (b.items || []).map((it) => '• ' + (it || []).map((sp) => sp.text).join('')).join('\n')
    : b.type === 'heading' ? b.text
    : ((b.spans) || []).map((sp) => sp.text).join(''))
  .filter(Boolean).join('\n\n');

// Where the app serves its images from — the canvas has none of its own.
const APP_ORIGIN = process.env.APP_ORIGIN || 'https://china-trip-app.vercel.app';
const PLACES = {};
for (const p of [...s.places, ...(s.ideas || [])]) {
  if (PLACES[p.id]) continue;
  PLACES[p.id] = {
    id: p.id, name: p.name, zh: p.zh || null, type: p.type, category: p.category || null,
    typeColor: p.typeColor || null, status: p.status,
    // ROOT-RELATIVE paths ('/img/places/…') are served by the APP, and this page is a
    // different origin on GitHub Pages — so left alone every image is a broken icon.
    // Absolutised here rather than in the template, so the sidecar is correct wherever
    // it is read from. A path that is already absolute is left alone.
    photos: (p.photos || []).slice(0, 6)
      .map((u) => (/^https?:\/\//.test(u) ? u : APP_ORIGIN + u)),
    credit: p.photoCredit ? { source: p.photoCredit.source, artist: p.photoCredit.artist || null,
                              license: p.photoCredit.license || null, article: p.photoCredit.article || null } : null,
    desc: flat(p.description),
    detailProfile: p.detailProfile || null,
    detailProfileResearchedAt: p.detailProfileResearchedAt || null,
    hours: p.hours || null, price: p.price || null,
    advised: p.advisedDuration ?? null, planned: p.visitDuration ?? null,
    ratings: p.ratings || null,
    planningNote: p.planningNote || null,
    booking: p.bookingRequired ? (p.booked ? 'booked' : 'to book') : null,
    bookingLink: p.bookingLink || null,
    bookingChannel: p.bookingChannel || null,
    bookingWindowDays: p.bookingWindowDays ?? null,
    bookingOpenTime: p.bookingOpenTime || null,
    coord: p.coord || null,
    meals: (p.meal || []).map((m) => m.toLowerCase()),
    opensAt: p.opensAt || null, closesAt: p.closesAt || null,
    lastEntryAt: p.lastEntryAt || null, closedToday: p.closedToday || false,
  };
}
writeFileSync(new URL('./places.json', import.meta.url), JSON.stringify(PLACES));
console.log('places.json:', Object.keys(PLACES).length, 'places with detail for the panel');
const max = Math.max(...out.map(d => d.endMin));
console.log('days:', out.length, '— descriptive only; the plan itself comes from Postgres');
console.log('max endMin (home arrival):', max, '=', Math.floor(max / 60) + ':' + String(max % 60).padStart(2, '0'), max > 1560 ? '→ EXCEEDS 02:00 axis' : '(within axis)');
console.log('latest homes:', out.filter(d => d.endMin > 1440).sort((a, b) => b.endMin - a.endMin).slice(0, 6).map(d => `${d.city} d${d.day} ${Math.floor(d.endMin/60)}:${String(d.endMin%60).padStart(2,'0')}`).join(' · '));
