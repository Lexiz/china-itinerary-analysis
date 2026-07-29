import { readFileSync, writeFileSync } from 'node:fs';
const DATA = JSON.parse(readFileSync(new URL('./viz-data.json', import.meta.url)));
// Every stop the snapshot knows, by name, regardless of which day it originally sat on — so a stop
// moved between days keeps its coordinates and its researched advice.
const STOP_ANY = new Map();
for (const d of DATA) for (const s of (d.stops || [])) if (!STOP_ANY.has(s.name)) STOP_ANY.set(s.name, s);
const STYLE = readFileSync(new URL('./canvas-style.html', import.meta.url), 'utf8');
// Working plan, keyed "City|day": machine-replanned days, overridden by hand-agreed ones.
import { changeList, matchStop, nk } from './lib-plan.mjs';
// Durations read as clock time: 45m, 1h30, 2h
const fmtDur = m => { const x = Math.round(m); return x < 60 ? x + 'm' : (Math.floor(x / 60) + 'h' + (x % 60 ? String(x % 60).padStart(2, '0') : '')); };
// Google Maps key: env first, else the local gitignored file. NOTE: it is embedded in the
// generated HTML, so it becomes public once this repo is pushed — restrict it by HTTP referrer.
// PUBLISH=1 builds for the PUBLIC GitHub Pages repo and deliberately omits the Maps key.
// The key is currently unrestricted — it answers requests with no referrer at all — so committing
// it to a public repo publishes a working credential to anyone who reads the HTML. Everything else
// on the page (37 days, tables, ideas, rationale, travel legs) renders identically; only the
// per-day map is withheld. Once the key has an HTTP-referrer restriction (lexiz.github.io/* and
// localhost:*) on Google Cloud project 451021051046, drop PUBLISH and the maps come back.
const PUBLISH = process.env.PUBLISH === '1';
let GKEY = process.env.GOOGLE_MAPS_API_KEY || '';
try { if (!GKEY) GKEY = readFileSync(new URL('./gmaps-key.txt', import.meta.url), 'utf8').trim(); } catch { GKEY = ''; }
if (PUBLISH) GKEY = '';
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
  const lock = st.hub ? `<span class="lk">${st.hub.approx ? '~' : '\u{1F512}'}</span>` : '';
  const nm = named ? `<span class="sn">${lock}${esc(st.name)}</span>` : lock;
  const dd = w >= 3 ? `<span class="sd">${d}m</span>` : '';              // duration where it fits
  const tight = named ? '' : ' tight';                                   // narrow blocks drop padding so they never inflate past their slot
  let tip = `${st.name} · ${hhmm(s)}–${hhmm(end)} · ${d}m${st.opt ? ' (optional)' : ''}`;
  if (st.hub) {
    const h = st.hub;
    tip = h.role === 'depart'
      ? `${h.number || h.mode} ${h.route || ''} departs ${h.departTime}\nBe at ${h.terminal ? h.terminal + ' ' : ''}the ${h.mode === 'Flight' ? 'airport' : 'station'} by ${h.beThereBy} — ${d}m check-in${h.approx ? '\n⚠ time is provisional (tickets not on sale yet)' : ''}`
      : `${h.number || h.mode} ${h.route || ''} arrives ${h.arriveTime}\n${d}m to clear${h.terminal ? ' ' + h.terminal : ''} — out by ${h.clearBy}${h.approx ? '\n⚠ time is provisional' : ''}`;
  } else if (st.bonus) tip += ' · bonus / swap — not part of the committed plan';
  return `<div class="${cls}${m}${tight}" data-key="${esc(key)}" role="button" tabindex="0" style="left:${left.toFixed(2)}%;width:${w.toFixed(2)}%" title="${esc(tip)}">${nm}${dd}</div>`;
}
const renderTrack = segs => (segs || []).map(seg).join('');
// The end of the day is a block like any other: it begins the moment you get home and is
// sized to its own label. Anchored right when it would otherwise run off the end of the track.
function homeSeg(endMin, label, kind, tip) {
  const over = endMin > T1;                       // past the right edge of the clock entirely
  const left = P(endMin);
  const pos = (over || left > 86) ? 'right:2px' : `left:${left.toFixed(2)}%`;
  return `<div class="seg homeseg ${kind}${over ? ' broken' : ''}" style="${pos}" title="${esc(tip)}">${over ? '⇥ ' : ''}${label}</div>`;
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

const late = DATA.filter(d => V.get(d).late);
const onTime = DATA.length - late.length;
const missedDep = DATA.filter(d => V.get(d).missed).length;
// The latest finish is Shanghai d6's red-eye: a 02:10 airport call, not an over-packed sightseeing
// day. Labelled as what it is, so nobody reads it as a day still needing cuts.
const latest = [...DATA].sort((a, b) => V.get(b).endMin - V.get(a).endMin)[0];
const lv = latest ? V.get(latest) : null;
// These days were reviewed one by one and accepted; the page is a record of that decision, not an
// open audit. Hence "accepted", not "need real cuts" — the old wording outlived the review.
const statsHTML = [
  ['ok', onTime, 'home by 21:30'],
  ['warn', late.length, 'later — reviewed & accepted'],
  [missedDep ? 'bad' : 'ok', missedDep, 'missed departures'],
  ['', latest ? `${latest.city} d${latest.day}` : '—',
    latest ? `latest — ${latest.home ? 'home' : 'airport'} ${EL(lv.endMin)}` : ''],
].map(([c, n, k]) => `<div class="stat ${c}"><div class="n">${esc(n)}</div><div class="k">${k}</div></div>`).join('');

// top clock: even 3-hour fragments anchored at 05:00 (the first activity of the trip), plus the special 21:30 target
const clock = [[300,'05'],[420,'07'],[540,'09'],[660,'11'],[780,'13'],[900,'15'],[1020,'17'],[1140,'19'],[1260,'21'],[1380,'23'],[1500,'01'],[1620,'03']];
// a small grey clock strip sits directly above each day's bars, so the scale is always in view
const miniAx = `<div class="miniax">` + clock.map(([m, l]) => `<span class="mtk" style="left:${P(m)}%">${l}</span>`).join('') + `</div>`;
// the same fragment lines run down through every bar so each block reads against the clock
const gridHTML = clock.map(([m]) => `<div class="gl" style="left:${P(m)}%"></div>`).join('');
// the sane window (07:00 → 21:30) is shaded rather than labelled, so it costs no vertical space
const BAND = `linear-gradient(90deg,var(--surface-2) 0 ${P(420).toFixed(3)}%,var(--band) ${P(420).toFixed(3)}% ${P(1290).toFixed(3)}%,var(--surface-2) ${P(1290).toFixed(3)}% 100%)`;
let cur = null, out = '';
for (const d of DATA) {
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
  const cell = (min, on, ttl) => `<td class="tm tv${on ? ' rec' : ''}"${ttl ? ` title="${ttl}"` : ''}>${min != null ? fmtDur(min) : '—'}</td>`;

  // "Travel to next" means exactly that: row i carries the leg OUT of it, which is the travelIn of
  // row i+1 — and the last row carries the leg home. Previously each row showed its own travelIn
  // under a "to next" header, so every leg was displayed one row late and the trip home never
  // appeared at all.
  const legOut = i => (i + 1 < rbStops.length)
    ? rbStops[i + 1].travelIn
    : (RB && RB.homeTravel ? { ...RB.homeTravel, est: RB.homeTravel.estimated } : null);

  const rows = rbStops.map((r, ri) => {
    const a = advOf(r.name);
    const isHub = !!r.hub, isMeal = !!r.meal;
    const tag = isHub ? ' <span class="tag">' + (r.hub.role === 'depart' ? 'depart' : 'arrive') + '</span>'
      : isMeal ? ' <span class="tag">meal</span>' : '';
    const cls = [isMeal ? 'rmeal' : '', isHub ? 'rhub' : ''].filter(Boolean).join(' ');
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
      ? '<td class="tm tv">—</td><td class="tm tv">—</td><td class="tm tv">—</td>'
      : t.coloc
        ? `<td class="tm tv coloc" colspan="3" title="${ttl}">· same place ·</td>`
        : cell(t.mode === 'walk' ? t.minutes : null, t.mode === 'walk', ttl)
          + cell(t.mode === 'metro' ? t.minutes : null, t.mode === 'metro', ttl)
          + cell(t.mode === 'didi' ? t.minutes : null, t.mode === 'didi', ttl);
    // A dwell cut short by a closing time must SAY so — otherwise a shorter Total silently reads as
    // "this is all it needs" instead of "this is all the day could buy".
    const capT = r.cap
      ? esc(`Cut short: ${r.name} closes ${r.cap.closes}${r.cap.lastEntry ? ` (last entry ${r.cap.lastEntry})` : ''}. `
          + `${r.cap.lost} min less than the ${fmtDur(r.advice ?? 0)} advice.${r.cap.tooLate ? ' ARRIVES AFTER LAST ENTRY.' : ''}`
          + (r.cap.conf && r.cap.conf !== 'high' ? ` Closing time confidence: ${r.cap.conf}.` : ''))
      : '';
    const totCls = 'tm tot b1r' + (r.cap ? (r.cap.tooLate ? ' capbad' : ' capped') : '');
    return `<tr class="${cls}" data-key="${esc(nk(r.name))}"><td class="an">${esc(r.name)}${tag}</td>`
      + `<td class="tm b1">${hhmm(r.s)}</td><td class="tm">${hhmm(r.s + r.d)}</td>`
      + `<td class="${totCls}"${capT ? ` title="${capT}"` : ''}>${fmtDur(r.d)}${r.cap ? '<span class="qm">⏱</span>' : ''}</td>`
      + `<td class="tm pc b2">—</td><td class="tm pc">—</td><td class="tm tot pc b2r">—</td>`
      + adv + trav + `</tr>`;
  }).join('');

  // Ideas belong to the day they FELL OUT OF, not to the city at large — a parked stop is only
  // meaningful next to the day whose budget rejected it. Moves are listed separately: a stop that
  // simply changed day is still happening and must not be mistaken for a cut.
  const dayKey = `${d.city}|${d.day}`;
  const dayIdeas = (REBUILT.ideasByDay || {})[dayKey] || [];
  const dayMoves = (REBUILT.movesByDay || {})[dayKey] || [];
  const ideasHTML = (dayIdeas.length ? `<div class="ideas"><div class="chgh">Ideas — dropped from Day ${d.day} · not scheduled (${dayIdeas.length})</div>`
    + `<table class="acts idt"><thead><tr><th>Activity</th><th>Advice</th><th>Why it is parked</th></tr></thead><tbody>`
    + dayIdeas.map(i => { const a = advOf(i.name); return `<tr><td class="an">${esc(i.name)}</td>`
        + `<td class="tm sug">${a.res != null ? fmtDur(a.res) : '—'}</td><td class="iw">${esc(i.why || '')}</td></tr>`; }).join('')
    + `</tbody></table></div>` : '')
    + (dayMoves.length ? `<div class="ideas"><div class="chgh">Moved · still happening (${dayMoves.length})</div>`
    + `<table class="acts idt"><thead><tr><th>Activity</th><th>Advice</th><th>Where it went</th></tr></thead><tbody>`
    + dayMoves.map(m => { const a = advOf(m.name); return `<tr><td class="an">${esc(m.name)}</td>`
        + `<td class="tm sug">${a.res != null ? fmtDur(a.res) : '—'}</td><td class="iw">`
        + (m.status === 'moved' ? `was on this day → now <b>Day ${m.to}</b>` : `moved here from <b>Day ${m.from}</b>`)
        + `</td></tr>`; }).join('')
    + `</tbody></table></div>` : '');

  // Everything below describes the COMMITTED (rebuilt) day. It previously read from the old
  // replan, which is why a bar ending 19:51 could sit above a note claiming 23:51.
  const fixText = RB ? [RB.theme, RB.why].filter(Boolean).join(' — ') : '';
  const chgHTML = '';                                   // nothing to diff: the Proposed side is empty by design
  const sug = [];
  if (RB && RB.missed) sug.push(`<b class="brk">MISSES A LOCKED DEPARTURE</b> — ${esc(RB.missed.name)}, be there ${esc(RB.missed.beThereBy)}. The flight/train will not wait.`);
  if (rbEnd > 21 * 60 + 30) {
    const over = rbEnd - (21 * 60 + 30);
    sug.push(`Gets home <b>${EL(rbEnd)}</b> — ${Math.floor(over / 60)}h${String(over % 60).padStart(2, '0')} past 21:30. Fine if you want the stretch; otherwise the Ideas table below is where to trade.`);
  }
  const approxHubs = [...new Set((RB ? RB.stops : []).filter(x => x.hub && x.hub.approx).map(x => x.name))];
  if (approxHubs.length) sug.push(`<b>${esc(approxHubs.join(', '))}</b> — train time is still provisional (HSR tickets go on sale ~15 days ahead), so don't plan tightly against it yet.`);
  for (const n of (RB && RB.absorbed) || []) sug.push(`<b>${esc(n)}</b> is the journey itself — it is the gap between the two locked hubs, not a separate stop.`);
  // The "N of this day's hops are estimated" note was dropped — it fired on nearly every day and said
  // nothing actionable. Estimated-vs-routed is still per-leg in the travel column's tooltip, which is
  // where you'd actually want it. Genuine hard warnings above (missed departure, provisional train)
  // stay; when a day raises none, the whole "Your call" block simply doesn't render.
  const sugHTML = sug.length ? `<div class="chg sug"><div class="chgh">Your call</div><ul>` + sug.map(t => `<li>${t}</li>`).join('') + `</ul></div>` : '';
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
  const noCoord = mapSeq.length - pts.length;
  const mapHTML = `<div class="mapwrap"><div class="chgh">Route map — ${esc(d.city)}, day ${d.day}` +
    `` + ` <span class="apx">numbered in the committed order</span>` +
    `${noCoord ? ` <span class="apx">· ${noCoord} stop${noCoord > 1 ? 's' : ''} without coordinates not shown</span>` : ''}</div>` +
    `<div class="mlg"><span class="mit"><i class="msw mk-act"></i>activity</span>` +
    `<span class="mit"><i class="msw mk-food"></i>food</span>` +
    `<span class="mit"><i class="msw mk-hotel"></i>hotel</span></div>` +
    `<div class="map" data-pts="${esc(JSON.stringify(pts))}"></div></div>`;

  const detail = `<div class="detail">`
    + `<table class="acts">`
    + `<colgroup><col class="wA"><col class="wT"><col class="wT"><col class="wTot">`
    + `<col class="wT"><col class="wT"><col class="wTotP"><col class="wSug">`
    + `<col class="wTv"><col class="wTv"><col class="wTv"></colgroup><thead>`
    + `<tr><th>Activity</th><th class="b1">Start</th><th>End</th><th class="b1r">Total</th>`
    + `<th class="b2">Start</th><th>End</th><th class="b2r">Total</th>`
    + `<th class="hsug">Advice</th>`
    + `<th class="htv b3">Walk</th><th class="htv">Metro</th><th class="htv b3r">DiDi</th></tr></thead>`
    + `<tbody>${rows}</tbody>`
    + `<tfoot><tr class="grp gfoot"><th></th><th class="b1 b1r gh" colspan="3">Current</th>`
    + `<th class="b2 b2r gh" colspan="3">Proposed</th><th></th>`
    + `<th class="gt b3 b3r" colspan="3">Travel to next</th></tr></tfoot></table>`
    + (fixText ? `<div class="sumwrap"><div class="chgh">Summary</div>`
      + `<div class="fix fix-prop${RB && RB.missed ? ' fix-warn' : ''}">${esc(fixText)}</div></div>` : '')
    + ideasHTML + chgHTML + sugHTML + `</div>`;
  // Proposed second line — an alternative segmented track under the day's bar (only when a proposal exists).
  // The proposed bar is deliberately empty — this is where the next review pass will write.
  const row2 = `<div class="row2"><div class="track2 empty" title="Proposed — nothing yet; this is where the next pass writes">${gridHTML}</div></div>`;
  const badge = RB
    // Three states, because two could not tell the truth: a day ending 22:11 is counted in the
    // header's "11 later" but was badged "✓ fits", so the row contradicted the card above it.
    ? (RB.missed ? '<span class="pflag warn2">misses a departure</span>'
      : dsev === 'severe' ? '<span class="pflag warn2">late finish</span>'
      : dsev === 'moderate' ? '<span class="pflag warn2">past 21:30</span>'
      : '<span class="pflag ok2">✓ fits</span>')
    : '';
  out += `<div class="day${dlate ? '' : ' ok-day'} has-prop">` +
    `<div class="dhead" role="button" tabindex="0" aria-expanded="false" aria-label="Day ${d.day} ${esc(d.city)} — expand activities">` +
      `<span class="cv">›</span><span class="dnum">Day ${d.day}</span>` +
      `<span class="ddate">${wd(d.date)} ${dm(d.date)}</span>` +
      `<span class="stops">${RB ? RB.stops.filter(x => !x.meal).length : d.nStops} stops</span>${badge}</div>` +
    mapHTML + miniAx + `<div class="row"><div class="track" title="${tip}">${gridHTML}${renderTrack(rbStops.map(r => ({ s: r.s, d: r.d, name: r.name, meal: !!r.meal, key: nk(r.name), hub: r.hub || null })))}` +
      homeSeg(rbEnd, `${d.home ? '🏠' : '✈'} ${EL(rbEnd)}`,
        dsev === 'severe' ? 'bad' : dsev === 'moderate' ? 'warn' : 'ok2',
        d.home ? `Back to the hotel — ${EL(rbEnd)}` : `Departure day — fly out ${EL(rbEnd)}`) + `</div></div>` +
    row2 + detail + '</div>';
}
out += '</div></section>';

const script = `
const fAll=document.getElementById("fAll"),fBad=document.getElementById("fBad"),chart=document.getElementById("chart");
function setFilter(bad){document.body.classList.toggle("only-bad",bad);
  fBad.setAttribute("aria-pressed",bad);fAll.setAttribute("aria-pressed",!bad);
  document.querySelectorAll(".city").forEach(c=>c.classList.toggle("empty",bad&&c.dataset.bad==="0"));}
fAll.onclick=()=>setFilter(false);fBad.onclick=()=>setFilter(true);
document.getElementById("tFix").onchange=e=>document.body.classList.toggle("hide-fix",!e.target.checked);
function toggleRow(row){const day=row.closest(".day");if(!day)return;const open=day.classList.toggle("open");row.setAttribute("aria-expanded",open);if(open)initMaps(day);}
// Click a block in either bar → select it and highlight the matching row in the table.
function selectSeg(el){
  const day=el.closest(".day"); if(!day) return;
  const key=el.dataset.key, was=el.classList.contains("sel");
  day.querySelectorAll(".seg.sel").forEach(s=>s.classList.remove("sel"));
  day.querySelectorAll("tr.rowsel").forEach(r=>r.classList.remove("rowsel"));
  if(was){                                         // clicking the selected block clears it
    const m0=day.querySelector(".map");
    if(m0&&m0._marks&&window.google&&google.maps){
      Object.keys(m0._marks).forEach(k=>{const m=m0._marks[k];m.setIcon(mkIcon(m.__col,false));m.setZIndex(1);});
      if(m0._gmap&&m0._bounds){const g=m0._gmap,b=m0._bounds;
        g.getCenter()?g.fitBounds(b,40):google.maps.event.addListenerOnce(g,"idle",()=>g.fitBounds(b,40));}
    }
    return;
  }
  day.querySelectorAll('.seg[data-key="'+CSS.escape(key)+'"]').forEach(s=>s.classList.add("sel"));
  if(!day.classList.contains("open")){day.classList.add("open");const r=day.querySelector(".dhead");if(r)r.setAttribute("aria-expanded",true);initMaps(day);}
  const tr=day.querySelector('tr[data-key="'+CSS.escape(key)+'"]');
  if(tr){tr.classList.add("rowsel");tr.scrollIntoView({block:"nearest"});}
  const mp=day.querySelector(".map");
  if(mp&&mp._marks&&window.google&&google.maps){
    Object.keys(mp._marks).forEach(k=>{const m=mp._marks[k];m.setIcon(mkIcon(m.__col,k===key));m.setZIndex(k===key?999:1);});
    const hit=mp._marks[key];
    if(hit&&mp._gmap){
      // Centre the stop, but keep the day's own scale. A fixed setZoom(16) landed you at
      // street level, where the selected pin fills the frame and the rest of the route —
      // the reason you clicked it — is off-screen. Only pull back if the user had manually
      // zoomed in tighter than the day's fitted view; never zoom IN on a selection.
      const g=mp._gmap,go=()=>{
        g.panTo(hit.getPosition());
        const fit=mp._fitZoom;
        if(fit!=null&&g.getZoom()>fit)g.setZoom(fit);
      };
      g.getCenter()?go():google.maps.event.addListenerOnce(g,"idle",go);
    }
  }
}
chart.addEventListener("click",e=>{const s=e.target.closest(".seg");if(s&&s.dataset.key){e.stopPropagation();selectSeg(s);}},true);
chart.addEventListener("keydown",e=>{if(e.key!=="Enter"&&e.key!==" ")return;const s=e.target.closest(".seg");if(s&&s.dataset.key){e.preventDefault();e.stopPropagation();selectSeg(s);}},true);
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
const MKCOL={act:"#2F6FB5",food:"#C77A16",hotel:"#2E7D57"};
function mkIcon(col,on){return{path:google.maps.SymbolPath.CIRCLE,scale:on?15:11,fillColor:col,fillOpacity:1,
  strokeColor:on?"#C1443C":"#ffffff",strokeWeight:on?4:2};}
function initMaps(day){
  if(!window.__gmready||!window.google||!google.maps)return;
  day.querySelectorAll(".map").forEach(el=>{
    if(el.dataset.init)return; el.dataset.init="1";
    let pts=[];try{pts=JSON.parse(el.dataset.pts||"[]");}catch(e){}
    if(!pts.length){el.innerHTML='<div class="mapempty">No coordinates for this day</div>';return;}
    const map=new google.maps.Map(el,{mapTypeControl:false,streetViewControl:false,fullscreenControl:false,
      gestureHandling:"cooperative",zoomControl:true});
    const path=pts.map(p=>({lat:p.lat,lng:p.lng}));
    new google.maps.Polyline({path,strokeOpacity:0,map,
      icons:[{icon:{path:"M 0,-1 0,1",strokeOpacity:.75,strokeColor:"#8C5A2B",scale:3},offset:"0",repeat:"12px"}]});
    const b=new google.maps.LatLngBounds(),marks={};
    pts.forEach(p=>{
      const col=MKCOL[p.t]||MKCOL.act;
      const m=new google.maps.Marker({position:{lat:p.lat,lng:p.lng},map,icon:mkIcon(col,false),
        label:{text:String(p.n),color:"#ffffff",fontSize:"11px",fontWeight:"700"},title:p.n+". "+p.name});
      m.__col=col;
      const iw=new google.maps.InfoWindow({content:"<b>"+p.n+". "+p.name+"</b>"});
      m.addListener("click",()=>iw.open({anchor:m,map}));
      marks[p.k]=m; b.extend(m.getPosition());
    });
    el._marks=marks; el._gmap=map; el._bounds=b;
    map.fitBounds(b,40);
    if(pts.length===1)google.maps.event.addListenerOnce(map,"idle",()=>map.setZoom(15));
    // Remember the scale that shows the WHOLE day. Selecting a stop pans to it but never
    // zooms tighter than this, so the route around it stays visible.
    google.maps.event.addListenerOnce(map,"idle",()=>{el._fitZoom=map.getZoom();});
  });
}
if(window.__gmready)document.querySelectorAll(".day.open").forEach(initMaps);`;

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
.wrap .day{padding-bottom:6px;}
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
.wrap table.acts col.wA{width:23%;} .wrap table.acts col.wT{width:7.5%;}
.wrap table.acts col.wTot{width:8.5%;} .wrap table.acts col.wTotP{width:12%;}
.wrap table.acts col.wSug{width:9%;} .wrap table.acts col.wTv{width:7%;}
.wrap table.acts td.an{overflow:hidden;text-overflow:ellipsis;}
.wrap table.acts td.tm,.wrap table.acts thead th,.wrap table.acts tfoot th{text-align:left;white-space:nowrap;}
.wrap table.acts th.htv,.wrap table.acts td.tv{padding-left:10px;text-align:left;}
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
.wrap table.acts th.b2.gh{color:var(--target);}
.wrap table.acts th.gt{text-align:left;color:var(--ink-3);}
.wrap table.acts .b1{border-left:1px solid var(--line);}
.wrap table.acts .b1r{border-right:1px solid var(--line);}
.wrap table.acts .b2{border-left:1px solid var(--line);}
.wrap table.acts .b2r{border-right:1px solid var(--line);}
.wrap table.acts tbody td.pc{background:color-mix(in srgb,var(--target) 5%,transparent);color:var(--ink-3);}
.wrap .track2.empty{background:repeating-linear-gradient(90deg,var(--surface-2) 0 6px,transparent 6px 12px);opacity:.5;}
.wrap table.acts tr.rhub td{font-weight:700;}
.wrap .ideas{margin:18px 0 4px;}
.wrap table.acts.idt{min-width:0;width:100%;table-layout:auto;}
.wrap table.acts.idt td.iw{color:var(--ink-2);white-space:normal;font-size:10.5px;}
.wrap table.acts.idt td.an{color:var(--ink-2);}
.wrap table.acts tbody tr.rowsel td,.wrap table.acts tbody tr.rowsel td.pc{background:color-mix(in srgb,var(--target) 13%,transparent);}
.wrap table.acts tbody tr:hover td,.wrap table.acts tbody tr:hover td.pc{background:color-mix(in srgb,var(--target) 7%,transparent);}
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



.wrap .chg{margin:0 0 14px;}
.wrap .chgh{font-size:9.5px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;color:var(--ink-3);margin-bottom:6px;}
.wrap .chgh .apx{text-transform:none;letter-spacing:0;font-weight:600;color:var(--warn);margin-left:6px;}
.wrap .chg ul{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:4px;}
.wrap .chg li{font-size:12px;color:var(--ink-2);padding-left:14px;position:relative;max-width:82ch;line-height:1.45;}
.wrap .chg li::before{content:"•";position:absolute;left:2px;color:var(--ink-3);}
.wrap .chg li b{color:var(--ink);font-weight:700;}
.wrap .chg li.c-dropped::before{content:"−";color:var(--bad);}
.wrap .chg li.c-rest::before{content:"+";color:var(--ok);}
.wrap .seg{cursor:pointer;}
.wrap .seg.hub{background:var(--ink);color:var(--bg);border:1px solid var(--ink);font-weight:800;box-shadow:none;}
.wrap .seg.hub .sn{font-weight:800;}
.wrap .seg.hub .sd{opacity:.75;}
.wrap .seg.hub.approx{background:transparent;color:var(--ink);border:1px dashed var(--ink-2);}
.wrap .seg .lk{margin-right:3px;font-size:8px;vertical-align:1px;}
.wrap .seg.bonusseg{opacity:.55;border-style:dashed;}
.wrap .seg.homeseg.broken{background:var(--bad);color:#fff;border-color:var(--bad);}
.wrap .seg.homeseg{width:auto;padding:0 7px;gap:4px;font-weight:800;cursor:default;font-family:var(--mono);
  background:var(--surface);border:1px solid var(--line);color:var(--ink-2);box-shadow:none;}
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
.wrap .sumwrap{margin:22px 0 20px;}
.wrap .detail .fix{padding-left:0;max-width:none;margin:0;color:var(--ink-2);line-height:1.6;}
.wrap .detail .fix::before{content:none;}
.wrap .nummk.on{background:var(--bad);transform:scale(1.25);}
.wrap .leaflet-container{font:inherit;border-radius:12px;}
.wrap .chg.sug li::before{content:"?";color:var(--target);font-weight:800;}
.wrap .chg.sug li b.brk{color:var(--bad);}
.wrap .chg.sug li{color:var(--ink-2);}
.wrap .chg.sug .chgh{color:var(--target);}
.wrap .track{background:${BAND};}
.wrap .track2{position:relative;height:30px;border-radius:7px;background:${BAND};}
.wrap .endlbl2{position:absolute;top:50%;transform:translateY(-50%);font-size:11px;font-weight:800;font-family:var(--mono);color:var(--ok);white-space:nowrap;}
@media (max-width:520px){.wrap table.acts{min-width:300px;}.wrap .seg .sn{display:none;}}
</style>`;

const html = `<meta charset="utf-8"><title>China Trip — Day Load Audit</title>
${GKEY
  ? `<script src="https://maps.googleapis.com/maps/api/js?key=${GKEY}&language=en&region=US&callback=gmapsReady" async><\/script>`
  : `<script>window.addEventListener("DOMContentLoaded",function(){
       document.querySelectorAll(".map").forEach(function(el){
         el.innerHTML='<div class="mapempty">Route map hidden on the published build \\u2014 the Google Maps key is not committed to this public repo. Run the canvas locally to see maps.<\\/div>';
       });});<\/script>`}
<div class="wrap" style="--labelw:128px;--sanea:8.7%;--saneb:71.74%;">
  <header class="top">
    <div class="eyebrow">China · 11 Aug – 7 Sep 2026 · schedule audit</div>
    <h1>How late each day really ends</h1>
    <p class="lede">Each bar is one day on a real clock — from the first stop to <b>getting back to the hotel</b> (recommended time at every stop, plus real travel and the leg home). Bars past the dashed <b style="color:var(--target)">21:30</b> line get you home late; hatched red is past midnight.</p>
    <div class="stats" id="stats">${statsHTML}</div>
  </header>
  <div class="controls">
    <div class="seg" role="group" aria-label="Filter days"><button id="fAll" aria-pressed="true">All days</button><button id="fBad" aria-pressed="false">Home-late only</button></div>
    <button id="xAll" class="xbtn">Expand all</button>
    <button id="thm" class="xbtn" aria-pressed="false">☾ Dark</button>
    <label class="chk"><input type="checkbox" id="tFix" checked> Show fixes</label>
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
<script>${script}</script>`;
writeFileSync(new URL('./china-day-load.html', import.meta.url), html);
console.log('canvas rebuilt:', html.length, 'bytes · days', DATA.length,
  `· ${onTime} home by 21:30 · ${late.length} later (reviewed) · ${missedDep} missed departures`,
  '· axis 06:00→04:00');
