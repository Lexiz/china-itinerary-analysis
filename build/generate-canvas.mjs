import { readFileSync, writeFileSync } from 'node:fs';
const DATA = JSON.parse(readFileSync(new URL('./viz-data.json', import.meta.url)));
const STYLE = readFileSync(new URL('./canvas-style.html', import.meta.url), 'utf8');

// axis: 06:00 -> 04:00 (some over-packed days now get you home after 02:00)
const T0 = 360, T1 = 1680, SPAN = T1 - T0;
const P = m => Math.max(0, Math.min(100, (m - T0) / SPAN * 100));
const hhmm = m => { const x = ((m % 1440) + 1440) % 1440; return String(Math.floor(x / 60)).padStart(2, '0') + ':' + String(x % 60).padStart(2, '0'); };
const EL = m => m >= 1440 ? hhmm(m) + ' ⁺¹' : hhmm(m);
const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'], MO = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const wd = iso => WD[new Date(iso + 'T00:00:00Z').getUTCDay()];
const dm = iso => { const d = new Date(iso + 'T00:00:00Z'); return d.getUTCDate() + ' ' + MO[d.getUTCMonth()]; };
const sev = s => s === 'severe' ? 'var(--bad)' : s === 'moderate' ? 'var(--warn)' : 'var(--ok)';
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const flagged = DATA.filter(d => d.flagged), severe = DATA.filter(d => d.sev === 'severe'), moderate = DATA.filter(d => d.sev === 'moderate');
const worst = [...severe].sort((a, b) => (b.jammed - a.jammed) || (b.endMin - a.endMin))[0];
const statsHTML = [['bad', flagged.length, 'get home late'], ['bad', severe.length, 'need real cuts'],
  ['warn', moderate.length, 'a bit late'], ['', worst ? `${worst.city} d${worst.day}` : '—', 'worst — home ' + (worst ? EL(worst.endMin) : '')]]
  .map(([c, n, k]) => `<div class="stat ${c}"><div class="n">${esc(n)}</div><div class="k">${k}</div></div>`).join('');

const ticks = [[360,'06'],[540,'09'],[720,'12'],[900,'15'],[1080,'18'],[1290,'21:30',1],[1440,'00'],[1560,'02'],[1680,'04']];
const axisHTML = ticks.map(([m, l, s]) => `<span class="tk${s ? ' s' : ''}" style="left:${P(m)}%">${l}</span>`).join('');

