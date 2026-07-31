import { readFileSync, writeFileSync } from 'node:fs';
const DATA = JSON.parse(readFileSync(new URL('./viz-data.json', import.meta.url)));
// Every stop the snapshot knows, by name, regardless of which day it originally sat on — so a stop
// moved between days keeps its coordinates and its researched advice.
const STOP_ANY = new Map();
for (const d of DATA) for (const s of (d.stops || [])) if (!STOP_ANY.has(s.name)) STOP_ANY.set(s.name, s);
const STYLE = readFileSync(new URL('./canvas-style.html', import.meta.url), 'utf8');
// Place detail, written by generate-vizdata from the same snapshot the app renders —
// so the panel here and the sheet there cannot describe one venue two ways.
const PLACES = JSON.parse(readFileSync(new URL('./places.json', import.meta.url)));
const TRIP = JSON.parse(readFileSync(new URL('./trip-stats.json', import.meta.url)));
// Where the app lives. Google Sign-In returns a verified, short-lived planner
// session from that app; no write credential is ever built into this public page.
const APP_ORIGIN = process.env.APP_ORIGIN || 'https://china-trip-app.vercel.app';
const GOOGLE_OAUTH_CLIENT_ID = process.env.GOOGLE_OAUTH_CLIENT_ID
  || '797848231858-inani0bd295607kmtrl99060biqih5g2.apps.googleusercontent.com';
// Working plan, keyed "City|day": machine-replanned days, overridden by hand-agreed ones.
import { changeList, matchStop, nk } from './lib-plan.mjs';
// Durations read as clock time: 45m, 1h30, 2h
const fmtDur = m => { const x = Math.round(m); return x < 60 ? x + 'm' : (Math.floor(x / 60) + 'h' + (x % 60 ? String(x % 60).padStart(2, '0') : '')); };
// Material Symbols by ligature name — the SAME glyph set the app renders. The name
// itself comes through the snapshot (Place.typeIcon / Activity.typeIcon, computed once
// in the app's sync layer), so the icon mapping has one oracle. The only rule repeated
// here is the app's own row rule (City.tsx): on a meal stop the MEAL icon wins.
const MEAL_MS = { breakfast: 'bakery_dining', lunch: 'lunch_dining', dinner: 'dinner_dining' };
const ms = (name, cls) => `<span class="msym${cls ? ' ' + cls : ''}" aria-hidden="true">${name}</span>`;
const stopIcon = r => r.meal ? (MEAL_MS[r.meal] || 'restaurant') : (r.icon || 'place');
// Google Maps key: env first, else the local gitignored file.
//
// THIS KEY IS MEANT TO BE PUBLIC, and that is not a compromise — it is what a Maps
// JavaScript key is. It goes in the HTML because the browser is what calls Google;
// every Maps embed on the web ships its key the same way. Project 451021051046 holds
// two keys, deliberately split by who calls Google:
//
//   5046dd22  "China canvas — Maps JS"   → THIS one. Referrer-locked to
//             lexiz.github.io/* and localhost, API-locked to maps-backend. Copied
//             anywhere else it is inert, which is the whole point.
//   7372a1ce  "China app — server-side"  → geocoding / directions / routes / places.
//             No referrer restriction, because a server sends no referrer. It must
//             NEVER reach this file or any generated page.
//
// There used to be a PUBLISH=1 flag here that blanked the key for the public build,
// from a time when only one unrestricted key existed. The restricted key replaced
// that need; the comment saying otherwise was never updated, and on 30 Jul it was
// read at face value and the flag was used — which published 37 days of tables with
// every per-day map replaced by "route map hidden", for no security gain whatever,
// since the key in those commits was the restricted one all along. The flag is gone
// rather than corrected: a switch that silently degrades the page is not worth
// keeping for a threat that does not exist.
//
// The empty-key path below is still real, and still honest: it is what a build with
// no key file and no env var produces.
let GKEY = process.env.GOOGLE_MAPS_API_KEY || '';
try { if (!GKEY) GKEY = readFileSync(new URL('./gmaps-key.txt', import.meta.url), 'utf8').trim(); } catch { GKEY = ''; }
// The reworked plan is now the committed schedule; the Proposed side is deliberately left empty
// so the next review pass has somewhere to write.
let REBUILT = { days: {}, ideas: {}, notes: {} };
try { REBUILT = JSON.parse(readFileSync(new URL('./rebuilt.json', import.meta.url))); } catch {}
// There used to be a second opinion here: replanned.json (replan.mjs re-chaining the day from the
// snapshot) merged over proposals.json. It fed nothing — the Proposed side is empty by design — but
// its sibling numbers still drove the header cards, and once the reviewed plan went back INTO Notion
// that audit was re-deriving times that had already been derived. It read Chengdu d3 as 46:03 while
// the row below it said 22:11. Retired: rebuilt.json is the only plan on this page.

// axis: 05:00 -> 04:00 (early arrivals start at 05:00; over-packed days get you home after 02:00)
const T0 = 300, T1 = 1680, SPAN = T1 - T0;
const P = m => Math.max(0, Math.min(100, (m - T0) / SPAN * 100));
const hhmm = m => { const x = ((m % 1440) + 1440) % 1440; return String(Math.floor(x / 60)).padStart(2, '0') + ':' + String(x % 60).padStart(2, '0'); };
const EL = m => m >= 1440 ? hhmm(m) + ' ⁺¹' : hhmm(m);
const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'], MO = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const wd = iso => WD[new Date(iso + 'T00:00:00Z').getUTCDay()];
const dm = iso => { const d = new Date(iso + 'T00:00:00Z'); return d.getUTCDate() + ' ' + MO[d.getUTCMonth()]; };
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// --- segmented activity bar -------------------------------------------------
const tkc = t => { const m = String(t || '').match(/(\d{1,2}):(\d{2})/); return m ? (+m[1]) * 60 + (+m[2]) : null; };
// One activity block, positioned on the shared clock axis so it reads against the top ruler.
// Colour = on-time (green) vs past-21:30 (red). The block shows the activity NAME (when wide) + its DURATION.
function seg(st) {
  const s = st.s, d = Math.max(5, st.d || 0), end = s + d;
  const left = P(s), w = Math.max(0.5, P(end) - left);
  const key = st.key != null ? st.key : nk(st.name);
  let cls = st.opt ? 'seg opt' : s >= 1440 ? 'seg late pm' : end > 1290 ? 'seg late' : 'seg ok';
  if (st.hub) cls = 'seg hub' + (st.hub.approx ? ' approx' : '');   // locked: a flight/train you cannot move
  else if (st.bonus) cls += ' bonusseg';                            // on the timeline, but not committed clock
  const m = st.meal ? ' mealseg' : '';                                   // NB: not "meal" — that clashes with the old meal-pip rule (translateX(-50%))
  const named = w >= 11;                                                 // room for the activity name
  // The hub block used to carry a padlock. It said "fixed" but not WHAT is fixed —
  // the mode icon says both: this reserved time is the flight/train/ferry itself.
  // A provisional time keeps its '~' after the icon.
  const HUB_ICON = { 'Flight': '✈️', 'High-speed train': '\u{1F684}', 'Maglev': '\u{1F685}',
                     'Ferry': '⛴️', 'Bus': '\u{1F68C}', 'Car': '\u{1F697}' };
  const lock = st.hub ? `<span class="lk">${HUB_ICON[st.hub.mode] || '\u{1F686}'}${st.hub.approx ? '~' : ''}</span>` : '';
  const nm = named ? `<span class="sn">${lock}${esc(st.name)}</span>` : lock;
  const dd = w >= 3 ? `<span class="sd">${d}m</span>` : '';              // duration where it fits
  const tight = named ? '' : ' tight';                                   // narrow blocks drop padding so they never inflate past their slot
  const pidAttr = st.pid ? ` data-pid="${esc(st.pid)}"` : '';            // opens the detail panel
  let tip = `${st.name} · ${hhmm(s)}–${hhmm(end)} · ${d}m${st.opt ? ' (optional)' : ''}`;
  if (st.hub) {
    const h = st.hub;
    tip = h.role === 'depart'
      ? `${h.number || h.mode} ${h.route || ''} departs ${h.departTime}\nBe at ${h.terminal ? h.terminal + ' ' : ''}the ${h.mode === 'Flight' ? 'airport' : h.mode === 'Ferry' ? 'wharf' : 'station'} by ${h.beThereBy} — ${d}m check-in${h.approx ? '\n⚠ time is provisional (tickets not on sale yet)' : ''}`
      : `${h.number || h.mode} ${h.route || ''} arrives ${h.arriveTime}\n${d}m to clear${h.terminal ? ' ' + h.terminal : ''} — out by ${h.clearBy}${h.approx ? '\n⚠ time is provisional' : ''}`;
  } else if (st.bonus) tip += ' · bonus / swap — not part of the committed plan';
  return `<div class="${cls}${m}${tight}" data-key="${esc(key)}"${pidAttr} role="button" tabindex="0" style="left:${left.toFixed(2)}%;width:${w.toFixed(2)}%" title="${esc(tip)}">${nm}${dd}</div>`;
}
const renderTrack = segs => (segs || []).map(seg).join('');
// The end of the day is a block like any other: it begins the moment you get home and is
// sized to its own label. Anchored right when it would otherwise run off the end of the track.
// `key` makes the chip a third view of the same thing — table row, timeline chip and
// map pin all selecting together, which is how every other stop on this page behaves.
function homeSeg(endMin, label, kind, tip, key, pid) {
  const over = endMin > T1;                       // past the right edge of the clock entirely
  const left = P(endMin);
  const pos = (over || left > 86) ? 'right:2px' : `left:${left.toFixed(2)}%`;
  const sel = key ? ` data-key="${esc(key)}" role="button" tabindex="0"` : '';
  return `<div class="seg homeseg ${kind}${over ? ' broken' : ''}${key ? ' pick' : ''}"${sel}${pid ? ` data-pid="${esc(pid)}"` : ''} style="${pos}" title="${esc(tip)}">${over ? '⇥ ' : ''}${label}</div>`;
}

// --- the day's verdict, formed ONCE ------------------------------------------
// Every "is this day late?" question on the page — header cards, city counts, the bad-only filter,
// the row badge, the bar's end marker — resolves through here, and here reads rebuilt.json: the
// same committed plan the rows below render. That is the whole point. The header and the rows
// disagreed because they used to consult different oracles.
const T_LATE = 21 * 60 + 30, T_SEVERE = 22 * 60 + 30;
const RBof = d => REBUILT.days[`${d.city}|${d.day}`] || null;
const missingRB = DATA.filter(d => !RBof(d));
if (missingRB.length) console.warn('!! no committed plan for:', missingRB.map(d => `${d.city} d${d.day}`).join(', '),
  '— these days fall back to the raw snapshot and will read differently from the rest of the page.');
function verdict(d) {
  const RB = RBof(d);
  const endMin = RB ? RB.endMin : d.endMin;
  const missed = !!(RB && RB.missed);
  const sev = (missed || endMin > T_SEVERE) ? 'severe' : endMin > T_LATE ? 'moderate' : 'ok';
  return { RB, endMin, missed, sev, late: sev !== 'ok' };
}
const V = new Map(DATA.map(d => [d, verdict(d)]));

const stat = (icon, n, k, id = '') => `<div class="stat"${id ? ` id="${esc(id)}"` : ''}>${ms(icon, 'stic')}<div><div class="n">${esc(n)}</div><div class="k">${esc(k)}</div></div></div>`;
const distance = TRIP.distanceLabel || `≈${Math.round(TRIP.distanceKm).toLocaleString('en-US')} km`;
const route = TRIP.routes;
const walkingTime = fmtDur(route.walk.minutes);
const statsHTML = `<div class="statgroup"><div class="statlabel">The journey</div><div class="statrow">`
  + stat('calendar_month', TRIP.days, 'days')
  + stat('bedtime', TRIP.nights, 'nights')
  + stat('location_city', TRIP.cities, 'cities')
  + stat('route', distance, 'across China')
  + stat('place', TRIP.activities, 'scheduled activities', 'tripActivities')
  + stat('flight', TRIP.flights, 'internal flights')
  + stat('train', TRIP.trains, 'internal trains')
  + `</div></div><div class="statgroup"><div class="statlabel">Between stops</div><div class="statrow">`
  + stat('local_taxi', route.didi.count, `Didi rides · ≈${Math.round(route.didi.km).toLocaleString('en-US')} km`)
  + stat('subway', route.metro.count, `metro trips · ≈${Math.round(route.metro.km).toLocaleString('en-US')} km`)
  + stat('directions_walk', route.walk.count, `walks · ≈${route.walk.km.toFixed(1)} km`)
  + stat('schedule', walkingTime, 'estimated walking time')
  + `</div></div>`;

// top clock: even 3-hour fragments anchored at 05:00 (the first activity of the trip), plus the special 21:30 target
const clock = [[300,'05'],[420,'07'],[540,'09'],[660,'11'],[780,'13'],[900,'15'],[1020,'17'],[1140,'19'],[1260,'21'],[1380,'23'],[1500,'01'],[1620,'03']];
// a small grey clock strip sits directly above each day's bars, so the scale is always in view
const miniAx = `<div class="miniax">` + clock.map(([m, l]) => `<span class="mtk" style="left:${P(m)}%">${l}</span>`).join('') + `</div>`;
// the same fragment lines run down through every bar so each block reads against the clock
const gridHTML = clock.map(([m]) => `<div class="gl" style="left:${P(m)}%"></div>`).join('');
// the sane window (07:00 → 21:30) is shaded rather than labelled, so it costs no vertical space
const BAND = `linear-gradient(90deg,var(--surface-2) 0 ${P(420).toFixed(3)}%,var(--band) ${P(420).toFixed(3)}% ${P(1290).toFixed(3)}%,var(--surface-2) ${P(1290).toFixed(3)}% 100%)`;

// NIGHT, shaded onto each day's own track.
//
// Shaded from CIVIL DUSK, not sunset: there is about half an hour of usable light
// after the sun goes down, and several stops are deliberately placed in it (Lion
// Hill at 19:44 against a 20:22 Lijiang dusk; Jingshan at 18:00 against 19:47).
// Darkening from sunset would black out exactly the slots the re-plan chose.
//
// Per day rather than once for the page, because the trip crosses 15 degrees of
// latitude and 20 of longitude on a single clock: Lijiang goes dark at 20:22 and
// Shanghai at 18:37, an hour and three quarters apart. One shared band would be
// wrong for almost every day of the trip.
//
// Layered UNDER the sane-hours band with a translucent ink so the band, the grid
// lines and the blocks all still read through it.
const NIGHT_INK = 'color-mix(in srgb, var(--ink) 17%, transparent)';
function bandFor(d) {
  const dusk = tkc(d.dusk), dawn = tkc(d.dawn);
  if (dusk == null && dawn == null) return BAND;
  const stops = [];
  // before first light — the axis opens at 05:00, so this catches the dawn shoots
  if (dawn != null && dawn > T0) stops.push(`${NIGHT_INK} 0 ${P(dawn).toFixed(3)}%`);
  else stops.push('transparent 0 0%');
  if (dusk != null) {
    stops.push(`transparent ${P(dawn != null && dawn > T0 ? dawn : T0).toFixed(3)}% ${P(dusk).toFixed(3)}%`);
    // …and after dark, all the way to the end of the axis (which runs to 04:00 next day)
    stops.push(`${NIGHT_INK} ${P(dusk).toFixed(3)}% 100%`);
  }
  return `linear-gradient(90deg,${stops.join(',')}),${BAND}`;
}
// rebuilt.json carries names, not ids, so the pid is resolved by name against the
// day's own stops (and then anywhere in the trip) — the same two-step lib-plan.mjs
// already uses to match a stop that moved between days.
let PID_BY_NAME = new Map();
const pidOf = n => PID_BY_NAME.get(nk(n)) || null;

// The IDEA counts the app shows on its day cards — activity / lunch / dinner
// suggestions — sitting on the left beside the date, because they describe what is
// still open about the day and belong next to which day it is.
//
// The place count is NOT here any more. It used to render as a fourth badge in this
// row while the header separately printed "N stops" two spans earlier — the same
// number, from the same expression, twice on one line in two different treatments.
// One count survives, in the `.stops` chip the header already had, and it moved to
// the right-hand end with the verdict flag. See the dhead assembly below.
//
// A badge is omitted at zero, exactly as in the app — a settled day stays quiet.
// UNLIKE the app, the count is written out in words next to the icon ("💡 2 ideas",
// not "💡2") — this page has the horizontal room a phone card does not, and a spelled
// label needs no decoding on first read.
function dayBadges(d) {
  const ideas = d.ideas || [];
  const nAct = ideas.filter(i => i.kind === 'activity').length;
  const nLunch = ideas.filter(i => (i.meals || []).includes('lunch')).length;
  const nDin = ideas.filter(i => (i.meals || []).includes('dinner')).length;
  // The icons are the app's own (CountBadges.tsx): lightbulb / lunch_dining /
  // dinner_dining as Material Symbols, not lookalike emoji.
  // The badge says the whole category name. It used to strip "activity " off, so the
  // three kinds read "lunch ideas / dinner ideas / ideas" — and the unqualified one
  // looked like a total rather than the third sibling.
  const b = (n, icon, label, cls) => n > 0
    ? `<span class="cbdg ${cls}" title="${esc(n + ' ' + label + (n === 1 ? '' : 's'))}">${ms(icon)} ${n} ${esc(label + (n === 1 ? '' : 's'))}</span>` : '';
  const inner = b(nAct, 'lightbulb', 'activity idea', 'id-a')
    + b(nLunch, 'lunch_dining', 'lunch idea', 'id-l')
    + b(nDin, 'dinner_dining', 'dinner idea', 'id-d');
  // No wrapper at all on a day with nothing outstanding, so its left margin cannot
  // open a gap next to the date on an otherwise settled day.
  return inner ? `<span class="cbdgs">${inner}</span>` : '';
}

