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
const FIX = {
 'Beijing|1': 'Drop Beijing city model (150m) — too much for a 05:00-arrival day.',
 'Beijing|3': 'Cut Mutianyu night tour (you’re back in the city; data error).',
 'Lijiang|1': 'Afternoon arrival: drop Mu Mansion (90m) or move to d3.',
 'Lijiang|3': 'Drop Old Town massage (120m); resolve Jade summit / Impression overlap.',
 'Lijiang|4': 'Heavily over-packed: drop Baisha embroidery + one of Lashi Lake / Tea Horse.',
 'Chengdu|1': 'Evening arrival: keep check-in + dinner + Taikoo Li; drop Daci Temple + IFS panda.',
 'Chengdu|2': 'Sichuan opera is fixed 20:00 — drop People’s Park so dinner⇒18:30.',
 'Chengdu|3': 'Sanxingdui is a half-day trip — drop SKP + one of Wuhou/Jinli.',
 'Chongqing|1': 'Trim riverside night stops to Hongya Cave only (drop 3).',
 'Chongqing|2': 'Borderline — night cruise ends ~22:00. Optional dinner →18:30.',
 'Zhangjiajie|1': 'Wulingyuan hotel: dinner is far — eat nearer the park to shorten the trip home.',
 'Zhangjiajie|2': 'Park has no through-roads (6km ≈ 30km drive) — dine inside the park before leaving.',
 'Zhangjiajie|3': 'Tianmen is downtown (~46km home) — consider a downtown hotel for this night, or move Tianmen.',
 'Furong (Hibiscus)|1': 'Drop the 3 evening squares; keep waterfall + cruise + dinner.',
 'Fenghuang|1': 'Evening arrival: keep Ancient Town + Hong Bridge + dinner + night boat; drop 4-5.',
 'Guilin|1': 'Drop Reed Flute Cave (out-of-town); keep Elephant Hill + night cruise.',
 'Yangshuo|1': 'Impression show fixed ~19:45 — move dinner before it; drop Fengqi stop.',
 'Yangshuo|2': 'Cut Sunrise balloon (21:20 is wrong — dawn activity).',
 'Shanghai|1': 'Minor: trim Nanjing Rd East so dinner⇒19:30.',
 'Shanghai|2': 'Drop one of Zhangyuan / Nanjing Rd West so dinner⇒19:30.',
 'Shanghai|3': '13 stops: drop 2 stray Dinner-alts + Wulumuqi/Anfu Rd.',
 'Shanghai|4': 'Trim Yu Garden cluster + drop M50 so dinner⇒19:00.',
 'Shanghai|5': '3 museums too many — drop 1; tower cluster keep Shanghai Tower only.',
 'Shanghai|6': 'Departure day: trim Oriental Pearl so dinner⇒19:00.',
};
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
  // unwrap the day across midnight, in order, so post-midnight stops score 1440+
  const absOf = new Map();
  { let base = 0, prev = -1;
    for (const a of acts) {
      const cm = tk(a.time); if (cm == null) continue;
      let v = base + cm; if (v < prev) { base += 1440; v += 1440; } prev = v;
      absOf.set(a, v);
    } }
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
  const flagged = (dinner && tk(dinner.time) > 19 * 60 + 30) || (lunch && tk(lunch.time) > 14 * 60) || jammed >= 1 || endMin > 21 * 60 + 30;
  const sev = flagged ? (jammed >= 1 || endMin >= 22 * 60 + 30 ? 'severe' : 'moderate') : 'ok';
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
  out.push({ city: c.name, accent: c.accent, order: c.order, day: d.cityDay, date: addDays(c.dates.start, d.cityDay - 1),
    startMin, endMin, lunchMin: lunch ? tk(lunch.time) : null, dinnerMin: dinner ? tk(dinner.time) : null,
    nStops: real.length, jammed, home: !!home, homeMode, homeMin, homeKm, flagged, sev,
    isArrival: !!d.isArrival, isDeparture: !!d.isDeparture,
    fix: FIX[`${c.name}|${d.cityDay}`] || '', stops });
}
out.sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : a.order - b.order);
writeFileSync(new URL('./viz-data.json', import.meta.url), JSON.stringify(out));
const max = Math.max(...out.map(d => d.endMin));
console.log('days:', out.length, '| flagged:', out.filter(d => d.flagged).length, '| severe:', out.filter(d => d.sev === 'severe').length);
console.log('max endMin (home arrival):', max, '=', Math.floor(max / 60) + ':' + String(max % 60).padStart(2, '0'), max > 1560 ? '→ EXCEEDS 02:00 axis' : '(within axis)');
console.log('latest homes:', out.filter(d => d.endMin > 1440).sort((a, b) => b.endMin - a.endMin).slice(0, 6).map(d => `${d.city} d${d.day} ${Math.floor(d.endMin/60)}:${String(d.endMin%60).padStart(2,'0')}`).join(' · '));
