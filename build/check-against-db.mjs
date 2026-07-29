/**
 * Does the page agree with the database, stop by stop?
 *
 *   DATABASE_URL=… node build/check-against-db.mjs
 *
 * This exists because it once did not, silently, for weeks. `rebuild.mjs` re-chained
 * every day from the researched durations and the canvas rendered that, while the
 * app rendered what Postgres held — 35 of 37 days disagreed, by up to nine hours,
 * and nothing on either surface said so. The page looked authoritative and was
 * describing a plan that had never been applied.
 *
 * `project.mjs` copies the clock instead of recomputing it, so the two cannot drift
 * by construction. This proves the construction, against the live database, rather
 * than trusting it: every stop's start and dwell, compared to `schedule`.
 *
 * Reads the plan the page renders (`rebuilt.json`), not the snapshot it came from —
 * otherwise it would only be checking that a file equals itself.
 */
import { readFileSync } from 'node:fs';
import postgres from 'postgres';

const RB = JSON.parse(readFileSync(new URL('./rebuilt.json', import.meta.url))).days;
const hhmm = (m) => `${String(Math.floor(((m % 1440) + 1440) % 1440 / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}${m >= 1440 ? '+1' : ''}`;
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');

const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL not set'); process.exit(1); }
const sql = postgres(url, { prepare: false, ssl: 'require', max: 4 });

try {
  // The committed plan, as the database holds it. `start_at` is what recalc() wrote;
  // minutes are measured from the day's own local midnight so a stop after 00:00
  // scores past 1440, exactly as the canvas axis expects.
  const rows = await sql`
    select c.name as city, d.city_day as day,
           -- the same name the snapshot emits: the STOP's own short label first (breakfast
           -- borrows a hotel row and must not be called by it), then the PLACE's short label,
           -- which is what most timeline rows actually read
           coalesce(s.short_label, p.short_label, p.name, s.label) as name,
           s.planned_dwell_min as dwell,
           round(extract(epoch from (sch.start_at - (d.date::timestamp at time zone 'Asia/Shanghai'))) / 60)::int as start_min,
           s.is_bonus as bonus, s.slot_kind::text as slot,
           to_char(d.date,'YYYY-MM-DD') as date,
           (s.slot_kind in ('breakfast','lunch','dinner')) as is_meal
    from stop s
    join scenario sc on sc.id = s.scenario_id and sc.kind = 'committed'
    join day d on d.id = sc.day_id
    join city c on c.id = d.city_id
    join schedule sch on sch.stop_id = s.id
    left join place p on p.id = s.place_id
    order by c.ord, d.city_day, s.seq`;

  const byDay = new Map();
  for (const r of rows) {
    const k = `${r.city}|${r.day}`;
    if (!byDay.has(k)) byDay.set(k, []);
    byDay.get(k).push(r);
  }

  // A transition date belongs to two city-days — the one you leave and the one you
  // arrive in — and the database files a breakfast/lunch/dinner stop under BOTH. The
  // meal happens once, so the page draws it once, on the side where you actually eat
  // it. Counting the other copy as missing would report 24 phantom omissions on a
  // page whose whole point is that it hides nothing.
  const shared = await sql`
    select to_char(d.date,'YYYY-MM-DD') as date from day d
    group by d.date having count(*) > 1`;
  const sharedDates = new Set(shared.map((r) => r.date));

  let checked = 0, startBad = 0, missing = 0;
  const problems = [];
  const twinMeals = [];

  for (const [k, day] of Object.entries(RB)) {
    const dbStops = byDay.get(k);
    if (!dbStops) { problems.push(`${k}: the database has no such day`); continue; }
    for (const st of day.stops) {
      const hit = dbStops.find((r) => norm(r.name) === norm(st.name));
      if (!hit) { missing++; problems.push(`${k}: "${st.name}" is on the page but not in the database`); continue; }
      checked++;
      // The page must show the database's clock. Dwell is deliberately NOT compared:
      // the snapshot reports elapsed time per stop (dwell + the 8-minute slack the
      // chain leaves after it), which is what a bar on a clock axis should be wide.
      if (st.s !== hit.start_min) {
        startBad++;
        problems.push(`${k}: "${st.name}" starts ${hhmm(st.s)} on the page, ${hhmm(hit.start_min)} in the database`);
      }
    }
  }

  // …and the other direction: is anything in the database absent from the page?
  const onPage = new Set();
  for (const [k, day] of Object.entries(RB)) for (const st of day.stops) onPage.add(`${k}::${norm(st.name)}`);
  const notDrawn = [];
  for (const r of rows) {
    if (onPage.has(`${r.city}|${r.day}::${norm(r.name)}`)) continue;
    if (r.is_meal && sharedDates.has(r.date)) { twinMeals.push(r); continue; }
    notDrawn.push(r);
  }

  console.log(`days on the page: ${Object.keys(RB).length} · days in the database: ${byDay.size}`);
  console.log(`stops compared:   ${checked}`);
  console.log(`start times differing: ${startBad}`);
  console.log(`on the page but not in the database: ${missing}`);
  console.log(`in the database but not drawn: ${notDrawn.length}`);
  console.log(`  (plus ${twinMeals.length} transition-date meal twins, drawn once on the other side — expected)`);
  for (const r of notDrawn) problems.push(`${r.city}|${r.day}: "${r.name}" (${r.slot ?? 'no slot'}) is in the database but not on the page`);
  if (problems.length) {
    console.log(`\n❌ ${problems.length} problem(s):`);
    problems.slice(0, 25).forEach((p) => console.log('   ' + p));
    if (problems.length > 25) console.log(`   … and ${problems.length - 25} more`);
    process.exitCode = 1;
  } else {
    console.log('\n✅ the page and the database agree on every stop.');
  }
} finally {
  await sql.end();
}