let cur = null, out = '';
for (const d of DATA) {
  // resolve this day's names → place ids before anything renders it
  PID_BY_NAME = new Map();
  for (const st of (d.stops || [])) if (st.pid) PID_BY_NAME.set(nk(st.name), st.pid);
  for (const [, st] of STOP_ANY) if (st.pid && !PID_BY_NAME.has(nk(st.name))) PID_BY_NAME.set(nk(st.name), st.pid);
  if (d.city !== cur) {
    if (cur !== null) out += '</div></section>';
    cur = d.city;
    const cd = DATA.filter(x => x.city === d.city), bad = cd.filter(x => V.get(x).late).length;
    out += `<section class="city" data-bad="${bad}" style="--cx:${d.accent}">` +
      `<div class="city-head"><span class="city-dot" style="background:${d.accent}"></span>` +
      `<span class="city-name">${esc(d.city)}</span>` +
      `<span class="city-meta">${cd.length} day${cd.length > 1 ? 's' : ''}${bad ? ` · <b>${bad} late</b>` : ' · all clear'}</span></div><div class="city-body">`;
  }
  const { RB, endMin: rbEnd, sev: dsev, late: dlate } = V.get(d);
  const rbStops = RB ? RB.stops : [];
  // The bar's tooltip reads the committed plan too. It used to quote the snapshot's literal last
  // clock, which is how a bar ending 22:11 could carry a tooltip saying "home 46:03".
  const mealAt = m => { const x = rbStops.find(r => r.meal === m); return x ? hhmm(x.s) : null; };
  const homeTxt = d.home
    ? (RB && RB.homeTravel ? ` · home ${RB.homeTravel.mode} ${RB.homeTravel.minutes}m${RB.homeTravel.km != null ? '/' + RB.homeTravel.km + 'km' : ''}` : '')
    : ' · departs (no return)';
  const tip = esc(`${d.city} Day ${d.day} · ${wd(d.date)} ${dm(d.date)}\n`
    + `${rbStops.filter(r => !r.meal).length} stops · ${mealAt('lunch') ? 'lunch ' + mealAt('lunch') : 'no lunch'}`
    + ` · ${mealAt('dinner') ? 'dinner ' + mealAt('dinner') : 'no dinner'}${homeTxt}`
    + ` · ${d.home ? 'home' : 'out'} ${EL(rbEnd)}`);
  const advOf = n => (d.stops || []).find(x => x.name === n) || STOP_ANY.get(n) || {};
  // `edge` carries the travel group's left/right rule down through the BODY. The rule
  // was only ever on the header cell and the footer label, so the line appeared above
  // the table and below it with nothing joining the two — see the .b3 note in the
  // stylesheet. Every cell in the column now states its own edge.
  const cell = (min, on, ttl, edge) => `<td class="tm tv${on ? ' rec' : ''}${edge ? ' ' + edge : ''}"${ttl ? ` title="${ttl}"` : ''}>${min != null ? fmtDur(min) : '—'}</td>`;

  // "Travel to next" means exactly that: row i carries the leg OUT of it, which is the travelIn of
  // row i+1 — and the last row carries the leg home. Previously each row showed its own travelIn
  // under a "to next" header, so every leg was displayed one row late and the trip home never
  // appeared at all.
  const legOut = i => (i + 1 < rbStops.length)
    ? rbStops[i + 1].travelIn
    : (RB && RB.homeTravel ? { ...RB.homeTravel, est: RB.homeTravel.estimated } : null);

  // Which meals actually have a venue behind them. Read once here because both the
  // table rows and the add-buttons further down need the same answer, and two reads of
  // "is dinner decided?" is how they would come to disagree.
  const mealsDecided = d.mealsDecided || { lunch: null, dinner: null };
  const rows = rbStops.map((r, ri) => {
    const a = advOf(r.name);
    const isHub = !!r.hub, isMeal = !!r.meal;
    const tag = isHub ? ' <span class="tag">' + (r.hub.role === 'depart' ? 'depart' : 'arrive') + '</span>'
      : isMeal ? ' <span class="tag">meal</span>' : '';
    const cls = [isMeal ? 'rmeal' : '', isHub ? 'rhub' : ''].filter(Boolean).join(' ');
    // "Which of today's stops must be booked?" — answered in the table itself,
    // from the same snapshot state the app's bookings tab reads (a.booking is
    // place.booking_state), so the two surfaces cannot disagree.
    //
    // A LUNCH OR DINNER WITH NO VENUE IS ALWAYS STILL TO BOOK. That is what an open
    // slot means, and it needs no data to say so — which is the point, because the
    // tag used to come only from a place row's booking_state, and an open slot has no
    // place row. So the two days that happened to have a restaurant attached showed
    // "book" and the other 54 showed nothing, on a trip where not one meal is
    // arranged. Breakfast is excluded: it comes with the room.
    const undecidedMeal = (r.meal === 'lunch' || r.meal === 'dinner') && !mealsDecided[r.meal];
    const bkg = undecidedMeal ? ' <span class="tag bkg">book</span>'
      : a.booking === 'to-book' ? ' <span class="tag bkg">book</span>'
      : a.booking === 'booked' ? ' <span class="tag bkd">booked</span>' : '';
    const why = [a.resnote, a.resbasis].filter(Boolean).join(' — ');
    // advOf only searches the ORIGINAL day's stops, so a stop moved in from another day had no
    // Advice at all. Fall back to the researched value the rebuild already resolved for it.
    const advMin = a.res ?? r.advice ?? null;
    const adv = advMin != null
      ? `<td class="tm sug${a.resconf === 'low' ? ' lowconf' : ''}"${why ? ` title="${esc(why)}"` : ''}>${fmtDur(advMin)}${a.resconf === 'low' ? '<span class="qm">?</span>' : ''}</td>`
      : `<td class="tm sug">—</td>`;
    const t = legOut(ri);
    const isLast = ri === rbStops.length - 1;
    const dest = isLast ? '🏠 hotel' : (rbStops[ri + 1] || {}).name;
    const ttl = t
      ? esc(`→ ${dest} · ${t.coloc ? 'same place, no travel'
          : `${t.mode} ${t.minutes}m${t.km != null ? ` / ${t.km} km` : ''}${t.est ? ' (estimated)' : ' (routed)'}`}`)
      : '';
    // A co-located hop is a real, known zero — draw it as 0, not as the "—" that means "no data".
    const trav = !t
      ? '<td class="tm tv b3">—</td><td class="tm tv">—</td><td class="tm tv b3r">—</td>'
      : t.coloc
        ? `<td class="tm tv coloc b3 b3r" colspan="3" title="${ttl}">· same place ·</td>`
        : cell(t.mode === 'walk' ? t.minutes : null, t.mode === 'walk', ttl, 'b3')
          + cell(t.mode === 'metro' ? t.minutes : null, t.mode === 'metro', ttl)
          + cell(t.mode === 'didi' ? t.minutes : null, t.mode === 'didi', ttl, 'b3r');
    // A dwell cut short by a closing time must SAY so — otherwise a shorter Total silently reads as
    // "this is all it needs" instead of "this is all the day could buy".
    // The overrun is REPORTED, not applied — the plan's dwell is whatever Postgres
    // says. This used to read "Cut short", from when the canvas shortened the stop
    // itself; it no longer does, so saying so would be describing the wrong thing.
    const capT = r.cap
      ? esc(`${r.name} closes ${r.cap.closes}${r.cap.lastEntry ? ` (last entry ${r.cap.lastEntry})` : ''}. `
          + (r.cap.tooLate ? 'YOU ARRIVE AFTER LAST ENTRY.' : `This stop runs ${r.cap.lost} min past closing.`)
          + (r.cap.conf && r.cap.conf !== 'high' ? ` Closing time confidence: ${r.cap.conf}.` : ''))
      : '';
    const totCls = 'tm tot b1r' + (r.cap ? (r.cap.tooLate ? ' capbad' : ' capped') : '');
    const ic = ms(stopIcon(r), isMeal ? 'ic-meal' : isHub ? 'ic-hub' : 'ic-act');
    // data-pid: clicking a row opens the place drawer, exactly like the timeline
    // block and the suggestion rows — a row IS its stop, so it opens the same panel.
    const rowPid = pidOf(r.name);
    return `<tr class="${cls}" data-key="${esc(nk(r.name))}"${rowPid ? ` data-pid="${esc(rowPid)}"` : ''}><td class="an"><span class="anmain">${ic}<span class="antext">${esc(r.name)}</span>${tag}${bkg}</span></td>`
      + `<td class="tm b1">${hhmm(r.s)}</td><td class="tm">${hhmm(r.s + r.d)}</td>`
      + `<td class="${totCls}"${capT ? ` title="${capT}"` : ''}>${fmtDur(r.d)}${r.cap ? '<span class="qm">⏱</span>' : ''}</td>`
      + adv + trav + `</tr>`;
  }).join('');

  // …and the day's last line: getting back to the hotel. The bar has always ended with
  // a 🏠 chip, but the table stopped at the final sight, so the row that answers "and
  // then what?" — the one you look for when a day runs late — was the only part of the
  // evening you could not read. It carries the hotel's own icon and opens the hotel's
  // panel; its travel columns are blank because the leg home is already stated on the
  // row above, under "travel to next", which is exactly where it belongs.
  // data-key on the same terms as every other row: it is a view of a pin, so it
  // selects, focuses the hotel and un-focuses on a second click. Only when the map can
  // actually place it — a key with no marker behind it is a dead click.
  const homeKey = RB && RB.homeStop && RB.homeStop.lat != null ? nk(RB.homeStop.name) : null;
  const homeRow = RB && RB.homeStop
    ? `<tr class="rhome"${RB.homeStop.pid ? ` data-pid="${esc(RB.homeStop.pid)}"` : ''}${homeKey ? ` data-key="${esc(homeKey)}"` : ''}>`
      + `<td class="an"><span class="anmain">${ms(RB.homeStop.icon || 'hotel', 'ic-home')}<span class="antext">${esc(RB.homeStop.name)}</span>`
      + ` <span class="tag">end of day</span></span></td>`
      + `<td class="tm b1">${hhmm(RB.homeStop.s)}</td><td class="tm">—</td>`
      + `<td class="tm tot b1r">—</td><td class="tm sug">—</td>`
      + `<td class="tm tv b3">—</td><td class="tm tv">—</td><td class="tm tv b3r">—</td></tr>`
    : '';

  // Ideas belong to the day they FELL OUT OF, not to the city at large — a parked stop is only
  // meaningful next to the day whose budget rejected it. Moves are listed separately: a stop that
  // simply changed day is still happening and must not be mistaken for a cut.
  const dayKey = `${d.city}|${d.day}`;
  const dayIdeas = (REBUILT.ideasByDay || {})[dayKey] || [];
  // Suggestions for the day, not casualties of it. These are Postgres ideas — places
  // no committed stop uses, tagged with the day they want — so nothing here was
  // "dropped"; the old heading described a planner's cut list.
  // The Kind column carries the lunch/dinner/activity split that four separate tables
  // used to; `kind` is place.type + meal_pref, the catalogue's own opinion rather than
  // a guess made here.
  // "Add to lunch/dinner" — the same POST the app's button makes, to the same endpoint.
  //
  // A TAKEN SLOT IS NOT A DEAD BUTTON. It used to render greyed out with "remove it
  // first", which is true of a single `assign` call — /api/meal answers 409 when the
  // slot already holds a venue — but reads as "this page is broken", and it fires on
  // most days of the trip, because most days have their meals decided. Beijing d1 is
  // the plain case: both slots are filled (Quanjude, Kao Rou Ji), so its one suggestion
  // offered two dead buttons and no way to act on it.
  //
  // The endpoint also takes `remove`, which is exactly what the app's own meal sheet
  // uses to change a choice. So the button offers the swap instead: remove the sitting
  // venue, then assign this one — two calls the client makes in order, the same two the
  // app makes. Only a missing token disables it now, because without one nothing can be
  // written at all.
  const mealBtn = (i, meal) => {
    const taken = mealsDecided[meal];
    const ttl = taken
      ? `${meal} is ${taken} — replace it with ${i.full || i.name}`
      : `Put ${i.full || i.name} in this day's ${meal} slot`;
    return `<button class="addbtn${taken ? ' swap' : ''}"`
      + ` data-pid="${esc(i.id || '')}" data-city="${esc(d.cityId)}" data-day="${d.day}"`
      + ` data-meal="${meal === 'lunch' ? 'Lunch' : 'Dinner'}" data-name="${esc(i.full || i.name)}"`
      + (taken ? ` data-replace="${esc(taken)}"` : '')
      + ` title="${esc(ttl)}">`
      + `${taken ? `replace ${meal}` : `+ ${meal}`}</button>`;
  };

  // ONE suggestions table, not four. The lunch/dinner/activity split moved into the
  // existing Kind column — the split tables answered "is dinner decided?" by making
  // you scan four headings, and a venue good for both meals appeared twice. A row's
  // icon is the same glyph the app would give it as a stop; meal-capable rows keep
  // both their +lunch/+dinner buttons side by side.
  const ideaRows = dayIdeas.map(i => {
    const a = advOf(i.name); const res = a.res ?? i.res;
    const isFood = (i.meals || []).length > 0 || i.kind === 'food';
    // data-key is what makes the row a VIEW OF A PIN rather than a line of text: the
    // one selection path (selectKey) keys on it, so a suggestion row now highlights,
    // focuses its marker and un-focuses on a second click, exactly as a stop row does.
    // Only rows the map can actually place get one — a key with no marker behind it
    // would select nothing and read as a dead click.
    const mapped = i.lat != null && i.lng != null;
    const canPlan = !!i.id && !isFood;
    return `<tr${i.id ? ` data-pid="${esc(i.id)}" data-idea-id="${esc(i.id)}" data-idea-name="${esc(i.name)}"` : ''}`
      + `${mapped ? ` data-key="${esc(nk(i.name))}"` : ''}${canPlan ? ' draggable="true" title="Drag onto the Proposed timeline to plan it"' : ''} class="idrow${canPlan ? ' planidea' : ''}">`
      + `<td class="an"><span class="anmain">${ms(i.icon || (isFood ? 'restaurant' : 'lightbulb'), isFood ? 'ic-meal' : 'ic-act')}<span class="antext">${esc(i.name)}</span>${i.booking === 'to-book' ? ' <span class="tag bkg">book</span>' : i.booking === 'booked' ? ' <span class="tag bkd">booked</span>' : ''}</span></td>`
      + `<td class="tm sug">${res != null ? fmtDur(res) : '—'}</td>`
      + `<td class="iw">${esc(i.kind)}</td>`
      + `<td class="iw addcell">`
      + ((i.meals || []).includes('lunch') ? mealBtn(i, 'lunch') : '')
      + ((i.meals || []).includes('dinner') ? mealBtn(i, 'dinner') : '')
      + (canPlan ? `<button type="button" class="planadd" draggable="true" title="Drag this onto Proposed, or click to add it">↗ <span>plan</span></button>` : '')
      + `</td></tr>`;
  }).join('');
  const ideasHTML = dayIdeas.length
    ? `<table class="acts idt"><thead><tr><th>Name</th><th>Advice</th><th>Kind</th><th>Add</th></tr></thead><tbody>${ideaRows}</tbody></table>`
    : '';

  // Per-day map: the stops in the sequence you actually walk them, numbered. Uses the proposed
  // order when there is one, otherwise the current order. Coordless places are skipped.
  // Look the stop up across the WHOLE snapshot, not just this day's original stop list: a stop that
  // moved between days has no entry on its new day, so every moved stop was silently dropped from
  // the map ("6 stops without coordinates" on a day whose six stops all had perfectly good coords).
  const mapSeq = rbStops.map(r => {
    const st = (d.stops || []).find(x => x.name === r.name) || STOP_ANY.get(r.name);
    return st || { name: r.name };
  });
  const pts = mapSeq.map((s, i) => (s && s.lat != null)
    ? { n: i + 1, lat: s.lat, lng: s.lng, name: s.name || s.label, k: nk(s.name || s.label),
        t: s.ptype === 'Hotel' ? 'hotel' : s.ptype === 'Food' ? 'food' : 'act' } : null).filter(Boolean);
  // The day's SUGGESTIONS, on the same map. "Is this on the way, or across town?" is
  // the first question you ask of a suggestion, and until now the page listed them by
  // name only and could not answer it. They are pins like any other — selectable from
  // their row, focusing and un-focusing exactly as a committed stop does.
  //
  // Drawn UNNUMBERED and hollow, and deliberately left out of both the route line and
  // the fitted bounds: they are not part of the sequence you walk, and letting one
  // stretch the frame would zoom the actual day out to accommodate a maybe.
  const ideaPts = dayIdeas
    .filter(i => i.lat != null && i.lng != null)
    .map(i => ({ lat: i.lat, lng: i.lng, name: i.name, k: nk(i.name), t: 'idea' }));
  const noCoord = mapSeq.length - pts.length;
  // The hotel is the day's last pin, numbered after the last stop and joined to the
  // route line — so the map ends where the table now ends. Appended after `noCoord` is
  // measured, which counts stops only and must not be moved by it.
  if (RB && RB.homeStop && RB.homeStop.lat != null) {
    pts.push({ n: pts.length + 1, lat: RB.homeStop.lat, lng: RB.homeStop.lng,
      name: RB.homeStop.name, k: nk(RB.homeStop.name), t: 'hotel' });
  }
  // The heading said "Route map — Beijing, day 3" directly under a card header reading
  // "Day 3 · Thu 13 Aug" inside a section headed "Beijing": the same three facts, twice,
  // two lines apart. "numbered in the committed order" went with it — the numbers run
  // 1, 2, 3 down a table in that order, which says it without a caption. What is left
  // is the one thing the heading knows that nothing else does: when a stop is missing.
  const mapHTML = `<div class="mapwrap"><div class="chgh">Route map` +
    `${noCoord ? ` <span class="apx">· ${noCoord} stop${noCoord > 1 ? 's' : ''} without coordinates not shown</span>` : ''}</div>` +
    `<div class="mlg"><span class="mit"><i class="msw mk-act"></i>activity</span>` +
    `<span class="mit"><i class="msw mk-food"></i>food</span>` +
    `<span class="mit"><i class="msw mk-hotel"></i>hotel</span>` +
    (ideaPts.length ? `<span class="mit"><i class="msw mk-idea"></i>suggestion</span>` : '') + `</div>` +
    `<div class="map" data-pts="${esc(JSON.stringify(pts))}" data-ideas="${esc(JSON.stringify(ideaPts))}"></div></div>`;

  // Two CARDS, each with a stated title — "Activity" (the committed table) and
  // "Suggestions" (the merged ideas table) — so the unfold reads as two clearly
  // bounded sections rather than tables running into each other.
  // The section's own count matches its rows, hotel line included.
  const nAct = rbStops.length + (RB && RB.homeStop ? 1 : 0);
  const detail = `<div class="detail">`
    + `<div class="sect activitysect"><div class="secth">${ms('event_note', 'sic')}<span>Activity</span><span class="scount">${nAct}</span>`
    + `<button type="button" class="adjustplan">Adjust planning</button></div>`
    + `<table class="acts">`
    // The three "Proposed" columns are gone. They were the other half of a
    // Current-vs-Proposed comparison, and the Proposed side has been empty by design
    // since the re-plan was committed — so every row carried three em-dashes under a
    // heading for a plan that does not exist. Their width went to the columns that do
    // carry something, which is why Start/End/Total now sit further right and breathe.
    // The group footer no longer says "Current" either: with nothing to contrast
    // against, the word was only meaningful next to the column that went.
    + `<colgroup><col class="wA"><col class="wT"><col class="wT"><col class="wTot">`
    + `<col class="wSug">`
    + `<col class="wTv"><col class="wTv"><col class="wTv"></colgroup><thead>`
    + `<tr><th>Activity</th><th class="b1">Start</th><th>End</th><th class="b1r">Total</th>`
    + `<th class="hsug">Advice</th>`
    + `<th class="htv b3">Walk</th><th class="htv">Metro</th><th class="htv b3r">DiDi</th></tr></thead>`
    + `<tbody>${rows}${homeRow}</tbody>`
    + `<tfoot><tr class="grp gfoot"><th></th><th class="b1 b1r gh" colspan="3">Scheduled</th><th></th>`
    + `<th class="gt b3 b3r" colspan="3">Travel to next</th></tr></tfoot></table></div>`
    + (ideasHTML ? `<div class="sect"><div class="secth">${ms('lightbulb', 'sic')}<span>Suggestions</span><span class="scount">${dayIdeas.length}</span></div>${ideasHTML}</div>` : '')
    + `</div>`;
  // Proposed second line — an alternative segmented track under the day's bar (only when a proposal exists).
  // The proposed bar is deliberately empty — this is where the next review pass will write.
  const row2 = `<div class="row2"><div class="track2 empty plantrack">${gridHTML}<div class="plandrop">Drop a suggestion to start planning</div></div>`
    + `<div class="planfeedback"><span class="planstatus"></span><span class="recalcstamp">Loading last recalculation…</span></div>`
    + `<div class="plancontrols"><button class="plancancel">Cancel</button><button class="planconfirm">Save planning</button></div></div>`;
  // What you actually do today — the same number the app's badge shows, counted the
  // same way (Day.activityCount): the whole timeline, meals and the hotel included,
  // minus bonuses, which are alternatives rather than commitments. This chip used to
  // count only the non-meal stops while the app counted everything but the hotel, so
  // Beijing d1 read "6 places" here and "9" there, for one day, from one database.
  const nActivities = RB
    ? RB.stops.filter(x => !x.bonus).length + (RB.homeStop ? 1 : 0)
    : d.nStops;
  const badge = RB
    // Three states, because two could not tell the truth: a day ending 22:11 is counted in the
    // header's "11 later" but was badged "✓ fits", so the row contradicted the card above it.
    ? (RB.missed ? '<span class="pflag warn2">misses a departure</span>'
      : dsev === 'severe' ? '<span class="pflag warn2">late finish</span>'
      : dsev === 'moderate' ? '<span class="pflag warn2">past 21:30</span>'
      : '<span class="pflag ok2">✓ fits</span>')
    : '';
  out += `<div class="day${dlate ? '' : ' ok-day'} has-prop" data-city-id="${esc(d.cityId)}" data-day="${d.day}" data-date="${esc(d.date)}">` +
    `<div class="dhead" role="button" tabindex="0" aria-expanded="false" aria-label="Day ${d.day} ${esc(d.city)} — expand activities">` +
      `<span class="cv">›</span><span class="dnum">Day ${d.day}</span>` +
      `<span class="ddate">${wd(d.date)} ${dm(d.date)}</span>` +
      // Left of the row: what is still OPEN about this day (idea badges).
      dayBadges(d) +
      // Right of the row, pinned to the card's corner by `margin-left:auto`: the day's
      // verdict, then the one place count. This chip is the header's own `.stops`
      // treatment with the app's `place` glyph inside it — the "N stops" text chip and
      // the separate "📍 N places" badge were the same number rendered twice, side by
      // side, so they read as two facts when there was only ever one.
      `<span class="dright">${badge}` +
      `<span class="stops nplaces" title="${esc(nActivities + ' activit' + (nActivities === 1 ? 'y' : 'ies') + ' today — the whole day, meals and the hotel included')}">${ms('place')}<span class="nplacevalue">${nActivities}</span> activit<span class="nplacesuffix">${nActivities === 1 ? 'y' : 'ies'}</span></span>` +
      `</span></div>` +
    mapHTML + miniAx + `<div class="row"><div class="track" style="background:${bandFor(d)}" title="${tip}${d.sunset ? `\nSunset ${d.sunset} · dark from ${d.dusk}` : ''}">${gridHTML}${renderTrack(rbStops.map(r => ({ s: r.s, d: r.d, name: r.name, meal: !!r.meal, key: nk(r.name), hub: r.hub || null, pid: pidOf(r.name) })))}` +
      // The end chip exists to answer "when am I back at the hotel?". A departure
      // day has no such moment — it ends WITH the hub block, which already carries
      // the mode icon and the departure time — so a second chip right after it read
      // as a phantom activity that was on the timeline but not in the table
      // (and said ✈ even for trains and ferries). Render it only when there is a
      // home to get back to.
      (d.home ? homeSeg(rbEnd, `🏠 ${EL(rbEnd)}`,
        dsev === 'severe' ? 'bad' : dsev === 'moderate' ? 'warn' : 'ok2',
        `Back to the hotel — ${EL(rbEnd)}`, homeKey, RB && RB.homeStop ? RB.homeStop.pid : null) : '') + `</div></div>` +
    row2 + detail + '</div>';
}
out += '</div></section>';

