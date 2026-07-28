// Shared helpers for the working plan: label matching + the per-location change summary.
// Used by BOTH generate-canvas.mjs and generate-timetable.mjs so the bullets on the page and
// the spreadsheet always describe the same diff.

export const nk = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
export const hhmm = m => { const x = ((m % 1440) + 1440) % 1440; return String(Math.floor(x / 60)).padStart(2, '0') + ':' + String(x % 60).padStart(2, '0'); };
export const tkc = t => { const m = String(t || '').match(/(\d{1,2}):(\d{2})/); return m ? (+m[1]) * 60 + (+m[2]) : null; };

// Match a planned label to its stop in the current schedule. Labels differ slightly
// ("Shichahai (dusk)" vs "Shichahai lakes"), so fall back to longest common prefix.
export function matchStop(label, stops) {
  const k = nk(label);
  const live = (stops || []).filter(st => !st.home);
  const exact = live.find(st => nk(st.name) === k);
  if (exact) return exact;
  let best = null, bestLen = 5;
  for (const st of live) {
    const n = nk(st.name);
    let i = 0; while (i < k.length && i < n.length && k[i] === n[i]) i++;
    if (i > bestLen) { bestLen = i; best = st; }
  }
  return best;
}

// Build the per-location change list: what was trimmed, extended, moved, added or dropped.
// Returns [{name, parts:[...], kind}] — only locations that actually changed.
export function changeList(prop, day) {
  const stops = (day?.stops || []).filter(st => !st.home);
  const out = [], used = new Set();

  for (const seg of (prop.new || [])) {
    const cur = matchStop(seg.label, stops);
    if (cur) used.add(cur);
    const parts = [];
    if (!cur) {
      if (seg.kind === 'rest') parts.push('added as a rest block');
      else parts.push('added');
    } else {
      const wasMin = cur.act, nowMin = seg.d;
      // ignore rounding-level differences — only report a real change in how long you spend there
      if (wasMin != null && nowMin != null && Math.abs(nowMin - wasMin) >= 5) {
        const verb = nowMin < wasMin ? 'cut' : 'extended';
        const why = seg.d === cur.res ? ' (researched time)' : '';
        parts.push(`${verb} ${wasMin}m → ${nowMin}m${why}`);
      }
      const wasT = tkc(cur.t), nowT = seg.s % 1440;
      if (wasT != null && Math.abs(nowT - wasT) >= 15) {
        parts.push(`moved ${hhmm(wasT)} → ${hhmm(nowT)}`);
      }
      if (cur.night === 'dusk' && parts.length) parts.push('kept after dark (needs dusk)');
      if (cur.night === 'any' && wasT != null && wasT >= 1110 && nowT < 1110) parts.push('no darkness needed, so freed from the evening');
    }
    if (parts.length) out.push({ name: seg.label, parts, kind: seg.kind });
  }

  for (const st of stops) {
    if (!used.has(st)) out.push({ name: st.name, parts: ['dropped from this day'], kind: 'dropped' });
  }
  return out;
}
