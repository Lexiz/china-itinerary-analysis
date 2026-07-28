// Emits timetable.csv — the working day-by-day plan, generated from the SAME proposals.json
// that drives the canvas proposed line, so the spreadsheet and the visualisation can never drift.
// Deliberately outside Notion: this is the review-phase working copy.
import { readFileSync, writeFileSync } from 'node:fs';
import { matchStop } from './lib-plan.mjs';
let GEN = {}, HAND = {};
try { GEN = JSON.parse(readFileSync(new URL('./replanned.json', import.meta.url))); } catch { GEN = {}; }
try { HAND = JSON.parse(readFileSync(new URL('./proposals.json', import.meta.url))); } catch { HAND = {}; }
const PROPS = { ...GEN, ...HAND };
const DATA = JSON.parse(readFileSync(new URL('./viz-data.json', import.meta.url)));

const hhmm = m => { const x = ((m % 1440) + 1440) % 1440; return String(Math.floor(x / 60)).padStart(2, '0') + ':' + String(x % 60).padStart(2, '0'); };
const nk = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const q = v => { const s = String(v ?? ''); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };

const rows = [['Day', 'Date', 'City', 'Status', '#', 'Activity', 'Start', 'End', 'Min', 'Travel to next (min)', 'Change', 'Now start', 'Now min', 'Suggested', 'Note']];

for (const [key, p] of Object.entries(PROPS)) {
  if (key.startsWith('_') || !p || !p.new) continue;
  const [city, dayStr] = key.split('|');
  const day = Number(dayStr);
  const d = DATA.find(x => x.city === city && x.day === day);
  const matchNow = label => matchStop(label, d?.stops || []);

  p.new.forEach((seg, i) => {
    const next = p.new[i + 1];
    const travel = next ? next.s - (seg.s + seg.d) : '';
    const cur = matchNow(seg.label);
    rows.push([day, d?.date || '', city, p.status || 'proposed', i + 1, seg.label,
      hhmm(seg.s), hhmm(seg.s + seg.d), seg.d, travel,
      seg.change || '', cur?.t || '', cur?.act ?? '', cur?.res ?? '', seg.note || '']);
  });
  // the day's endpoint — arriving back at the hotel
  rows.push([day, d?.date || '', city, p.status || 'proposed', p.new.length + 1, 'Back to the hotel',
    p.homeNew || hhmm(p.newEndMin ?? 0), '', '', '', 'endpoint', d ? (d.endMin >= 1440 ? hhmm(d.endMin) + ' +1' : hhmm(d.endMin)) : '', '', '',
    `was ${d ? hhmm(d.endMin) : '?'} — now ${p.homeNew || ''}`]);
}

const csv = rows.map(r => r.map(q).join(',')).join('\n') + '\n';
writeFileSync(new URL('../timetable.csv', import.meta.url), csv);
const planned = rows.length - 1;
console.log('timetable.csv written ·', planned, 'rows ·', Object.keys(PROPS).filter(k => !k.startsWith('_')).length, 'day(s) planned');