const script = `
const chart=document.getElementById("chart");
function toggleRow(row){const day=row.closest(".day");if(!day)return;const open=day.classList.toggle("open");row.setAttribute("aria-expanded",open);if(open)initMaps(day);}
// Selecting a stop moves in by this much from the day's fitted scale, so you get the streets
// around it while still seeing where the neighbouring stops are. A fixed setZoom(16) used to
// land at street level with the rest of the route — the reason you clicked — off-screen; the
// cap keeps that from happening on a day whose stops are already tightly clustered.
const SEL_ZOOM_IN=2, SEL_ZOOM_MAX=15;

// Drop the current selection. refit=true pulls the map back to the whole day; the caller skips it
// when it is about to focus a different stop, which would otherwise fit-then-pan in the same tick.
// (No backticks in here — this whole script is itself a template literal.)
function clearSel(day,refit){
  day.querySelectorAll(".seg.sel").forEach(s=>s.classList.remove("sel"));
  day.querySelectorAll("tr.rowsel").forEach(r=>r.classList.remove("rowsel"));
  const m0=day.querySelector(".map");
  if(m0&&m0._marks&&window.google&&google.maps){
    Object.keys(m0._marks).forEach(k=>{const m=m0._marks[k];m.setIcon(mkIcon(m.__col,false,m.__idea));m.setZIndex(m.__idea?0:1);});
    if(refit&&m0._gmap&&m0._bounds){const g=m0._gmap,b=m0._bounds;
      g.getCenter()?g.fitBounds(b,40):google.maps.event.addListenerOnce(g,"idle",()=>g.fitBounds(b,40));}
  }
}

// THE selection path. A timeline block and its table row are two views of one stop, so both go
// through here — highlight the block, highlight the row, focus the pin. Whichever you clicked is
// already where you are looking, so only the OTHER one gets scrolled into view.
function selectKey(day,key,from){
  if(!day||!key) return;
  const sel='[data-key="'+CSS.escape(key)+'"]';
  // read before clearing, so clicking the current selection toggles it off
  const already=!!(day.querySelector(".seg.sel"+sel)||day.querySelector("tr.rowsel"+sel));
  clearSel(day,already);          // refit only when this click is a deselect
  if(already) return;

  if(!day.classList.contains("open")){day.classList.add("open");const r=day.querySelector(".dhead");if(r)r.setAttribute("aria-expanded",true);initMaps(day);}
  day.querySelectorAll(".seg"+sel).forEach(s=>s.classList.add("sel"));
  const tr=day.querySelector("tr"+sel);
  if(tr){tr.classList.add("rowsel");if(from!=="row")tr.scrollIntoView({block:"nearest"});}

  const mp=day.querySelector(".map");
  if(!mp||!mp._marks||!window.google||!google.maps) return;
  Object.keys(mp._marks).forEach(k=>{const m=mp._marks[k];m.setIcon(mkIcon(m.__col,k===key,m.__idea));m.setZIndex(k===key?999:m.__idea?0:1);});
  const hit=mp._marks[key];
  if(!hit||!mp._gmap) return;
  // Clicking a row deep in a long table can leave the map scrolled off the top — zooming a map
  // you cannot see is no use. "nearest" is a no-op when it is already on screen.
  if(from==="row")mp.scrollIntoView({block:"nearest"});
  const g=mp._gmap,go=()=>{
    g.panTo(hit.getPosition());
    const fit=mp._fitZoom;
    g.setZoom(fit!=null?Math.min(fit+SEL_ZOOM_IN,SEL_ZOOM_MAX):Math.min(g.getZoom()+SEL_ZOOM_IN,SEL_ZOOM_MAX));
  };
  g.getCenter()?go():google.maps.event.addListenerOnce(g,"idle",go);
}
const selectSeg=el=>selectKey(el.closest(".day"),el.dataset.key,"seg");
chart.addEventListener("click",e=>{const s=e.target.closest(".seg");if(s&&s.dataset.key){e.stopPropagation();selectSeg(s);}},true);
chart.addEventListener("keydown",e=>{if(e.key!=="Enter"&&e.key!==" ")return;const s=e.target.closest(".seg");if(s&&s.dataset.key){e.preventDefault();e.stopPropagation();selectSeg(s);}},true);
// A row in the activity table is the same stop as its block — clicking it selects and focuses the
// pin exactly the same way. Suggestion rows carry data-key too, whenever the map can place them,
// so one path serves both: a stop has a timeline block AND a pin, an idea has only a pin, and
// selectKey simply finds whichever exist.
chart.addEventListener("click",e=>{if(e.target.closest("button"))return;const r=e.target.closest("tr[data-key]");if(r)selectKey(r.closest(".day"),r.dataset.key,"row");});
chart.addEventListener("click",e=>{const r=e.target.closest(".dhead");if(r)toggleRow(r);});
chart.addEventListener("keydown",e=>{if(e.key!=="Enter"&&e.key!==" ")return;const r=e.target.closest(".dhead");if(r){e.preventDefault();toggleRow(r);}});
// expand-all / collapse-all
const xa=document.getElementById("xAll");if(xa)xa.onclick=()=>{const any=!document.querySelector(".day.open");document.querySelectorAll(".day").forEach(d=>{d.classList.toggle("open",any);const r=d.querySelector(".dhead");if(r)r.setAttribute("aria-expanded",any);});xa.textContent=any?"Collapse all":"Expand all";};
// light / dark toggle — always starts light (the OS setting is deliberately
// ignored; this canvas is read in light mode), then lets you override.
const thm=document.getElementById("thm");if(thm){const root=document.documentElement;
  let mode="light";
  const apply=()=>{root.setAttribute("data-theme",mode);thm.setAttribute("aria-pressed",mode==="light");thm.textContent=mode==="dark"?"☀ Light":"☾ Dark";};
  apply();thm.onclick=()=>{mode=mode==="dark"?"light":"dark";apply();};}
// Per-day maps build lazily on first open — 36 Leaflet instances up front would be wasteful,
// and a map sized inside a hidden container comes out wrong.
window.__gmready=false;
window.gmapsReady=function(){window.__gmready=true;document.querySelectorAll(".day.open").forEach(initMaps);};
const MKCOL={act:"#2F6FB5",food:"#C77A16",hotel:"#2E7D57",idea:"#6A5FA0"};
/* A suggestion is drawn INVERTED — white fill, thick coloured ring — the same
   "under consideration" treatment the app gives a candidate venue, so a maybe can
   never be mistaken for something already in the day. Selected, it fills in and
   grows like any other pin. */
function mkIcon(col,on,idea){return{path:google.maps.SymbolPath.CIRCLE,scale:on?15:idea?9:11,
  fillColor:idea&&!on?"#ffffff":col,fillOpacity:1,
  strokeColor:on?"#C1443C":idea?col:"#ffffff",strokeWeight:on?4:idea?3:2};}
function drawMapRoute(el,pts,fit){var map=el._gmap;if(!map)return;(el._routeMarks||[]).forEach(function(m){m.setMap(null);});if(el._routeLine)el._routeLine.setMap(null);
  el._routeMarks=[];var path=pts.map(function(p){return{lat:p.lat,lng:p.lng};});
  el._routeLine=new google.maps.Polyline({path:path,strokeOpacity:0,map:map,icons:[{icon:{path:"M 0,-1 0,1",strokeOpacity:.75,strokeColor:"#8C5A2B",scale:3},offset:"0",repeat:"12px"}]});
  var b=new google.maps.LatLngBounds(),marks=Object.assign({},el._ideaMarks||{});pts.forEach(function(p){var col=MKCOL[p.t]||MKCOL.act;
    var m=new google.maps.Marker({position:{lat:p.lat,lng:p.lng},map:map,icon:mkIcon(col,false),label:{text:String(p.n),color:"#ffffff",fontSize:"11px",fontWeight:"700"},title:p.n+". "+p.name});m.__col=col;
    var iw=new google.maps.InfoWindow({content:"<b>"+p.n+". "+p.name+"</b>"});m.addListener("click",function(){iw.open({anchor:m,map:map});});marks[p.k]=m;b.extend(m.getPosition());el._routeMarks.push(m);});
  el._marks=marks;el._bounds=b;if(fit&&pts.length){map.fitBounds(b,40);if(pts.length===1)google.maps.event.addListenerOnce(map,"idle",function(){map.setZoom(15);});google.maps.event.addListenerOnce(map,"idle",function(){el._fitZoom=map.getZoom();});}}
function drawMapIdeas(el,ideas){if(!el._gmap)return;Object.keys(el._ideaMarks||{}).forEach(function(k){el._ideaMarks[k].setMap(null);});var map=el._gmap,ideaMarks={};ideas.forEach(function(p){
  var col=MKCOL.idea,m=new google.maps.Marker({position:{lat:p.lat,lng:p.lng},map:map,icon:mkIcon(col,false,true),title:"Suggestion: "+p.name,zIndex:0});m.__col=col;m.__idea=true;
  var iw=new google.maps.InfoWindow({content:"<b>"+p.name+"</b><br>suggestion — not scheduled"});m.addListener("click",function(){iw.open({anchor:m,map:map});});ideaMarks[p.k]=m;});el._ideaMarks=ideaMarks;}
function initMaps(day){
  if(!window.__gmready||!window.google||!google.maps)return;
  day.querySelectorAll(".map").forEach(el=>{
    if(el.dataset.init)return; el.dataset.init="1";
    let pts=[];try{pts=JSON.parse(el.dataset.pts||"[]");}catch(e){}
    if(!pts.length){el.innerHTML='<div class="mapempty">No coordinates for this day</div>';return;}
    const map=new google.maps.Map(el,{mapTypeControl:false,streetViewControl:false,fullscreenControl:false,
      gestureHandling:"cooperative",zoomControl:true});
    /* Suggestions: same marker registry, so selecting one from its row works through
       exactly the same path as a stop. NOT added to the bounds — the frame belongs to the day
       you are actually doing, and one idea across town would zoom the whole route out
       to fit a maybe. Selecting it still pans there. */
    let ideas=[];try{ideas=JSON.parse(el.dataset.ideas||"[]");}catch(e){}
    el._gmap=map;drawMapIdeas(el,ideas);drawMapRoute(el,pts,true);
  });
}
if(window.__gmready)document.querySelectorAll(".day.open").forEach(initMaps);

/* ---- interactive proposed plan -----------------------------------------
   The upper bar is the committed plan. The lower bar is a disposable Postgres
   draft: drag an activity idea into it, reorder blocks, resize dwell, then
   Confirm or Cancel. Exact times always come back from the scheduling oracle. */
var PLAN=new WeakMap();
var PLAN_TIME=new Intl.DateTimeFormat("en-GB",{timeZone:"Asia/Shanghai",hour:"2-digit",minute:"2-digit",hour12:false});
var PLAN_STAMP=new Intl.DateTimeFormat("en-GB",{timeZone:"Asia/Shanghai",day:"2-digit",month:"short",year:"numeric",hour:"2-digit",minute:"2-digit",second:"2-digit",hour12:false,timeZoneName:"short"});
var PLAN_DRAG=null;
var AUTH={token:"",user:null};
try{AUTH.token=localStorage.getItem("china-planner-session")||"";localStorage.removeItem("china-planner-key");}catch(_){}
function authMessage(msg,bad){var el=document.getElementById("authmsg");if(el){el.textContent=msg||"";el.classList.toggle("bad",!!bad);}}
function authHeaders(){return AUTH.token?{"x-trip-token":AUTH.token}:{};}
function saveAuth(token,user){AUTH.token=token||"";AUTH.user=user||null;window.__TOK=AUTH.token;try{if(AUTH.token)localStorage.setItem("china-planner-session",AUTH.token);else localStorage.removeItem("china-planner-session");}catch(_){}renderAuth();}
function renderAuth(){var state=document.getElementById("authstate"),signin=document.getElementById("googleSignIn"),manage=document.getElementById("manageUsers"),out=document.getElementById("signOut"),badge=document.getElementById("plannerBadge"),badgeText=document.getElementById("plannerBadgeText");if(!state)return;
  state.innerHTML="";if(AUTH.user){if(AUTH.user.picture){var img=document.createElement("img");img.src=AUTH.user.picture;img.alt="";state.appendChild(img);}var label=document.createElement("span");label.textContent=AUTH.user.name||AUTH.user.email;state.appendChild(label);signin.hidden=true;manage.hidden=false;out.hidden=false;if(badge)badge.classList.add("on");if(badgeText)badgeText.textContent="Planning unlocked";authMessage("Planning enabled");}
  else{var label=document.createElement("span");label.textContent="View only";state.appendChild(label);signin.hidden=false;manage.hidden=true;out.hidden=true;if(badge)badge.classList.remove("on");if(badgeText)badgeText.textContent="Sign in required to plan";}}
function renderGoogleButton(){var host=document.getElementById("googleSignIn");if(!host||AUTH.user||host.dataset.ready||!window.google||!google.accounts||!google.accounts.id||!window.__GOOGLE_CLIENT_ID)return;host.dataset.ready="1";
  google.accounts.id.initialize({client_id:window.__GOOGLE_CLIENT_ID,callback:googleCredential,auto_select:false,cancel_on_tap_outside:true});
  google.accounts.id.renderButton(host,{type:"standard",theme:"outline",size:"medium",shape:"pill",text:"signin_with"});}
function googleCredential(response){if(!response||!response.credential)return;authMessage("Signing in…");fetch(window.__APP+"/api/auth/google",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({credential:response.credential})})
  .then(function(r){return r.json().catch(function(){return {};}).then(function(j){if(!r.ok||!j.token)throw new Error(j.error||"Sign-in failed.");return j;});})
  .then(function(j){saveAuth(j.token,j.user);})
  .catch(function(err){saveAuth("",null);authMessage(err.message||"This account is not allowed to plan.",true);});}
function restoreAuth(){renderAuth();if(!AUTH.token){renderGoogleButton();return;}fetch(window.__APP+"/api/auth/google",{headers:authHeaders()})
  .then(function(r){if(!r.ok)throw new Error();return r.json();}).then(function(j){saveAuth(AUTH.token,j.user);})
  .catch(function(){saveAuth("",null);renderGoogleButton();});}
function signOutPlanner(){if(window.google&&google.accounts&&google.accounts.id)google.accounts.id.disableAutoSelect();saveAuth("",null);var host=document.getElementById("googleSignIn");if(host){host.innerHTML="";host.dataset.ready="";}renderGoogleButton();authMessage("Signed out");}
function plannerToken(){if(AUTH.token)return AUTH.token;authMessage("Sign in with Google to plan.",true);var bar=document.getElementById("authbar");if(bar)bar.scrollIntoView({behavior:"smooth",block:"center"});return "";}
function adminRequest(method,body){var opts={method:method,headers:authHeaders()};if(body){opts.headers["Content-Type"]="application/json";opts.body=JSON.stringify(body);}return fetch(window.__APP+"/api/admins",opts).then(function(r){return r.json().catch(function(){return {};}).then(function(j){if(!r.ok)throw new Error(j.error||"Request failed.");return j;});});}
function renderAdmins(admins){var body=document.getElementById("adminRows");if(!body)return;body.innerHTML="";(admins||[]).forEach(function(a){var tr=document.createElement("tr"),who=document.createElement("td"),box=document.createElement("div");box.className="amwho";
  if(a.picture){var img=document.createElement("img");img.src=a.picture;img.alt="";box.appendChild(img);}var text=document.createElement("div"),name=document.createElement("div"),email=document.createElement("div");name.className="amname";name.textContent=a.name||a.email;email.className="amemail";email.textContent=a.email;text.appendChild(name);text.appendChild(email);box.appendChild(text);who.appendChild(box);tr.appendChild(who);
  var actions=document.createElement("td"),remove=document.createElement("button");remove.className="amremove";remove.type="button";remove.textContent="Remove";remove.dataset.email=a.email;remove.disabled=AUTH.user&&a.email===AUTH.user.email;actions.appendChild(remove);tr.appendChild(actions);body.appendChild(tr);});}
function loadAdmins(){var status=document.getElementById("adminStatus");if(status)status.textContent="Loading…";return adminRequest("GET").then(function(j){renderAdmins(j.admins);if(status)status.textContent="";}).catch(function(e){if(status)status.textContent=e.message;});}
document.getElementById("manageUsers").addEventListener("click",function(){document.getElementById("adminModal").classList.add("on");loadAdmins();});
document.getElementById("signOut").addEventListener("click",signOutPlanner);
document.getElementById("adminModal").addEventListener("click",function(e){if(e.target.classList.contains("ambg")||e.target.classList.contains("amclose")){this.classList.remove("on");return;}var remove=e.target.closest(".amremove");if(!remove)return;var status=document.getElementById("adminStatus");status.textContent="Removing…";adminRequest("DELETE",{email:remove.dataset.email}).then(function(j){renderAdmins(j.admins);status.textContent="";}).catch(function(err){status.textContent=err.message;});});
document.getElementById("adminForm").addEventListener("submit",function(e){e.preventDefault();var input=document.getElementById("adminEmail"),status=document.getElementById("adminStatus"),email=input.value.trim().toLowerCase();if(!email)return;status.textContent="Adding…";adminRequest("POST",{email:email}).then(function(j){input.value="";renderAdmins(j.admins);status.textContent="";}).catch(function(err){status.textContent=err.message;});});
var authWait=setInterval(function(){if(window.google&&google.accounts&&google.accounts.id){clearInterval(authWait);renderGoogleButton();}},200);setTimeout(function(){clearInterval(authWait);if((!window.google||!google.accounts||!google.accounts.id)&&!AUTH.user)authMessage("Google sign-in could not load. Refresh to try again.",true);},10000);restoreAuth();
function planClock(iso){return iso?PLAN_TIME.format(new Date(iso)):"—";}
function planMin(iso){if(!iso)return 300;var p=PLAN_TIME.formatToParts(new Date(iso)),h=0,m=0;
  p.forEach(function(x){if(x.type==="hour")h=+x.value;if(x.type==="minute")m=+x.value;});
  var n=h*60+m;return n<300?n+1440:n;}
function planPct(n){return Math.max(0,Math.min(100,(n-300)/1380*100));}
function planDur(n){n=Math.round(n||0);return n<60?n+"m":Math.floor(n/60)+"h"+(n%60?String(n%60).padStart(2,"0"):"");}
function planState(day){var s=PLAN.get(day);if(!s){s={diff:null,busy:false,started:false,live:null};PLAN.set(day,s);}return s;}
function planMessage(day,msg,bad){var x=day.querySelector(".planstatus");if(x){x.textContent=msg;x.classList.toggle("bad",!!bad);}}
function showRecalculated(day,iso){var x=day.querySelector(".recalcstamp");if(x)x.textContent=iso?"Last recalculated "+PLAN_STAMP.format(new Date(iso)):"Recalculation time unavailable";}
function planPost(day,action,extra){var s=planState(day);s.busy=true;day.classList.add("planbusy");planMessage(day,action==="commit"?"Recalculating routes and all times, saving, then publishing…":"Recalculating day…");
  var body=Object.assign({action:action,cityId:day.dataset.cityId,day:+day.dataset.day},extra||{});
  var token=plannerToken();if(!token){s.busy=false;day.classList.remove("planbusy");planMessage(day,"Planning was not unlocked.",true);return Promise.reject(new Error("Planning was not unlocked."));}
  return fetch(window.__APP+"/api/plan",{method:"POST",headers:{"Content-Type":"application/json","x-trip-token":token},body:JSON.stringify(body)})
    .then(function(r){return r.text().then(function(t){var j=null;try{j=JSON.parse(t);}catch(_){}if(!r.ok||!j||!j.ok)throw new Error((j&&j.error)||"Planning request failed.");return j;});})
    .finally(function(){s.busy=false;day.classList.remove("planbusy");});
}
function ensurePlan(day){var s=planState(day);if(s.started&&s.diff)return Promise.resolve(s.diff);
  return planPost(day,"start").then(function(j){s.started=true;s.diff=j.diff;renderDraft(day,j.diff);return j.diff;});}
function draftStops(diff){return (diff&&diff.deltas||[]).filter(function(x){return x.change!=="removed";}).sort(function(a,b){return a.seq-b.seq;});}
function planKey(name){return String(name||"").toLowerCase().replace(/[^a-z0-9]+/g,"");}
function mapType(x){return x.meal||x.placeKind==="food"?"food":x.placeKind==="hotel"?"hotel":"act";}
function mapPointsFromDiff(diff){var pts=draftStops(diff).filter(function(x){return x.lat!=null&&x.lng!=null;}).map(function(x,i){return{n:i+1,lat:+x.lat,lng:+x.lng,name:x.name,k:planKey(x.name),t:mapType(x)};});
  var h=diff&&diff.homeAfter;if(h&&h.lat!=null&&h.lng!=null)pts.push({n:pts.length+1,lat:+h.lat,lng:+h.lng,name:h.name,k:planKey(h.name),t:"hotel"});return pts;}
function mapIdeasFromLive(v,used){return (v&&v.ideas||[]).filter(function(x){return x.lat!=null&&x.lng!=null&&!used.has(String(x.placeId));}).map(function(x){return{lat:+x.lat,lng:+x.lng,name:x.name,k:planKey(x.name),t:"idea"};});}
function setDayMap(day,pts,ideas){day.querySelectorAll(".map").forEach(function(el){el.dataset.pts=JSON.stringify(pts);if(ideas){el.dataset.ideas=JSON.stringify(ideas);if(el._gmap)drawMapIdeas(el,ideas);}if(el._gmap)drawMapRoute(el,pts,true);});}
function refreshDraftMap(day,diff){var live=planState(day).live,used=new Set(draftStops(diff).map(function(x){return String(x.placeId||"");}));setDayMap(day,mapPointsFromDiff(diff),mapIdeasFromLive(live,used));}
function makeDraftSeg(d){var start=planMin(d.startAfter),left=planPct(start),right=planPct(start+Math.max(5,d.dwellAfter||0));
  var el=document.createElement("div");el.className="pseg"+(d.locked?" locked":"")+(d.isInfeasible?" infeasible":"")+(d.change==="added"?" added":"");
  el.style.left=left.toFixed(2)+"%";el.style.width=Math.max(.7,right-left).toFixed(2)+"%";el.dataset.stopId=d.stopId;el.dataset.seq=d.seq;
  el.draggable=!d.locked;el.title=d.name+" · "+planClock(d.startAfter)+" · "+planDur(d.dwellAfter)+(d.locked?" · fixed":" · drag to reorder; resize the right edge");
  var name=document.createElement("span");name.className="pn";name.textContent=d.name;el.appendChild(name);
  var dur=document.createElement("span");dur.className="pd";dur.textContent=planDur(d.dwellAfter);el.appendChild(dur);
  if(!d.locked){if(d.removable){var rm=document.createElement("button");rm.className="prm";rm.type="button";rm.textContent="×";rm.title="Move to Suggestions";el.appendChild(rm);}
    var h=document.createElement("span");h.className="ph";h.title="Drag to change time here";el.appendChild(h);}
  return el;
}
function renderDraft(day,diff){var s=planState(day);s.diff=diff;var tr=day.querySelector(".plantrack");if(!tr)return;
  tr.querySelectorAll(".pseg").forEach(function(x){x.remove();});
  draftStops(diff).forEach(function(d){tr.appendChild(makeDraftSeg(d));});
  if(diff&&diff.homeAfter){var hm=document.createElement("div"),arrival=diff.homeAfter.arrivalAt||diff.endsAfter,at=planMin(arrival),pct=planPct(at);hm.className="pseg phome locked";if(pct>92){hm.style.right="2px";hm.classList.add("edge");}else hm.style.left=pct.toFixed(2)+"%";hm.style.width="auto";hm.title=diff.homeAfter.name+" · "+planClock(arrival);hm.textContent="🏠 "+planClock(arrival);tr.appendChild(hm);}
  tr.classList.remove("empty");day.classList.add("planning");
  var end=diff&&diff.endsAfter?planClock(diff.endsAfter):"—";
  var debt=diff&&diff.rushDebtAfter?" · "+planDur(diff.rushDebtAfter)+" rushed":"";
  planMessage(day,"Draft ends "+end+debt+" · drag blocks or resize their right edge");refreshDraftMap(day,diff);
}
function stopBeforeX(day,clientX,exclude){var tr=day.querySelector(".plantrack"),r=tr.getBoundingClientRect();
  var minute=300+Math.max(0,Math.min(1,(clientX-r.left)/r.width))*1380,last=null;
  draftStops(planState(day).diff).filter(function(x){return x.stopId!==exclude;}).forEach(function(x){if(planMin(x.startAfter)<=minute)last=x;});return last;}
function clearPlan(day,msg){var s=planState(day);s.diff=null;s.started=false;day.classList.remove("planning","planbusy");
  var tr=day.querySelector(".plantrack");if(tr){tr.querySelectorAll(".pseg").forEach(function(x){x.remove();});tr.classList.add("empty");}
  planMessage(day,msg||"");if(s.live)refreshLiveMap(day,s.live);
}
function committedFromDiff(day,diff){var top=day.querySelector(".track");if(!top)return;top.querySelectorAll(".seg,.home").forEach(function(x){x.remove();});
  draftStops(diff).forEach(function(d){var start=planMin(d.startAfter),left=planPct(start),right=planPct(start+Math.max(5,d.dwellAfter||0));var el=document.createElement("div");
    el.className="seg "+(d.locked?"hub":"ok")+(d.isInfeasible?" late":"");el.style.left=left.toFixed(2)+"%";el.style.width=Math.max(.7,right-left).toFixed(2)+"%";el.dataset.key=d.name.toLowerCase().replace(/[^a-z0-9]+/g,"");if(d.placeId)el.dataset.pid=d.placeId;
    el.title=d.name+" · "+planClock(d.startAfter)+" · "+planDur(d.dwellAfter);var n=document.createElement("span");n.className="sn";n.textContent=d.name;el.appendChild(n);var q=document.createElement("span");q.className="sd";q.textContent=planDur(d.dwellAfter);el.appendChild(q);top.appendChild(el);});
  if(diff&&diff.endsAfter){var minute=planMin(diff.endsAfter),home=document.createElement("div"),hn=diff.homeAfter&&diff.homeAfter.name||"Back to the hotel";home.className="seg homeseg ok2";home.style[minute>1487?"right":"left"]=minute>1487?"2px":planPct(minute).toFixed(2)+"%";home.title=hn+" · "+planClock(diff.endsAfter);if(diff.homeAfter&&diff.homeAfter.placeId)home.dataset.pid=diff.homeAfter.placeId;home.textContent="🏠 "+planClock(diff.endsAfter);top.appendChild(home);}
  draftStops(diff).filter(function(d){return d.change==="added"&&d.placeId;}).forEach(function(d){var row=day.querySelector('[data-idea-id="'+CSS.escape(d.placeId)+'"]');if(row)row.hidden=true;});
}
function liveDiff(v){var stops=v.stops||[],last=stops[stops.length-1],ends=v.home&&v.home.arrivalAt||last&&last.end&&new Date(new Date(last.end).getTime()+(last.travelMinToNext||0)*60000).toISOString();return{endsAfter:ends||null,homeAfter:v.home||null,deltas:stops.map(function(s){return{stopId:s.stopId,originStopId:s.stopId,name:s.name,seq:s.seq,placeId:s.placeId,slot:s.slot,meal:s.meal,placeKind:s.kind,lat:s.lat,lng:s.lng,locked:s.locked,removable:s.removable,startAfter:s.start,dwellAfter:s.dwell,change:"unchanged",isInfeasible:s.infeasible};})};}
function refreshLiveMap(day,v){var diff=liveDiff(v),used=new Set(draftStops(diff).map(function(x){return String(x.placeId||"");}));setDayMap(day,mapPointsFromDiff(diff),mapIdeasFromLive(v,used));}
function minuteSpan(a,b){return a&&b?Math.max(0,Math.round((new Date(b)-new Date(a))/60000)):null;}
function addCell(row,text,cls){var td=document.createElement("td");if(cls)td.className=cls;td.textContent=text==null||text===""?"—":text;row.appendChild(td);return td;}
function captureNameMarkup(day){var names=new Map();day.querySelectorAll("tr td.an").forEach(function(cell){var row=cell.closest("tr"),copy=cell.cloneNode(true);copy.querySelectorAll(".removeplan").forEach(function(x){x.remove();});var html=copy.innerHTML;if(row&&row.dataset.pid)names.set("p:"+row.dataset.pid,html);if(row&&row.dataset.key)names.set("n:"+row.dataset.key,html);});return names;}
function liveIcon(s){if(s.meal==="breakfast")return"bakery_dining";if(s.meal==="lunch")return"lunch_dining";if(s.meal==="dinner")return"dinner_dining";if(s.kind==="hotel")return"hotel";if(s.kind==="show")return"theater_comedy";if(s.kind==="shopping")return"storefront";if(s.kind==="food")return"restaurant";return"place";}
function appendLiveTags(main,item){main.querySelectorAll(".tag").forEach(function(x){x.remove();});if(item.meal){var meal=document.createElement("span");meal.className="tag ml";meal.textContent="meal";main.appendChild(meal);}if(item.booking){var book=document.createElement("span");book.className="tag "+(item.booking==="booked"?"bkd":"bkg");book.textContent=item.booking==="booked"?"booked":"book";main.appendChild(book);}}
function restoreNameCell(cell,item,names){var html=names.get("n:"+planKey(item.name))||(item.placeId&&names.get("p:"+item.placeId));if(html)cell.innerHTML=html;else{var main=document.createElement("span");main.className="anmain";var icon=document.createElement("span");icon.className="msym "+(item.meal||item.kind==="food"?"ic-meal":"ic-act");icon.setAttribute("aria-hidden","true");icon.textContent=liveIcon(item);var label=document.createElement("span");label.className="antext";label.textContent=item.name;main.appendChild(icon);main.appendChild(label);cell.appendChild(main);}var wrap=cell.querySelector(".anmain")||cell;appendLiveTags(wrap,item);}
function reconcileActivities(day,v,names){var table=day.querySelector(".detail .acts:not(.idt)"),body=table&&table.tBodies[0];if(!body)return;body.textContent="";
  (v.stops||[]).slice().sort(function(a,b){return a.seq-b.seq;}).forEach(function(s){var row=document.createElement("tr");row.className="idrow";row.dataset.stopId=s.stopId;row.dataset.key=planKey(s.name);if(s.placeId)row.dataset.pid=s.placeId;var name=addCell(row,"","an");restoreNameCell(name,s,names);name.title=s.name;if(s.removable){row.classList.add("canremove");var rm=document.createElement("button");rm.type="button";rm.className="removeplan";rm.dataset.stopId=s.stopId;rm.dataset.placeId=s.placeId||"";rm.dataset.name=s.name;rm.textContent="Move to suggestions";name.appendChild(rm);}addCell(row,planClock(s.start),"tm");addCell(row,planClock(s.end),"tm");var total=minuteSpan(s.start,s.end);addCell(row,total==null?"—":planDur(total),"tm");addCell(row,s.advised==null?"—":planDur(s.advised),"tm sug");addCell(row,s.walkMin==null?"—":planDur(s.walkMin),"tm");addCell(row,s.metroMin==null?"—":planDur(s.metroMin),"tm");addCell(row,s.didiMin==null?"—":planDur(s.didiMin),"tm");body.appendChild(row);});
  if(v.home){var h=document.createElement("tr");h.className="rhome idrow";h.dataset.key=planKey(v.home.name);if(v.home.placeId)h.dataset.pid=v.home.placeId;var hn=addCell(h,"","an");restoreNameCell(hn,{placeId:v.home.placeId,name:v.home.name||"Back to the hotel",kind:"hotel"},names);addCell(h,planClock(v.home.arrivalAt),"tm");for(var i=0;i<6;i++)addCell(h,"—",i===2?"tm sug":"tm");body.appendChild(h);}
  var count=table.closest(".sect").querySelector(".scount");if(count)count.textContent=body.rows.length;
}
function reconcileIdeas(day,ideas,names){var current=new Map((ideas||[]).map(function(x){return[String(x.placeId),x];})),table=day.querySelector(".detail .acts.idt"),sect=table&&table.closest(".sect"),detail=day.querySelector(".detail");
  if(!table&&current.size&&detail){sect=document.createElement("div");sect.className="sect";var hd=document.createElement("div");hd.className="secth";var ttl=document.createElement("span");ttl.textContent="Suggestions";var cnt=document.createElement("span");cnt.className="scount";hd.appendChild(ttl);hd.appendChild(cnt);sect.appendChild(hd);table=document.createElement("table");table.className="acts idt";table.innerHTML="<thead><tr><th>Name</th><th>Advice</th><th>Kind</th><th>Add</th></tr></thead><tbody></tbody>";sect.appendChild(table);detail.appendChild(sect);}
  if(!table)return;var body=table.tBodies[0],seen=new Set();body.querySelectorAll("[data-idea-id]").forEach(function(row){var id=row.dataset.ideaId,idea=current.get(id);row.hidden=!idea;if(idea){seen.add(id);row.dataset.ideaName=idea.name;var cell=row.querySelector("td.an");if(cell)restoreNameCell(cell,idea,names);}});
  current.forEach(function(idea,id){if(seen.has(id))return;var row=document.createElement("tr");row.className="idrow"+(idea.kind==="food"?"":" planidea");row.dataset.pid=id;row.dataset.key=planKey(idea.name);row.dataset.ideaId=id;row.dataset.ideaName=idea.name;if(idea.kind!=="food"){row.draggable=true;row.title="Drag onto the Proposed timeline to plan it";}var name=addCell(row,"","an");restoreNameCell(name,idea,names);addCell(row,idea.advised==null?"—":planDur(idea.advised),"tm sug");addCell(row,idea.kind||"activity","iw");var action=addCell(row,"","iw addcell");if(idea.kind!=="food"){var button=document.createElement("button");button.type="button";button.className="planadd";button.draggable=true;button.title="Drag this onto Proposed, or click to add it";button.textContent="↗ plan";action.appendChild(button);}body.appendChild(row);});
  var visible=body.querySelectorAll("tr:not([hidden])").length;if(sect){sect.hidden=!visible;var count=sect.querySelector(".scount");if(count)count.textContent=visible;}
}
function liveIdeaMeals(idea){return(idea&&idea.meals||[]).map(function(x){return String(x).toLowerCase();});}
function appendLiveBadge(box,n,icon,label,cls){if(!n)return;var b=document.createElement("span"),g=document.createElement("span");b.className="cbdg "+cls;b.title=n+" "+label+(n===1?"":"s");g.className="msym";g.setAttribute("aria-hidden","true");g.textContent=icon;b.appendChild(g);b.appendChild(document.createTextNode(" "+n+" "+label+(n===1?"":"s")));box.appendChild(b);}
function reconcileDayHeader(day,v){var head=day.querySelector(".dhead"),right=head&&head.querySelector(".dright");if(!head||!right)return;var old=head.querySelector(".cbdgs");if(old)old.remove();var ideas=v.ideas||[],nAct=ideas.filter(function(i){return i.kind!=="food";}).length,nLunch=ideas.filter(function(i){return liveIdeaMeals(i).includes("lunch");}).length,nDinner=ideas.filter(function(i){return liveIdeaMeals(i).includes("dinner");}).length,box=document.createElement("span");box.className="cbdgs";appendLiveBadge(box,nAct,"lightbulb","activity idea","id-a");appendLiveBadge(box,nLunch,"lunch_dining","lunch idea","id-l");appendLiveBadge(box,nDinner,"dinner_dining","dinner idea","id-d");if(box.childNodes.length)head.insertBefore(box,right);
  var total=(v.stops||[]).length+(v.home?1:0),chip=right.querySelector(".nplaces"),num=chip&&chip.querySelector(".nplacevalue"),suffix=chip&&chip.querySelector(".nplacesuffix");if(num)num.textContent=String(total);if(suffix)suffix.textContent=total===1?"y":"ies";if(chip)chip.title=total+" activit"+(total===1?"y":"ies")+" today — the whole day, meals and the hotel included";
}
function reconcileTripActivityTotal(){var total=Array.from(chart.querySelectorAll(".nplacevalue")).reduce(function(sum,x){return sum+(parseInt(x.textContent||"0",10)||0);},0),target=document.querySelector("#tripActivities .n");if(target)target.textContent=String(total);}
function reconcileDay(day,v){var names=captureNameMarkup(day);planState(day).live=v;committedFromDiff(day,liveDiff(v));reconcileActivities(day,v,names);reconcileIdeas(day,v.ideas||[],names);reconcileDayHeader(day,v);reconcileTripActivityTotal();showRecalculated(day,v.recalculatedAt);refreshLiveMap(day,v);}
function commitDraft(day,fallback){return planPost(day,"commit").then(function(j){if(j.day)reconcileDay(day,j.day);else committedFromDiff(day,fallback||planState(day).diff);clearPlan(day);if(j.publishWarning)planMessage(day,"Plan saved, but mobile publish failed: "+j.publishWarning,true);return j;});}
chart.addEventListener("dragstart",function(e){var idea=e.target.closest(".planidea"),seg=e.target.closest(".pseg");if(!idea&&!seg)return;
  var data=idea?{kind:"idea",placeId:idea.dataset.ideaId,name:idea.dataset.ideaName}:{kind:"stop",stopId:seg.dataset.stopId};
  PLAN_DRAG=data;var payload=JSON.stringify(data);e.dataTransfer.effectAllowed="copyMove";
  /* WebKit and embedded browser surfaces can discard custom drag types from a
     table row. text/plain keeps the payload intact there; application/json is
     retained for browsers that support it. */
  try{e.dataTransfer.setData("application/json",payload);}catch(_){}e.dataTransfer.setData("text/plain",payload);});
chart.addEventListener("dragover",function(e){var tr=e.target.closest(".plantrack");if(tr){e.preventDefault();e.dataTransfer.dropEffect=PLAN_DRAG&&PLAN_DRAG.kind==="idea"?"copy":"move";tr.classList.add("dragover");}});
chart.addEventListener("dragleave",function(e){var tr=e.target.closest(".plantrack");if(tr&&!tr.contains(e.relatedTarget))tr.classList.remove("dragover");});
chart.addEventListener("dragend",function(){PLAN_DRAG=null;chart.querySelectorAll(".plantrack.dragover").forEach(function(x){x.classList.remove("dragover");});});
chart.addEventListener("drop",function(e){var tr=e.target.closest(".plantrack");if(!tr)return;e.preventDefault();tr.classList.remove("dragover");var day=tr.closest(".day"),data=null;
  try{data=JSON.parse(e.dataTransfer.getData("application/json")||e.dataTransfer.getData("text/plain"));}catch(_){}data=data||PLAN_DRAG;PLAN_DRAG=null;if(!data){planMessage(day,"The browser did not provide the dragged activity. Use + plan instead.",true);return;}
  ensurePlan(day).then(function(){var before=stopBeforeX(day,e.clientX,data.stopId||null);
    if(data.kind==="idea")return planPost(day,"add",{placeId:data.placeId,name:data.name,afterSeq:before?before.seq:null});
    return planPost(day,"move",{stopId:data.stopId,afterStopId:before?before.stopId:null});
  }).then(function(j){if(j&&j.diff)renderDraft(day,j.diff);}).catch(function(err){planMessage(day,err.message||"Could not update the draft.",true);});});
chart.addEventListener("click",function(e){var add=e.target.closest(".planadd");if(add){e.preventDefault();e.stopImmediatePropagation();var row=add.closest(".planidea"),day0=add.closest(".day"),s0=planState(day0);if(s0.busy)return;
    ensurePlan(day0).then(function(){var stops=draftStops(planState(day0).diff),last=stops[stops.length-1];return planPost(day0,"add",{placeId:row.dataset.ideaId,name:row.dataset.ideaName,afterSeq:last?last.seq:null});})
      .then(function(j){renderDraft(day0,j.diff);}).catch(function(err){planMessage(day0,err.message||"Could not add the activity.",true);});return;}
  var adjust=e.target.closest(".adjustplan");if(adjust){e.preventDefault();e.stopImmediatePropagation();var ad=adjust.closest(".day");if(planState(ad).busy)return;ensurePlan(ad).then(function(){ad.querySelector(".plantrack").scrollIntoView({block:"center",behavior:"smooth"});}).catch(function(err){planMessage(ad,err.message||"Could not start planning.",true);});return;}
  var moveOut=e.target.closest(".removeplan");if(moveOut){e.preventDefault();e.stopImmediatePropagation();var rd=moveOut.closest(".day");if(planState(rd).busy)return;if(!plannerToken()){planMessage(rd,"Sign in to change the plan.",true);return;}if(!window.confirm('Move "'+moveOut.dataset.name+'" to Suggestions? The day will be recalculated.'))return;
    ensurePlan(rd).then(function(diff){var target=draftStops(diff).find(function(x){return x.originStopId===moveOut.dataset.stopId;});if(!target)throw new Error("This activity is no longer in the current plan.");return planPost(rd,"drop",{stopId:target.stopId});})
      .then(function(j){renderDraft(rd,j.diff);return commitDraft(rd,j.diff);}).catch(function(err){planMessage(rd,err.message||"Could not move the activity to Suggestions.",true);});return;}
  var rm=e.target.closest(".prm");if(rm){e.preventDefault();e.stopPropagation();var day=rm.closest(".day"),seg=rm.closest(".pseg");
    planPost(day,"drop",{stopId:seg.dataset.stopId}).then(function(j){renderDraft(day,j.diff);}).catch(function(err){planMessage(day,err.message,true);});return;}
  var cancel=e.target.closest(".plancancel");if(cancel){var d=cancel.closest(".day");planPost(d,"discard").then(function(){clearPlan(d);}).catch(function(err){planMessage(d,err.message,true);});return;}
  var confirm=e.target.closest(".planconfirm");if(confirm){var d2=confirm.closest(".day"),s=planState(d2);if(!s.diff)return;var kept=s.diff;
    commitDraft(d2,kept).catch(function(err){planMessage(d2,err.message,true);});return;}});
var RESIZE=null;
chart.addEventListener("pointerdown",function(e){var h=e.target.closest(".ph");if(!h)return;e.preventDefault();e.stopPropagation();var seg=h.closest(".pseg"),day=seg.closest(".day"),d=draftStops(planState(day).diff).find(function(x){return x.stopId===seg.dataset.stopId;});if(!d)return;
  RESIZE={day:day,seg:seg,stopId:d.stopId,startX:e.clientX,startMin:d.dwellAfter,track:day.querySelector(".plantrack").getBoundingClientRect()};h.setPointerCapture&&h.setPointerCapture(e.pointerId);});
chart.addEventListener("pointermove",function(e){if(!RESIZE)return;var delta=(e.clientX-RESIZE.startX)/RESIZE.track.width*1380,min=Math.max(5,Math.round((RESIZE.startMin+delta)/15)*15);RESIZE.preview=min;var start=parseFloat(RESIZE.seg.style.left),w=planPct(planMin(draftStops(planState(RESIZE.day).diff).find(function(x){return x.stopId===RESIZE.stopId;}).startAfter)+min)-start;RESIZE.seg.style.width=Math.max(.7,w).toFixed(2)+"%";RESIZE.seg.querySelector(".pd").textContent=planDur(min);});
chart.addEventListener("pointerup",function(){if(!RESIZE)return;var x=RESIZE;RESIZE=null;if(!x.preview||x.preview===x.startMin){renderDraft(x.day,planState(x.day).diff);return;}planPost(x.day,"dwell",{stopId:x.stopId,minutes:x.preview}).then(function(j){renderDraft(x.day,j.diff);}).catch(function(err){planMessage(x.day,err.message,true);});});

/* Reconcile all live planning surfaces at load so a static GitHub Pages build
   never stays stale after a confirmation made from another browser. */
fetch(window.__APP+"/api/plan").then(function(r){return r.json();}).then(function(j){if(!j||!j.ok)return;(j.days||[]).forEach(function(v){var day=chart.querySelector('.day[data-city-id="'+CSS.escape(v.cityId)+'"][data-day="'+v.day+'"]');if(!day)return;
    reconcileDay(day,v);});}).catch(function(){});

/* ---- place detail panel -------------------------------------------------
   Opened from a timeline block or a suggestion row. It renders the SAME fields
   the app's place sheet shows, from places.json, which generate-vizdata writes
   out of the very snapshot the app reads — so the two surfaces cannot describe
   one venue two different ways. */
var PP=document.getElementById("pp"), PPB=PP.querySelector(".ppbox");
function esc2(x){return String(x==null?"":x).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");}
function dur(m){if(m==null)return null;m=Math.round(m);return m<60?m+"m":Math.floor(m/60)+"h"+(m%60?String(m%60).padStart(2,"0"):"");}
function row(k,v){return v?'<div class="pprow"><b>'+esc2(k)+'</b><span>'+esc2(v)+'</span></div>':"";}
function openPlace(pid){
  var p=(window.__PLACES||{})[pid]; if(!p)return;
  var imgs=(p.photos||[]).map(function(u){return '<img loading="lazy" src="'+esc2(u)+'" alt="">';}).join("");
  /* status is already 'To book' / 'Booked' / 'Idea', so a separate booking chip
     repeated it verbatim: "To book · booking: to book". Kept only when it adds
     something the status does not already say. */
  var chips=[p.type, p.category!==p.type?p.category:null, p.status,
             (p.booking && String(p.status).toLowerCase()!==p.booking) ? ("booking: "+p.booking) : null,
             p.meals&&p.meals.length?("good for "+p.meals.join(" / ")):null]
            .filter(Boolean).map(function(c){return '<span class="ppchip">'+esc2(c)+'</span>';}).join("");
  var warn=[p.closedToday?"Closed today.":null,
            p.opensAt?("Opens at "+p.opensAt+" — you arrive before that."):null,
            p.lastEntryAt?("Last entry "+p.lastEntryAt+"."):null,
            p.closesAt?("Closes at "+p.closesAt+" — less time here than planned."):null]
           .filter(Boolean).map(function(w){return '<div class="ppwarn">⚠ '+esc2(w)+'</div>';}).join("");
  var g=p.ratings&&p.ratings.google, t=p.ratings&&p.ratings.trip;
  PPB.innerHTML='<button class="ppx" aria-label="Close">×</button>'
    +'<h3>'+esc2(p.name)+'</h3>'
    +(p.zh?'<div class="ppzh">'+esc2(p.zh)+'</div>':'')
    +(imgs?'<div class="ppimgs">'+imgs+'</div>':'')
    +(chips?'<div class="ppchips">'+chips+'</div>':'')
    +warn
    +(p.desc?'<div class="ppdesc">'+esc2(p.desc)+'</div>':'')
    +row("Advised", dur(p.advised))
    +row("Planned", dur(p.planned))
    +row("Hours", p.hours)
    +row("Price", p.price)
    +(g?row("Google", g.rating+" ★"+(g.reviews?" ("+g.reviews+")":"")):"")
    +(t?row("Trip.com", t.rating+" ★"+(t.reviews?" ("+t.reviews+")":"")):"")
    +(p.coord?row("Coordinates", p.coord.lat.toFixed(5)+", "+p.coord.lng.toFixed(5)):"")
    +(p.planningNote?'<div class="pprow"><b>Why / note</b><span>'+esc2(p.planningNote)+'</span></div>':'')
    +(p.bookingLink?'<div class="pprow"><b>Booking</b><span><a href="'+esc2(p.bookingLink)+'" target="_blank" rel="noopener">open</a></span></div>':'')
    +(p.credit?'<div class="ppcred">Image: '+esc2([p.credit.artist,p.credit.source,p.credit.license].filter(Boolean).join(" · "))+'</div>':'');
  PP.classList.add("on"); document.body.style.overflow="hidden";
  PPB.querySelector(".ppx").focus();
}
function closePlace(){PP.classList.remove("on");document.body.style.overflow="";}
PP.addEventListener("click",function(e){ if(e.target.closest(".ppx")||e.target.classList.contains("ppbg")) closePlace(); });
document.addEventListener("keydown",function(e){ if(e.key==="Escape"&&PP.classList.contains("on")) closePlace(); });
/* A block or row opens the panel.
   CAPTURE PHASE, on document, and that is not incidental: the chart already has a
   capture-phase listener that calls stopPropagation() to handle segment SELECTION,
   so a bubble-phase listener here never fired at all. Document is above the chart,
   so this capture runs first — and it deliberately does NOT stop propagation, so
   selecting the segment still happens underneath the panel. */
document.addEventListener("click",function(e){
  if(e.target.closest(".addbtn,.planadd")) return;
  var el=e.target.closest("[data-pid]");
  if(el&&el.dataset.pid) openPlace(el.dataset.pid);
},true);

/* ---- add a suggestion to a meal slot ------------------------------------
   The same POST the app's own button makes, to the same endpoint, cross-origin.
   The mutation and the publish are two calls by design (see lib/sync/publish.ts):
   a slow publish must never be able to report a committed change as a failure. */
/* Capture too, and this one DOES stop the event: a button press must not also open
   the detail panel behind it. */
document.addEventListener("click",function(e){
  var b=e.target.closest(".addbtn"); if(!b||b.disabled)return;
  e.preventDefault(); e.stopPropagation();
  var msg=b.parentElement.querySelector(".ppmsg")||(function(){var d=document.createElement("div");d.className="ppmsg";b.parentElement.appendChild(d);return d;})();
  var fail=function(t){ msg.textContent=t; msg.style.color="var(--bad)"; b.classList.remove("busy"); b.disabled=false; };
  var token=plannerToken();if(!token){fail("Planning was not unlocked.");return;}
  var swap=b.dataset.replace||null, cleared=false;
  var slot={cityId:b.dataset.city,day:+b.dataset.day,meal:b.dataset.meal};
  var post=function(body){return fetch(window.__APP+"/api/meal",{method:"POST",
    headers:{"Content-Type":"application/json","x-trip-token":token},
    body:JSON.stringify(body)});};
  b.classList.add("busy"); b.disabled=true; msg.style.color="var(--ink-2)";
  msg.textContent=swap?("Removing "+swap+"…"):"Adding…";
  /* Replacing is remove-then-assign, in that order, because assign on its own is
     refused while the slot still holds a venue (409 "Remove it first"). Two calls,
     the same two the app's meal sheet makes. If the REMOVE fails nothing has moved;
     if the assign fails after a successful remove the slot really is empty now, and
     the message says that rather than letting it read as "nothing happened". */
  var step1=swap
    ? post({action:"remove",cityId:slot.cityId,day:slot.day,meal:slot.meal})
        .then(function(r){return r.text().then(function(t){var j=null;try{j=JSON.parse(t);}catch(_){}
          if(!r.ok||!j||!j.ok) throw new Error((j&&j.error)||("Could not clear "+swap+" — nothing was changed."));
          cleared=true; msg.textContent="Adding…";});})
    : Promise.resolve();
  step1.then(function(){
    return post({action:"assign",cityId:slot.cityId,day:slot.day,meal:slot.meal,placeId:b.dataset.pid});
  })
  .then(function(r){return r.text().then(function(t){var j=null;try{j=JSON.parse(t);}catch(_){}
    if(!j){ msg.textContent="Took too long to confirm — it has probably been applied. Refresh the app and check."; msg.style.color="var(--warn)"; return; }
    if(!r.ok||!j.ok){ fail((j.error||"That did not work.")+(cleared?(" "+swap+" was already removed, so the slot is empty now."):"")); return; }
    msg.textContent="Added. Publishing…"; msg.style.color="var(--ok)";
    return fetch(window.__APP+"/api/sync",{method:"POST",headers:{"x-trip-token":token}})
      .then(function(){ msg.textContent=(swap?"Replaced ":"Added to ")+b.dataset.meal.toLowerCase()+". Rebuild this page to see it move."; })
      .catch(function(){ msg.textContent="Added. The app copy is still catching up."; });
  });})
  .catch(function(err){ fail((err&&err.message)?err.message:"No connection — nothing was changed."); });
},true);
`;

