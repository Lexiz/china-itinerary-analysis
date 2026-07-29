// Emits timetable.csv — the committed day-by-day plan as a spreadsheet.
//
// This used to read replanned.json + proposals.json, the review-phase working copy. Those are
// retired (see README "Direction of truth"): the canvas, the Notion workbook and this CSV now all
// read rebuilt.json, so the three cannot disagree about what was agreed.
//
// The "Now" columns compare the committed plan against what the Notion snapshot currently holds —
// i.e. what is still un-applied. Once apply-plan.mjs has run they read as no change, which is the
// correct and expected steady state, not an empty result.
import { readFileSync, writeFileSync } from 'node:fs';
import { matchStop } from './lib-plan.mjs';
const REBUILT = JSON.parse(readFileSync(new URL('./rebuilt.json', import.meta.url)));
const DATA = JSON.parse(readFileSync(new URL('./viz-data.json', import.meta.url)));

const hhmm = m => { const x = ((m % 1440) + 1440) % 1440; return String(Math.floor(x / 60)).padStart(2, '0') + ':' + String(x % 60).padStart(2, '0'); };
const el = m => m >= 1440 ? hhmm(m) + ' +1' : hhmm(m);
const q = v => { const s = String(v ?? ''); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };

const rows = [['Day', 'Date', 'City', 'Kind', '#', 'Activity', 'Start', 'End', 'Min', 'Travel to next (min)', 'Capped', 'Now start', 'Now min', 'Suggested', 'Note']];

let days = 0;
for (const [key, p] of Object.entries(REBUILT.days || {})) {
  if (key.startsWith('_') || !p || !p.stops) continue;
  const [city, dayStr] = key.split('|');
  const day = Number(dayStr);
  const d = DATA.find(x => x.city === city && x.day === day);
  days++;

  p.stops.forEach((st, i) => {
    const next = p.stops[i + 1];
    // The leg OUT of this stop is the next stop's travelIn — the last one's is the trip home.
    const t = next ? next.travelIn : (p.homeTravel || null);
    const travel = t ? (t.coloc ? 0 : t.minutes) : '';
    const cur = matchStop(st.name, d?.stops || []);
    // A dwell cut short by a closing time has to say so, or a shorter Min reads as "that's all it
    // needs" rather than "that's all the day could buy".
    const capped = st.cap ? `closes ${st.cap.closes}${st.cap.tooLate ? ' — ARRIVES AFTER LAST ENTRY' : ` (−${st.cap.lost}m)`}` : '';
    rows.push([day, p.date || d?.date || '', city, st.kind || '', i + 1, st.name,
      hhmm(st.s), hhmm(st.s + st.d), st.d, travel,
      capped, cur?.t || '', cur?.act ?? '', st.advice ?? cur?.res ?? '',
      st.lateFor ? `late for ${st.lateFor}` : '']);
  });

  // the day's endpoint — arriving back at the hotel, or the airport on a departure day
  const t = p.homeTravel;
  rows.push([day, p.date || d?.date || '', city, 'endpoint', p.stops.length + 1,
    d && d.home === false ? 'Fly out' : 'Back to the hotel',
    el(p.endMin), '', '', '', '', '', '', '',
    [t ? `${t.mode} ${t.minutes}m${t.km != null ? '/' + t.km + 'km' : ''}${t.estimated ? ' (estimated)' : ' (routed)'}` : '',
     p.missed ? `MISSES ${p.missed.name} — be there ${p.missed.beThereBy}` : ''].filter(Boolean).join(' · ')]);
}

const csv = rows.map(r => r.map(q).join(',')).join('\n') + '\n';
writeFileSync(new URL('../timetable.csv', import.meta.url), csv);
console.log('timetable.csv written ·', rows.length - 1, 'rows ·', days, 'day(s) — from the committed plan');