const mealPip = (m, L) => m == null ? '' : `<div class="meal" style="left:${P(m)}%"><span class="pip" style="background:${(L === 'D' ? m > 1170 : m > 840) ? 'var(--bad)' : 'var(--ok)'}"></span><span class="ml">${L}</span></div>`;
let cur = null, out = '';
for (const d of DATA) {
  if (d.city !== cur) {
    if (cur !== null) out += '</div></section>';
    cur = d.city;
    const cd = DATA.filter(x => x.city === d.city), bad = cd.filter(x => x.flagged).length;
    out += `<section class="city" data-bad="${bad}" style="--cx:${d.accent}">` +
      `<div class="city-head"><span class="city-dot" style="background:${d.accent}"></span>` +
      `<span class="city-name">${esc(d.city)}</span>` +
      `<span class="city-meta">${cd.length} day${cd.length > 1 ? 's' : ''}${bad ? ` · <b>${bad} late</b>` : ' · all clear'}</span></div><div class="city-body">`;
  }
  const L = P(d.startMin), R = P(d.endMin), fillR = Math.min(R, P(1290)), fw = ((fillR - L) / (R - L) * 100) || 0, ofc = sev(d.sev);
  const ec = d.endMin > 1350 ? 'var(--bad)' : d.endMin > 1290 ? 'var(--warn)' : 'var(--ink-2)';
  const es = R > 80 ? `right:${100 - R}%;padding-right:6px;text-align:right` : `left:${R}%;padding-left:6px`;
  const of = d.endMin > 1290 ? `<div class="overflow" style="left:${P(1290)}%;right:${100 - R}%;background:repeating-linear-gradient(45deg,${ofc} 0 3px,transparent 3px 7px);box-shadow:inset 0 0 0 1px ${ofc}"></div>` : '';
  const homeTxt = d.home && d.homeMin != null ? ` · home ${d.homeMode} ${d.homeMin}m${d.homeKm != null ? '/' + d.homeKm + 'km' : ''}` : (d.home ? '' : ' · departs (no return)');
  const tip = esc(`${d.city} Day ${d.day} · ${wd(d.date)} ${dm(d.date)}\n${d.nStops} stops · ${d.lunchMin ? 'lunch ' + hhmm(d.lunchMin) : 'no lunch'} · ${d.dinnerMin ? 'dinner ' + hhmm(d.dinnerMin) : 'no dinner'}${homeTxt} · home ${EL(d.endMin)}`);
  const mode = (icon, min, isRec) => `<span class="mo${isRec ? ' rec' : ''}">${icon}${min != null ? min : '—'}</span>`;
  const rows = (d.stops || []).map(st => {
    // Actual is judged against the RESEARCHED suggested time (fallback to our default)
    const base = st.res ?? st.adv;
    const ratio = base && st.act != null ? st.act / base : null;
    const rc = ratio == null ? '' : ratio < 0.5 ? ' r' : ratio < 0.8 ? ' t' : '';
    const tag = st.home ? ' <span class="tag">home</span>' : st.meal ? ' <span class="tag">meal</span>' : '';
    const cls = [st.home ? 'rhome' : '', st.meal ? 'rmeal' : ''].filter(Boolean).join(' ');
    const travel = st.home ? '' : `${mode('🚶', st.w, st.rec === 'walk')} ${mode('🚇', st.me, st.rec === 'metro')} ${mode('🚕', st.dd, st.rec === 'didi')}`;
    return `<tr class="${cls}"><td class="an">${esc(st.name)}${tag}</td>` +
      `<td class="tm">${st.t || '—'}</td><td class="tm end">${st.end || '—'}</td>` +
      `<td class="tm def">${st.adv != null ? st.adv + 'm' : '—'}</td>` +
      `<td class="tm res"${st.resnote ? ` title="${esc(st.resnote)}"` : ''}>${st.res != null ? st.res + 'm' : '—'}</td>` +
      `<td class="tm act${rc}">${st.act != null ? st.act + 'm' : '—'}</td>` +
      `<td class="tv">${travel}</td></tr>`;
  }).join('');
  const detail = `<div class="detail"><table class="acts"><thead><tr><th>Activity</th><th>Start</th><th>End</th><th>Default</th><th class="hres">Suggested</th><th class="hact">Actual</th><th class="htv">Travel → next</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  out += `<div class="day${d.flagged ? '' : ' ok-day'}">` +
    `<div class="row" role="button" tabindex="0" aria-expanded="false" aria-label="Day ${d.day} ${esc(d.city)} — expand activities">` +
    `<div class="lbl"><div class="d"><span class="cv">›</span>Day ${d.day}</div><div class="dt">${wd(d.date)} ${dm(d.date)}</div><span class="stops">${d.nStops} stops</span></div>` +
    `<div class="track" title="${tip}"><div class="gl" style="left:${P(540)}%"></div><div class="gl" style="left:${P(720)}%"></div>` +
      `<div class="gl" style="left:${P(900)}%"></div><div class="gl" style="left:${P(1080)}%"></div><div class="gl mid" style="left:${P(1440)}%"></div><div class="gl tgt" style="left:${P(1290)}%"></div>` +
      `<div class="bar ${d.sev}" style="left:${L}%;right:${100 - R}%"><div class="fill" style="width:${fw}%"></div></div>${of}${mealPip(d.lunchMin, 'L')}${mealPip(d.dinnerMin, 'D')}` +
      `<div class="endlbl" style="${es};color:${ec}">${EL(d.endMin)}</div></div></div>` +
    (d.fix ? `<div class="fix">${esc(d.fix)}</div>` : '') + detail + '</div>';
}
out += '</div></section>';

const script = `
const fAll=document.getElementById("fAll"),fBad=document.getElementById("fBad"),chart=document.getElementById("chart");
function setFilter(bad){document.body.classList.toggle("only-bad",bad);
  fBad.setAttribute("aria-pressed",bad);fAll.setAttribute("aria-pressed",!bad);
  document.querySelectorAll(".city").forEach(c=>c.classList.toggle("empty",bad&&c.dataset.bad==="0"));}
fAll.onclick=()=>setFilter(false);fBad.onclick=()=>setFilter(true);
document.getElementById("tFix").onchange=e=>document.body.classList.toggle("hide-fix",!e.target.checked);
function toggleRow(row){const day=row.closest(".day");if(!day)return;const open=day.classList.toggle("open");row.setAttribute("aria-expanded",open);}
chart.addEventListener("click",e=>{const r=e.target.closest(".row");if(r)toggleRow(r);});
chart.addEventListener("keydown",e=>{if(e.key!=="Enter"&&e.key!==" ")return;const r=e.target.closest(".row");if(r){e.preventDefault();toggleRow(r);}});
// expand-all / collapse-all
const xa=document.getElementById("xAll");if(xa)xa.onclick=()=>{const any=!document.querySelector(".day.open");document.querySelectorAll(".day").forEach(d=>{d.classList.toggle("open",any);const r=d.querySelector(".row");if(r)r.setAttribute("aria-expanded",any);});xa.textContent=any?"Collapse all":"Expand all";};`;

const EXTRA = `<style>
.wrap .day .row{cursor:pointer;border-radius:9px;}
.wrap .day .row:focus-visible{outline:2px solid var(--target);outline-offset:-2px;}
.wrap .cv{display:inline-block;transition:transform .15s ease;color:var(--ink-3);font-weight:700;margin-right:5px;}
.wrap .day.open .cv{transform:rotate(90deg);}
.wrap .day .fix{padding-left:130px;}
.wrap .detail{display:none;padding:2px 0 12px 130px;overflow-x:auto;}
.wrap .day.open .detail{display:block;}
.wrap table.acts{border-collapse:collapse;font-size:12px;min-width:360px;}
.wrap table.acts th{font-size:9.5px;font-weight:800;letter-spacing:.05em;text-transform:uppercase;color:var(--ink-3);border-bottom:1px solid var(--line);}
.wrap table.acts th,.wrap table.acts td{padding:7px 0 7px 60px;}
.wrap table.acts th:first-child,.wrap table.acts td:first-child{padding-left:0;text-align:left;}
.wrap table.acts th:not(:first-child),.wrap table.acts td:not(:first-child){text-align:right;}
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
.wrap table.acts{min-width:900px;}
body.only-bad .wrap .day.ok-day{display:none;}
.wrap .xbtn{font:inherit;font-size:12.5px;font-weight:600;color:var(--ink-2);background:var(--surface-2);border:1px solid var(--line);border-radius:9px;padding:6px 12px;cursor:pointer;}
.wrap .xbtn:hover{color:var(--ink);}
.wrap .xbtn:focus-visible{outline:2px solid var(--target);outline-offset:2px;}
@media (max-width:520px){.wrap .day .fix,.wrap .detail{padding-left:82px;}.wrap table.acts{min-width:300px;}}
</style>`;

const html = `<meta charset="utf-8"><title>China Trip — Day Load Audit</title>
<div class="wrap" style="--labelw:128px;--sanea:4.5%;--saneb:70.5%;">
  <header class="top">
    <div class="eyebrow">China · 11 Aug – 7 Sep 2026 · schedule audit</div>
    <h1>How late each day really ends</h1>
    <p class="lede">Each bar is one day on a real clock — from the first stop to <b>getting back to the hotel</b> (recommended time at every stop, plus real travel and the leg home). Bars past the dashed <b style="color:var(--target)">21:30</b> line get you home late; hatched red is past midnight.</p>
    <div class="stats" id="stats">${statsHTML}</div>
  </header>
  <div class="controls">
    <div class="seg" role="group" aria-label="Filter days"><button id="fAll" aria-pressed="true">All days</button><button id="fBad" aria-pressed="false">Home-late only</button></div>
    <button id="xAll" class="xbtn">Expand all</button>
    <label class="chk"><input type="checkbox" id="tFix" checked> Show fixes</label>
    <div class="legend">
      <span class="it"><span class="sw" style="background:var(--ok)"></span>Home by 21:30</span>
      <span class="it"><span class="sw" style="background:var(--warn)"></span>A bit late</span>
      <span class="it"><span class="sw" style="background:var(--bad)"></span>Late / past midnight</span>
      <span class="it"><span class="pip" style="position:static;width:9px;height:9px;border-radius:50%;background:var(--bad);border:1.5px solid var(--bg);display:inline-block"></span>late meal</span>
    </div>
  </div>
  <div class="axis" style="--labelw:128px;"><div></div><div class="track-head" id="axis">${axisHTML}</div></div>
  <main id="chart">${out}</main>
  <p class="foot">The day now ends when you <b>arrive back at the hotel</b> — recommended time at each stop, real walk/metro/DiDi legs, and the trip home. Over-packed evenings and long commutes (e.g. Wulingyuan's mountain roads, Tianmen downtown) both push the end past a sane hour. Fixes suggest how to pull each day back under ~21:30.</p>
</div>
${STYLE}
${EXTRA}
<script>${script}</script>`;
writeFileSync(new URL('./china-day-load.html', import.meta.url), html);
console.log('canvas rebuilt:', html.length, 'bytes · days', DATA.length, '· flagged', flagged.length, '· axis 06:00→04:00');