const EXTRA = `<style>
.wrap .dhead{display:flex;align-items:center;gap:9px;cursor:pointer;padding:7px 4px 5px;border-radius:8px;}
.wrap .dhead:hover{background:var(--surface-2);}
.wrap .dhead:focus-visible{outline:2px solid var(--target);outline-offset:-2px;}
.wrap .dnum{font-size:13.5px;font-weight:800;letter-spacing:-.01em;}
.wrap .ddate{font-size:11.5px;color:var(--ink-3);font-variant-numeric:tabular-nums;}
.wrap .day.ok-day .dnum{color:var(--ink-2);}
.wrap .stops{margin-top:0;}
.wrap .pflag{display:inline-block;font-size:8.5px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;color:var(--target);background:color-mix(in srgb,var(--target) 14%,transparent);border:1px solid color-mix(in srgb,var(--target) 34%,transparent);border-radius:5px;padding:1px 6px;}
.wrap .pflag.ok2{color:var(--ok);background:color-mix(in srgb,var(--ok) 13%,transparent);border-color:color-mix(in srgb,var(--ok) 34%,transparent);}
.wrap .pflag.warn2{color:var(--warn);background:color-mix(in srgb,var(--warn) 13%,transparent);border-color:color-mix(in srgb,var(--warn) 34%,transparent);}
.wrap .row2{display:block;padding:0 0 6px;}
.wrap .planlabel{display:flex;align-items:center;gap:10px;margin:2px 0 4px;font-size:9.5px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;color:var(--ink-3);}
.wrap .planstatus{font-size:10px;font-weight:600;letter-spacing:0;text-transform:none;color:var(--ink-3);}
.wrap .planstatus.bad{color:var(--bad);}
.wrap .recalcstamp{font-size:9px;font-weight:600;letter-spacing:0;text-transform:none;color:var(--ink-3);font-variant-numeric:tabular-nums;}
.wrap .plantrack{position:relative;min-height:32px;border:1px dashed var(--line-strong);border-radius:7px;background:var(--surface-2);overflow:visible;}
.wrap .plantrack.empty{opacity:1;border-color:color-mix(in srgb,var(--cx,var(--target)) 55%,var(--line));background:color-mix(in srgb,var(--cx,var(--target)) 5%,var(--surface));}
.wrap .plantrack.dragover{opacity:1;border-color:var(--target);background:color-mix(in srgb,var(--target) 9%,var(--surface));box-shadow:0 0 0 3px color-mix(in srgb,var(--target) 13%,transparent);}
.wrap .plandrop{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:850;color:var(--cx,var(--target));text-shadow:0 0 18px color-mix(in srgb,var(--cx,var(--target)) 36%,transparent);pointer-events:none;}
.wrap .planning .plandrop{display:none;}
.wrap .planfeedback{min-height:18px;padding-top:4px;}
.wrap .planfeedback .planstatus:empty{display:none;}
.wrap .planfeedback .planstatus:not(:empty)+.recalcstamp{display:none;}
.wrap .pseg{position:absolute;top:4px;height:24px;border-radius:6px;background:color-mix(in srgb,var(--target) 18%,var(--surface));border:1px solid color-mix(in srgb,var(--target) 58%,transparent);display:flex;align-items:center;gap:4px;padding:0 7px;min-width:12px;box-sizing:border-box;cursor:grab;z-index:3;overflow:visible;}
.wrap .pseg.added{background:color-mix(in srgb,#6A5FA0 20%,var(--surface));border-color:#6A5FA0;}
.wrap .pseg.locked{background:var(--surface-2);border-style:dashed;cursor:not-allowed;}
.wrap .pseg.phome{min-width:max-content;max-width:none;transform:none;background:color-mix(in srgb,var(--target) 18%,var(--surface));border-color:color-mix(in srgb,var(--target) 58%,transparent);border-style:solid;z-index:4;font:800 9px var(--sans);white-space:nowrap;overflow:hidden;cursor:default;padding:0 7px;}
.wrap .pseg.infeasible{border-color:var(--bad);box-shadow:0 0 0 1px color-mix(in srgb,var(--bad) 25%,transparent);}
.wrap .pseg .pn{font-size:9.5px;font-weight:800;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0;}
.wrap .pseg .pd{font-size:8.5px;font-family:var(--mono);margin-left:auto;white-space:nowrap;}
.wrap .pseg .prm{position:absolute;right:-7px;top:-8px;width:16px;height:16px;border-radius:50%;border:1px solid var(--bad);background:var(--surface);color:var(--bad);font-size:13px;line-height:12px;padding:0;cursor:pointer;z-index:5;}
.wrap .pseg .ph{position:absolute;right:-3px;top:1px;bottom:1px;width:7px;border-radius:4px;background:var(--target);cursor:ew-resize;opacity:.72;z-index:4;}
.wrap .plancontrols{display:none;justify-content:flex-end;gap:8px;margin-top:7px;}
.wrap .planning .plancontrols{display:flex;}
.wrap .plancontrols button{border-radius:14px;padding:6px 12px;font:700 11px var(--sans);cursor:pointer;}
.wrap .plancancel{border:1px solid var(--line-strong);background:transparent;color:var(--ink-2);}
.wrap .planconfirm{border:1px solid var(--target);background:var(--target);color:#fff;}
.wrap .planbusy .plancontrols button{opacity:.55;pointer-events:none;}
.wrap .planbusy .planconfirm:before{content:"";display:inline-block;width:10px;height:10px;margin:0 7px -1px 0;border:2px solid rgba(255,255,255,.42);border-top-color:#fff;border-radius:50%;animation:planspin .72s linear infinite;}
@keyframes planspin{to{transform:rotate(360deg)}}
.wrap .planidea{cursor:grab;}
.wrap .planidea:hover{background:color-mix(in srgb,#6A5FA0 8%,transparent);}
.wrap .planadd{border:1px solid var(--target);border-radius:12px;background:color-mix(in srgb,var(--target) 9%,var(--surface));color:var(--target);padding:3px 8px;font:800 10px var(--sans);white-space:nowrap;cursor:grab;}
.wrap .planadd:active{cursor:grabbing;}
.wrap .adjustplan{margin-left:8px;border:1px solid color-mix(in srgb,var(--cx,var(--target)) 55%,var(--line));border-radius:999px;background:color-mix(in srgb,var(--cx,var(--target)) 10%,var(--surface));color:var(--cx,var(--target));padding:5px 10px;font:800 10px var(--sans);text-transform:none;letter-spacing:0;cursor:pointer;white-space:nowrap;}
.wrap .adjustplan:hover{background:color-mix(in srgb,var(--cx,var(--target)) 18%,var(--surface));}
.wrap table.acts td.an{position:relative;}
.wrap table.acts td.an .anmain{display:flex;align-items:center;min-width:0;max-width:100%;}
.wrap table.acts td.an .antext{min-width:0;overflow:hidden;text-overflow:ellipsis;}
.wrap table.acts td.an .tag{flex:none;}
.wrap .removeplan{position:absolute;right:8px;top:50%;transform:translateY(-50%);opacity:0;pointer-events:none;border:1px solid color-mix(in srgb,var(--bad) 48%,var(--line));border-radius:999px;background:var(--surface);color:var(--bad);padding:3px 8px;font:800 9.5px var(--sans);white-space:nowrap;transition:opacity .14s ease;}
.wrap tr.canremove:hover .removeplan,.wrap .removeplan:focus-visible{opacity:1;pointer-events:auto;}
.wrap .activitysect .secth .adjustplan{margin-left:auto;}
.wrap .hero{position:relative;overflow:hidden;border-radius:22px;padding:18px 22px 22px;color:#fff;background:linear-gradient(125deg,#651d22 0%,#9f3028 46%,#c06a31 100%);box-shadow:0 20px 55px -30px rgba(80,20,12,.8);isolation:isolate;}
.wrap .hero:before{content:"";position:absolute;inset:0;z-index:-2;background:radial-gradient(circle at 82% 18%,rgba(255,218,137,.36) 0 8%,transparent 8.5%),linear-gradient(145deg,transparent 46%,rgba(61,18,25,.24) 46.2% 55%,transparent 55.2%);}
.wrap .hero:after{content:"";position:absolute;left:-4%;right:-4%;bottom:-58px;height:150px;z-index:-1;opacity:.42;background:linear-gradient(155deg,transparent 0 22%,#36151d 22.5% 36%,transparent 36.5%),linear-gradient(25deg,transparent 0 38%,#4b1920 38.5% 51%,transparent 51.5%),linear-gradient(165deg,transparent 0 59%,#32151c 59.5% 74%,transparent 74.5%);}
.wrap .hero-nav{display:flex;align-items:center;gap:18px;padding-bottom:15px;border-bottom:1px solid rgba(255,255,255,.2);}
.wrap .brand{display:flex;align-items:center;gap:10px;min-width:max-content;}
.wrap .brandseal{display:grid;place-items:center;width:34px;height:34px;border-radius:11px;background:#f0c36a;color:#6e2020;font:900 19px Georgia,serif;box-shadow:inset 0 0 0 1px rgba(255,255,255,.45);}
.wrap .brandcopy{display:flex;flex-direction:column;line-height:1.1}.wrap .brandcopy b{font-size:12px;letter-spacing:.12em;text-transform:uppercase}.wrap .brandcopy span{font-size:10px;color:rgba(255,255,255,.66);margin-top:4px;}
.wrap .navtools{display:flex;align-items:center;justify-content:flex-end;gap:9px;margin-left:auto;min-width:0;}
.wrap .plannerbadge{display:inline-flex;align-items:center;gap:7px;padding:6px 10px;border:1px solid rgba(255,255,255,.23);border-radius:999px;background:rgba(42,10,16,.2);font:750 10.5px var(--sans);white-space:nowrap;color:rgba(255,255,255,.86);}
.wrap .plannerbadge i{width:7px;height:7px;border-radius:50%;background:#f0c36a;box-shadow:0 0 0 3px rgba(240,195,106,.14)}.wrap .plannerbadge.on i{background:#8fe0a8;box-shadow:0 0 0 3px rgba(143,224,168,.15)}
.wrap .hero-body{padding:32px 0 6px;max-width:720px}.wrap .hero .eyebrow{color:#f4cd83}.wrap .hero h1{font-size:clamp(32px,5vw,52px);max-width:14ch;margin:9px 0 10px;}.wrap .hero .lede{color:rgba(255,255,255,.78);max-width:64ch;}
.wrap .hero .stats{display:grid;gap:13px;margin:20px 0 0}.wrap .hero .statgroup{display:grid;gap:7px}.wrap .hero .statlabel{font:800 9.5px var(--sans);letter-spacing:.13em;text-transform:uppercase;color:rgba(255,255,255,.67)}.wrap .hero .statrow{display:flex;flex-wrap:wrap;gap:7px}.wrap .hero .stat{display:flex;align-items:center;gap:8px;min-width:0;padding:8px 11px;background:rgba(255,255,255,.93);border-color:rgba(255,255,255,.48);border-radius:11px;box-shadow:0 8px 30px -18px rgba(30,5,8,.8);color:#241f1b}.wrap .hero .stat .stic{font-size:17px;color:#9f3028}.wrap .hero .stat .n{font-size:16px;line-height:1}.wrap .hero .stat .k{font-size:9.5px;line-height:1.2;margin-top:3px;color:#6b5f54;white-space:nowrap}
.wrap .authbar{display:flex;align-items:center;justify-content:flex-end;gap:8px;min-height:34px;min-width:0;}
.wrap .authstate{display:flex;align-items:center;gap:7px;font:700 11px var(--sans);color:rgba(255,255,255,.78);white-space:nowrap;}
.wrap .authstate img{width:25px;height:25px;border-radius:50%;object-fit:cover;}
.wrap .authbtn{border:1px solid rgba(255,255,255,.32);border-radius:15px;background:rgba(255,255,255,.11);color:#fff;padding:6px 10px;font:750 10.5px var(--sans);cursor:pointer;}
.wrap .authbtn.primary{border-color:var(--target);background:var(--target);color:#fff;}
.wrap .authmsg{font:700 10.5px var(--sans);color:#ffd1cb;max-width:180px;}
.wrap .hero .themebtn{border:1px solid rgba(255,255,255,.28);background:rgba(255,255,255,.1);color:#fff;white-space:nowrap;}
.wrap .toolbar{display:flex;align-items:center;gap:14px;margin:16px 0 8px;padding:0 2px 14px;border-bottom:1px solid var(--line);}
.wrap .toolbar .legend{margin-left:auto;}
#adminModal{position:fixed;inset:0;z-index:80;display:none;align-items:center;justify-content:center;padding:20px;}
#adminModal.on{display:flex;} #adminModal .ambg{position:absolute;inset:0;background:rgba(0,0,0,.45);}
#adminModal .ambox{position:relative;width:min(570px,100%);max-height:82vh;overflow:auto;background:var(--surface);border:1px solid var(--line);border-radius:16px;padding:20px;box-shadow:0 20px 60px rgba(0,0,0,.24);}
#adminModal h2{margin:0 0 5px;font-size:20px;} #adminModal p{margin:0 0 15px;color:var(--ink-2);font-size:12.5px;line-height:1.45;}
#adminModal .amclose{position:absolute;right:14px;top:12px;border:0;background:none;color:var(--ink-2);font-size:22px;cursor:pointer;}
#adminModal .amadd{display:flex;gap:8px;margin:12px 0;} #adminModal .amadd input{flex:1;min-width:0;border:1px solid var(--line-strong);border-radius:8px;padding:8px 10px;background:var(--surface);color:var(--ink);}
#adminModal .amadd button,#adminModal .amremove{border:1px solid var(--target);border-radius:12px;padding:6px 10px;background:var(--target);color:#fff;font:750 11px var(--sans);cursor:pointer;}
#adminModal table{width:100%;border-collapse:collapse;font-size:12px;} #adminModal td{padding:9px 4px;border-top:1px solid var(--line);vertical-align:middle;}
#adminModal .amwho{display:flex;align-items:center;gap:9px;} #adminModal .amwho img{width:29px;height:29px;border-radius:50%;object-fit:cover;background:var(--surface-2);}
#adminModal .amname{font-weight:750;} #adminModal .amemail{font-size:10.5px;color:var(--ink-3);font-family:var(--mono);}
#adminModal .amremove{border-color:var(--bad);background:transparent;color:var(--bad);float:right;} #adminModal .amremove[disabled]{opacity:.35;cursor:not-allowed;}
#adminModal .amstatus{min-height:16px;font-size:11px;font-weight:700;color:var(--bad);}
@media(max-width:900px){.wrap .hero-nav{align-items:flex-start;flex-wrap:wrap}.wrap .navtools{width:100%;justify-content:flex-start;flex-wrap:wrap;margin-left:0}.wrap .authbar{justify-content:flex-start}.wrap .hero-body{padding-top:24px}}
@media(max-width:620px){.wrap .hero{margin:0 -6px;padding:15px 15px 19px;border-radius:17px}.wrap .brandcopy span{display:none}.wrap .plannerbadge{order:3;width:100%;justify-content:center}.wrap .authstate span{max-width:135px;overflow:hidden;text-overflow:ellipsis}.wrap .toolbar{align-items:flex-start;flex-wrap:wrap}.wrap .toolbar .legend{width:100%;margin-left:0;gap:8px 13px}.wrap .hero .stat{min-width:calc(50% - 5px);flex:1}.wrap .authmsg{width:100%;max-width:none}}
/* Each day is a CARD — surface, border, shadow — not a stripe in a list. With every
   day unfolded the tables ran into each other and nothing said where one day ended
   and the next began; the card edge is that boundary. */
.wrap .day{background:var(--surface);border:1px solid var(--line);border-radius:12px;
  padding:4px 12px 8px;box-shadow:var(--shadow);}
.wrap .city-body{gap:10px;padding-top:2px;padding-bottom:2px;}
.wrap .cv{display:inline-block;transition:transform .15s ease;color:var(--ink-3);font-weight:700;margin-right:5px;}
.wrap .day.open .cv{transform:rotate(90deg);}

.wrap .detail{display:none;padding:16px 0 14px;overflow-x:auto;}
.wrap .day.open .detail{display:block;}
.wrap table.acts{border-collapse:collapse;font-size:11px;min-width:360px;}
.wrap table.acts th{font-size:9.5px;font-weight:800;letter-spacing:.05em;text-transform:uppercase;color:var(--ink-3);border-bottom:1px solid var(--line);}
.wrap table.acts th,.wrap table.acts td{padding:7px 0 7px 60px;}
.wrap table.acts th:first-child,.wrap table.acts td:first-child{padding-left:0;text-align:left;}
.wrap table.acts th:not(:first-child),.wrap table.acts td:not(:first-child){text-align:left;}
.wrap table.acts td{border-bottom:1px solid var(--line);color:var(--ink-2);}
.wrap table.acts td.an{color:var(--ink);white-space:nowrap;}
.wrap table.acts td.tm{text-align:right;font-family:var(--mono);font-variant-numeric:tabular-nums;color:var(--ink);white-space:nowrap;}
.wrap table.acts td.tm.r{color:var(--bad);font-weight:800;}
.wrap table.acts td.tm.t{color:var(--warn);font-weight:800;}
.wrap table.acts tr.rhome td{color:var(--ink-3);}
.wrap table.acts tr.rhome td.an{color:var(--ink-2);}
.wrap table.acts tr.rmeal td.an{font-style:italic;}
.wrap table.acts .tag{font-size:8.5px;font-weight:800;text-transform:uppercase;letter-spacing:.03em;color:var(--ink-3);border:1px solid var(--line);border-radius:4px;padding:0 4px;margin-left:8px;vertical-align:middle;}
.wrap table.acts .tag.bkg{color:var(--warn);border-color:color-mix(in srgb,var(--warn) 55%,transparent);background:color-mix(in srgb,var(--warn) 12%,transparent);}
.wrap table.acts .tag.bkd{color:var(--ok);border-color:color-mix(in srgb,var(--ok) 50%,transparent);background:color-mix(in srgb,var(--ok) 10%,transparent);}
.wrap table.acts td.end{color:var(--ink-2);}
.wrap table.acts td.def{color:var(--ink-3);}
.wrap table.acts td.res,.wrap table.acts th.hres{color:var(--target);font-weight:800;}
.wrap table.acts td.tv,.wrap table.acts th.htv{white-space:nowrap;}
.wrap table.acts .mo{margin-left:11px;color:var(--ink-3);font-family:var(--mono);font-variant-numeric:tabular-nums;font-size:11px;}
.wrap table.acts .mo:first-child{margin-left:0;}
.wrap table.acts .mo.rec{color:var(--ink);font-weight:800;}
.wrap table.acts{min-width:800px;width:100%;}
.wrap table.acts th,.wrap table.acts td{padding-left:10px;}
.wrap table.acts{table-layout:fixed;}
/* Eight columns since the three empty "Proposed" ones went. Their 27% was given to
   the columns that carry something — the activity name (which was truncating on long
   venues) and the Start/End/Total group, which now sits further right with room to
   breathe instead of being squeezed against a dead half of the table. */
.wrap table.acts col.wA{width:26%;} .wrap table.acts col.wT{width:11%;}
.wrap table.acts col.wTot{width:12%;}
.wrap table.acts col.wSug{width:11%;} .wrap table.acts col.wTv{width:9.6%;}
.wrap table.acts td.an{overflow:hidden;text-overflow:ellipsis;}
.wrap table.acts td.tm,.wrap table.acts thead th,.wrap table.acts tfoot th{text-align:left;white-space:nowrap;}
.wrap table.acts th.htv,.wrap table.acts td.tv{padding-left:10px;text-align:left;}
/* The travel group's edges. These classes are carried by the HEADER cell, every BODY
   cell in the column and the footer label — all three, which is the point: the rule
   used to sit on the header and the footer only, so the line appeared above the table
   and again below it with the rows in between unruled, reading as two stray marks
   rather than one column edge. Same width, same var(--line), as the .b1 group. */
.wrap table.acts .b3{border-left:1px solid var(--line);}
.wrap table.acts .b3r{border-right:1px solid var(--line);}
.wrap table.acts td.sug,.wrap table.acts th.hsug,.wrap table.acts th.gs{color:var(--ink-3);}
.wrap table.acts td.sug{cursor:help;}
.wrap table.acts td.sug .qm{color:var(--warn);font-weight:800;margin-left:2px;}
.wrap table.acts th.gs{text-align:left;font-weight:800;}
.wrap table.acts .dl{font-weight:800;margin-left:3px;}
.wrap table.acts .dl.up{color:var(--ok);}
.wrap table.acts .dl.dn{color:var(--bad);}
.wrap .miniax{position:relative;height:15px;background:var(--surface-2);border-radius:5px;margin:3px 0 3px;}
.wrap .mtk{position:absolute;transform:translateX(-50%);top:2px;font-size:9px;font-family:var(--mono);color:var(--ink-3);}
.wrap .mtk.tgt{color:var(--target);font-weight:700;}
.wrap table.acts tr.grp th{font-size:9px;letter-spacing:.07em;padding-bottom:3px;border-bottom:0;}
.wrap table.acts tfoot tr.gfoot th{padding-top:7px;padding-bottom:0;border-top:1px solid var(--line);}
.wrap table.acts th.gh{text-align:left;color:var(--ink-2);}
.wrap table.acts th.gt{text-align:left;color:var(--ink-3);}
/* The scheduled-times group. Header, every body cell and the footer label all carry
   these — the pattern .b3 above now follows. */
.wrap table.acts .b1{border-left:1px solid var(--line);}
.wrap table.acts .b1r{border-right:1px solid var(--line);}
/* .b2 / .b2r / td.pc styled the "Proposed" columns and went with them. */
.wrap .track2.empty{background:repeating-linear-gradient(90deg,var(--surface-2) 0 6px,transparent 6px 12px);opacity:.5;}
.wrap table.acts tr.rhub td{font-weight:700;}
.wrap .ideas{margin:18px 0 4px;}
.wrap table.acts.idt{min-width:0;width:100%;table-layout:auto;}
.wrap table.acts.idt td.iw{color:var(--ink-2);white-space:normal;font-size:10.5px;}
.wrap table.acts.idt td.an{color:var(--ink-2);}
.wrap table.acts tbody tr.rowsel td,.wrap table.acts tbody tr.rowsel td.pc{background:color-mix(in srgb,var(--target) 13%,transparent);}
.wrap table.acts tbody tr:hover td,.wrap table.acts tbody tr:hover td.pc{background:color-mix(in srgb,var(--target) 7%,transparent);}
/* a row with a key IS its stop — clicking it selects and focuses the pin, same as its block */
.wrap table.acts tbody tr[data-key]{cursor:pointer;}
.wrap table.acts td.tot{font-weight:700;color:var(--ink);}
.wrap table.acts tr.radd td.an{color:var(--ok);font-style:italic;}
body.only-bad .wrap .day.ok-day{display:none;}
.wrap .xbtn{font:inherit;font-size:12.5px;font-weight:600;color:var(--ink-2);background:var(--surface-2);border:1px solid var(--line);border-radius:9px;padding:6px 12px;cursor:pointer;}
.wrap .xbtn:hover{color:var(--ink);}
.wrap .xbtn:focus-visible{outline:2px solid var(--target);outline-offset:2px;}
.wrap .fix.fix-prop{max-width:84ch;color:var(--ink-2);}
.wrap .fix.fix-warn{color:var(--warn);}
.wrap .fix.fix-warn::before{color:var(--warn);}
.wrap .axis{padding-left:15px;}
.wrap .axis .track-head{height:28px;}
.wrap .axis .tk{position:absolute;transform:translateX(-50%);bottom:0;display:flex;flex-direction:column;align-items:center;gap:3px;font-family:var(--mono);}
.wrap .axis .tk .tkl{font-size:11px;font-weight:700;color:var(--ink-2);letter-spacing:.02em;}
.wrap .axis .tk .tkm{width:1px;height:7px;background:var(--ink-3);}
.wrap .axis .tk.tgt .tkl{color:var(--target);}
.wrap .axis .tk.tgt .tkm{width:2px;height:10px;background:var(--target);}
.wrap .day .gl{background:var(--band-line);}
.wrap .d .stops{margin-top:0;margin-left:8px;vertical-align:middle;}
.wrap .seg{position:absolute;top:6px;height:18px;border-radius:4px;display:flex;align-items:center;gap:4px;padding:0 4px;overflow:hidden;font-size:9.5px;font-variant-numeric:tabular-nums;white-space:nowrap;box-shadow:inset 0 0 0 1px rgba(0,0,0,.04);}
.wrap .seg .sn{font-weight:700;overflow:hidden;text-overflow:ellipsis;min-width:0;}
.wrap .seg .sd{font-family:var(--mono);flex:none;opacity:.7;}
.wrap .seg.tight{padding:0;gap:0;justify-content:center;}
.wrap .seg.ok{background:var(--ok-soft);color:var(--ink);border:1px solid color-mix(in srgb,var(--ok) 42%,transparent);}
.wrap .seg.late{background:var(--bad-soft);color:var(--bad);border:1px solid color-mix(in srgb,var(--bad) 48%,transparent);}
.wrap .seg.pm{background:repeating-linear-gradient(45deg,var(--bad-soft) 0 4px,transparent 4px 8px);color:var(--bad);border:1px solid var(--bad);}
.wrap .seg.mealseg{opacity:.92;}
.wrap .seg.mealseg .sn{font-style:italic;font-weight:600;}
.wrap .seg.opt{background:var(--surface);color:var(--ink-3);border:1px dashed var(--ink-3);}
.wrap .day.has-prop .row{padding-bottom:0;}



.wrap .chgh{font-size:9.5px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;color:var(--ink-3);margin-bottom:6px;}
.wrap .chgh .apx{text-transform:none;letter-spacing:0;font-weight:600;color:var(--warn);margin-left:6px;}
.wrap .seg{cursor:pointer;}
.wrap .seg.hub{background:var(--ink);color:var(--bg);border:1px solid var(--ink);font-weight:800;box-shadow:none;}
.wrap .seg.hub .sn{font-weight:800;}
.wrap .seg.hub .sd{opacity:.75;}
.wrap .seg.hub.approx{background:transparent;color:var(--ink);border:1px dashed var(--ink-2);}
.wrap .seg .lk{margin-right:3px;font-size:10px;vertical-align:0;}
.wrap .seg.bonusseg{opacity:.55;border-style:dashed;}
.wrap .seg.homeseg.broken{background:var(--bad);color:#fff;border-color:var(--bad);}
.wrap .seg.homeseg{width:auto;padding:0 7px;gap:4px;font-weight:800;cursor:default;font-family:var(--mono);
  background:var(--surface);border:1px solid var(--line);color:var(--ink-2);box-shadow:none;}
/* selectable once the hotel has a pin behind it */
.wrap .seg.homeseg.pick{cursor:pointer;}
.wrap .seg.homeseg.ok2{color:var(--ok);background:var(--ok-soft);border-color:color-mix(in srgb,var(--ok) 45%,transparent);}
.wrap .seg.homeseg.warn{color:var(--warn);background:var(--warn-soft);border-color:color-mix(in srgb,var(--warn) 50%,transparent);}
.wrap .seg.homeseg.bad{color:var(--bad);background:var(--bad-soft);border-color:color-mix(in srgb,var(--bad) 50%,transparent);}
.wrap .seg.sel{outline:2px solid var(--target);outline-offset:1px;box-shadow:0 0 0 3px color-mix(in srgb,var(--target) 24%,transparent);z-index:3;}

.wrap table.acts tr.rowsel td.an{box-shadow:inset 3px 0 0 var(--target);font-weight:700;}
.wrap table.acts td.cur,.wrap table.acts th.hcur{color:var(--ink);font-weight:700;}
.wrap table.acts td.res .dl{font-weight:800;margin-left:4px;}
.wrap table.acts td.res .dl.up{color:var(--ok);}
.wrap table.acts td.res .dl.dn{color:var(--bad);}
.wrap table.acts td.tv{color:var(--ink-3);}
.wrap table.acts td.tv.rec{color:var(--ink);font-weight:800;}
.wrap .mapwrap{display:none;margin:8px 0 10px;}
.wrap .day.open .mapwrap{display:block;}
.wrap .map{height:330px;border:1px solid var(--line);border-radius:12px;margin-top:7px;background:var(--surface-2);z-index:0;}
.wrap .mapempty{display:flex;align-items:center;justify-content:center;height:100%;font-size:12px;color:var(--ink-3);}
.wrap .nummk{display:flex;align-items:center;justify-content:center;width:24px;height:24px;border-radius:50%;background:var(--target);color:#fff;font:700 11px/1 var(--sans);box-shadow:0 0 0 2px #fff,0 1px 4px rgba(0,0,0,.35);}
.wrap .nummk.mk-act{background:#2F6FB5;}
.wrap .nummk.mk-food{background:#C77A16;}
.wrap .nummk.mk-hotel{background:#2E7D57;}
.wrap .mlg{display:flex;gap:14px;margin-top:6px;font-size:11px;color:var(--ink-3);}
.wrap .mit{display:inline-flex;align-items:center;gap:5px;}
.wrap .msw{width:11px;height:11px;border-radius:50%;display:inline-block;}
.wrap .msw.mk-act{background:#2F6FB5;} .wrap .msw.mk-food{background:#C77A16;} .wrap .msw.mk-hotel{background:#2E7D57;}
/* the suggestion swatch is hollow, like its pin */
.wrap .msw.mk-idea{background:#fff;border:2.5px solid #6A5FA0;}
/* a selected suggestion row reads like a selected stop row */
.wrap table.acts tbody tr.idrow[data-key]{cursor:pointer;}
.wrap .sumwrap{margin:22px 0 20px;}
.wrap .detail .fix{padding-left:0;max-width:none;margin:0;color:var(--ink-2);line-height:1.6;}
.wrap .detail .fix::before{content:none;}
.wrap .nummk.on{background:var(--bad);transform:scale(1.25);}
.wrap .leaflet-container{font:inherit;border-radius:12px;}
.wrap .track{background:${BAND};}
/* Material Symbols — the app's own icon font and treatment (.msym in app/globals.css),
   rendered by ligature name so the canvas shows the exact glyphs the app shows */
.msym{font-family:'Material Symbols Outlined';font-weight:normal;font-style:normal;line-height:1;
  letter-spacing:normal;text-transform:none;white-space:nowrap;direction:ltr;
  -webkit-font-feature-settings:'liga';font-feature-settings:'liga';-webkit-font-smoothing:antialiased;
  display:inline-flex;align-items:center;justify-content:center;user-select:none;flex:none;vertical-align:middle;}
.wrap table.acts td.an .msym{font-size:15px;margin-right:7px;margin-top:-2px;}
.wrap .msym.ic-act{color:var(--cx,var(--ink-2));}
.wrap .msym.ic-meal{color:#B8621B;}   /* the app's one colour that means "food" */
.wrap .msym.ic-hub{color:var(--ink);}
.wrap .msym.ic-home{color:var(--ink-3);}
/* the day's last row — where you sleep, not something you do */
.wrap table.acts tr.rhome td{color:var(--ink-3);font-style:normal;}
.wrap table.acts tr.rhome td.an{color:var(--ink-2);}
.wrap .cbdg .msym{font-size:13px;}
/* the two titled section cards inside an unfolded day: Activity, then Suggestions */
.wrap .sect{background:color-mix(in srgb,var(--surface-2) 55%,transparent);border:1px solid var(--line);
  border-radius:12px;padding:12px 14px 10px;margin:0 0 14px;overflow-x:auto;}
.wrap .secth{display:flex;align-items:center;gap:7px;font-size:11px;font-weight:800;
  letter-spacing:.06em;text-transform:uppercase;color:var(--ink-2);margin-bottom:8px;}
.wrap .secth .msym.sic{font-size:16px;color:var(--cx,var(--ink-2));}
.wrap .secth .scount{font-weight:700;color:var(--ink-3);text-transform:none;letter-spacing:0;
  font-family:var(--mono);font-size:11px;}
/* per-day count badges, mirroring the app's day cards. Idea counts only — they sit at
   the LEFT of the header row, beside the date, because they describe what is still
   open about the day. */
.wrap .cbdgs{display:inline-flex;gap:4px;align-items:center;margin-left:8px;}
.wrap .cbdg{display:inline-flex;align-items:center;gap:2px;font-size:10.5px;font-weight:800;
  padding:1px 6px;border-radius:7px;background:var(--surface-2);color:var(--ink-2);border:1px solid var(--line);font-family:var(--mono);}
/* The right-hand end of the day header: the verdict flag, then the place count, pushed
   into the card's corner. margin-left:auto inside the flex row does the pinning, so
   the left group can grow to any width without the two ever colliding.
   NB: no backticks in this stylesheet — it is itself a template literal (see the
   trap in the project briefing; a stray one silently truncates the whole page). */
.wrap .dright{margin-left:auto;display:inline-flex;align-items:center;gap:7px;flex:none;}
/* The place count reuses the header's own .stops chip — same border, radius, weight and
   tabular figures — with the app's own place glyph set inside it. */
.wrap .stops.nplaces{display:inline-flex;align-items:center;gap:4px;margin-top:0;}
.wrap .stops.nplaces .msym{font-size:12.5px;}
/* add-to-meal buttons in the suggestion tables */
.wrap .addcell{white-space:nowrap;}
.wrap .addbtn{font:inherit;font-size:10.5px;font-weight:800;padding:2px 8px;margin-right:4px;border-radius:8px;
  cursor:pointer;background:color-mix(in srgb, var(--ok) 14%, transparent);color:var(--ok);
  border:1px solid color-mix(in srgb, var(--ok) 45%, transparent);}
.wrap .addbtn.off{opacity:.45;cursor:not-allowed;background:transparent;color:var(--ink-3);border-color:var(--line);}
.wrap .addbtn.busy{opacity:.6;cursor:progress;}
.wrap .idrow{cursor:pointer;}
.wrap .idrow:hover{background:var(--surface-2);}
.wrap .seg[data-pid]{cursor:pointer;}
/* place detail panel — a right-hand drawer, so the timeline stays on screen behind it */
#pp{position:fixed;inset:0;z-index:60;display:none;}
#pp.on{display:block;}
#pp .ppbg{position:absolute;inset:0;background:rgba(0,0,0,.42);}
#pp .ppbox{position:absolute;top:0;right:0;bottom:0;width:min(460px,100%);background:var(--surface);
  border-left:1px solid var(--line);overflow-y:auto;padding:18px 20px 40px;box-shadow:-8px 0 32px rgba(0,0,0,.18);}
#pp h3{margin:0 0 2px;font-size:20px;letter-spacing:-.01em;}
#pp .ppzh{font-size:14px;color:var(--ink-2);margin-bottom:10px;}
#pp .ppx{position:sticky;top:0;float:right;font:inherit;font-size:20px;line-height:1;border:0;background:none;
  cursor:pointer;color:var(--ink-2);padding:2px 4px;}
#pp .ppimgs{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin:10px 0 12px;}
#pp .ppimgs img{width:100%;height:104px;object-fit:cover;border-radius:9px;display:block;background:var(--surface-2);}
#pp .ppimgs img:first-child{grid-column:1/-1;height:170px;}
#pp .ppchips{display:flex;flex-wrap:wrap;gap:5px;margin-bottom:10px;}
#pp .ppchip{font-size:10.5px;font-weight:800;padding:2px 8px;border-radius:8px;background:var(--surface-2);
  color:var(--ink-2);border:1px solid var(--line);font-family:var(--mono);}
#pp .ppdesc{font-size:13.5px;line-height:1.6;color:var(--ink-2);white-space:pre-wrap;margin-bottom:12px;}
#pp .pprow{display:flex;gap:8px;font-size:12.5px;padding:5px 0;border-top:1px solid var(--line);}
#pp .pprow b{min-width:104px;color:var(--ink-3);font-weight:700;}
#pp .ppwarn{font-size:12px;font-weight:700;color:var(--bad);margin:8px 0;}
#pp .ppcred{font-size:10.5px;color:var(--ink-3);margin-top:10px;line-height:1.5;}
#pp .ppmsg{font-size:12px;font-weight:700;margin-top:10px;}
.wrap .track2{position:relative;height:30px;border-radius:7px;background:${BAND};}
.wrap .endlbl2{position:absolute;top:50%;transform:translateY(-50%);font-size:11px;font-weight:800;font-family:var(--mono);color:var(--ok);white-space:nowrap;}
@media (max-width:520px){.wrap table.acts{min-width:300px;}.wrap .seg .sn{display:none;}}
</style>`;

