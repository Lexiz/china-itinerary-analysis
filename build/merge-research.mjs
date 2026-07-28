// Merges the per-city research files in build/research2/ into researched.json.
//
// Each city file is { "<venue name>": { m, n, basis, conf } } produced by a research pass that
// checked real visitor reports. `basis` and `conf` are kept so every advised time can be traced
// back to why we believe it — an advised number with no justification is just a guess in disguise.
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';

const dir = new URL('./research2/', import.meta.url);
const files = readdirSync(dir).filter(f => f.endsWith('.json') && !f.startsWith('_in_'));

const out = {};
let n = 0, low = 0;
const perCity = [];
for (const f of files.sort()) {
  let j;
  try { j = JSON.parse(readFileSync(new URL(f, dir), 'utf8')); } catch (e) { console.log(`  ! ${f}: ${e.message}`); continue; }
  let c = 0;
  for (const [name, v] of Object.entries(j)) {
    if (!v || typeof v.m !== 'number') continue;
    out[name.trim()] = { m: Math.round(v.m), n: v.n || '', basis: v.basis || '', conf: v.conf || '' };
    if (v.conf === 'low') low++;
    c++; n++;
  }
  perCity.push(`${f.replace('.json', '')}:${c}`);
}

// keep anything the old file had that the new pass didn't cover, so nothing regresses to blank
const prev = JSON.parse(readFileSync(new URL('./researched.json', import.meta.url), 'utf8'));
let kept = 0;
for (const [k, v] of Object.entries(prev)) if (!(k in out)) { out[k] = v; kept++; }

writeFileSync(new URL('./researched.json', import.meta.url), JSON.stringify(out, null, 1));
console.log(`researched.json: ${Object.keys(out).length} venues (${n} newly validated, ${kept} carried over, ${low} low-confidence)`);
console.log('per city:', perCity.join(' '));