const html = `<meta charset="utf-8"><title>China Journey Planner</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@20..48,400,0,0&display=block" rel="stylesheet">
${GKEY
  ? `<script>window.__gmready=false;window.gmapsReady=function(){window.__gmready=true;};<\/script><script src="https://maps.googleapis.com/maps/api/js?key=${GKEY}&language=en&region=US&loading=async&callback=gmapsReady" async><\/script>`
  : `<script>window.addEventListener("DOMContentLoaded",function(){
       document.querySelectorAll(".map").forEach(function(el){
         el.innerHTML='<div class="mapempty">No Google Maps key was available when this page was built \\u2014 set GOOGLE_MAPS_API_KEY, or put the canvas key in build/gmaps-key.txt, and rebuild.<\\/div>';
       });});<\/script>`}
<div class="wrap" style="--labelw:128px;--sanea:8.7%;--saneb:71.74%;">
  <header class="top">
    <div class="hero">
      <div class="hero-nav">
        <div class="brand"><span class="brandseal">中</span><span class="brandcopy"><b>China Journey</b><span>11 Aug – 7 Sep 2026</span></span></div>
        <div class="navtools">
          <span id="plannerBadge" class="plannerbadge"><i></i><span id="plannerBadgeText">Sign in required to plan</span></span>
          <button id="thm" class="xbtn themebtn" aria-pressed="false">☾ Dark</button>
          <div id="authbar" class="authbar">
            <div id="authstate" class="authstate"><span>View only</span></div>
            <div id="googleSignIn"></div>
            <button id="manageUsers" class="authbtn" hidden>Manage users</button>
            <button id="signOut" class="authbtn" hidden>Sign out</button>
            <span id="authmsg" class="authmsg"></span>
          </div>
        </div>
      </div>
      <div class="hero-body">
        <div class="eyebrow">Itinerary planning canvas</div>
        <h1>China, day by day.</h1>
        <p class="lede">See every day on a real clock, compare ideas with the committed itinerary, and shape the journey before departure. Sign in with an approved Google account to plan.</p>
      </div>
      <div class="stats" id="stats">${statsHTML}</div>
    </div>
  </header>
  <div class="toolbar">
    <button id="xAll" class="xbtn">Expand all</button>
    <div class="legend">
      <span class="it"><span class="sw" style="background:var(--ok)"></span>Home by 21:30</span>
      <span class="it"><span class="sw" style="background:var(--warn)"></span>A bit late</span>
      <span class="it"><span class="sw" style="background:var(--bad)"></span>Late / past midnight</span>
      <span class="it"><span class="pip" style="position:static;width:9px;height:9px;border-radius:50%;background:var(--bad);border:1.5px solid var(--bg);display:inline-block"></span>late meal</span>
    </div>
  </div>
  <main id="chart">${out}</main>
  <p class="foot">The day now ends when you <b>arrive back at the hotel</b> — recommended time at each stop, real walk/metro/DiDi legs, and the trip home. Over-packed evenings and long commutes (e.g. Wulingyuan's mountain roads, Tianmen downtown) both push the end past a sane hour. Fixes suggest how to pull each day back under ~21:30.</p>
</div>
${STYLE}
${EXTRA}
<div id="pp" role="dialog" aria-modal="true" aria-label="Place detail"><div class="ppbg"></div><div class="ppbox"></div></div>
<div id="adminModal" role="dialog" aria-modal="true" aria-label="Manage planning administrators"><div class="ambg"></div><div class="ambox">
  <button class="amclose" aria-label="Close">×</button><h2>Planning administrators</h2>
  <p>Administrators can change the itinerary, confirm plans in PostgreSQL, and update the mobile app.</p>
  <form id="adminForm" class="amadd"><input id="adminEmail" type="email" autocomplete="email" placeholder="person@gmail.com" aria-label="New administrator email"><button type="submit">Add administrator</button></form>
  <div id="adminStatus" class="amstatus"></div><table><tbody id="adminRows" class="amrows"></tbody></table>
</div></div>
<script src="https://accounts.google.com/gsi/client" async defer><\/script>
<script>window.__PLACES=${JSON.stringify(PLACES)};window.__APP=${JSON.stringify(APP_ORIGIN)};window.__GOOGLE_CLIENT_ID=${JSON.stringify(GOOGLE_OAUTH_CLIENT_ID)};window.__TOK="";<\/script>
<script>${script}</script>`;
writeFileSync(new URL('./china-day-load.html', import.meta.url), html);
console.log('canvas rebuilt:', html.length, 'bytes · days', DATA.length,
  `· ${TRIP.activities} scheduled activities · ${route.didi.count} Didi · ${route.metro.count} metro · ${route.walk.count} walks`,
  '· axis 06:00→04:00');
