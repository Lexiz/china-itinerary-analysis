// Travel estimation for pairs the routed legs never covered.
//
// Reordering a day breaks the pre-routed legs, so any rebuilt plan needs a way to cost an
// arbitrary A→B. These coefficients are least-squares fits over the 258 real Google-routed legs
// in the snapshot (straight-line km → minutes), so they reproduce the existing data rather than
// inventing a model: walk ±4.6m, metro ±2.2m, didi ±4.6m median error.
export const MODEL = {
  walk:  { base: 5.3, perKm: 18.26, maxKm: 2.2 },   // beyond ~2km nobody walks it
  metro: { base: 13.6, perKm: 2.91 },               // 13.6m fixed = access + wait + exit
  didi:  { base: 6.6, perKm: 1.50 },
};
// Cities where a metro is actually an option.
export const METRO_CITIES = new Set(['Beijing', 'Shanghai', 'Chengdu', 'Chongqing']);

export function km(a, b) {
  if (!a || !b || a.lat == null || b.lat == null) return null;
  const dy = (b.lat - a.lat) * 111.0;
  const dx = (b.lng - a.lng) * 111.0 * Math.cos((a.lat + b.lat) / 2 * Math.PI / 180);
  return Math.hypot(dx, dy);
}

// Same building (hotel breakfast, bag drop at the hotel you just checked into) costs nothing.
export const SAME_PLACE_KM = 0.15;

// Returns {mode, minutes, km, estimated} for any pair of coords.
export function travel(fromCoord, toCoord, city, opts = {}) {
  const d = km(fromCoord, toCoord);
  if (d == null) return { mode: 'didi', minutes: opts.fallback ?? 20, km: null, estimated: true };
  if (d <= SAME_PLACE_KM) return { mode: 'none', minutes: 0, km: d, estimated: false };
  const walk = MODEL.walk.base + MODEL.walk.perKm * d;
  const didi = MODEL.didi.base + MODEL.didi.perKm * d;
  const metro = MODEL.metro.base + MODEL.metro.perKm * d;
  let best;
  if (d <= 1.0) best = { mode: 'walk', minutes: walk };
  else if (METRO_CITIES.has(city) && d > 1.0 && metro <= didi + 8) best = { mode: 'metro', minutes: metro };
  else best = { mode: 'didi', minutes: didi };
  if (best.mode === 'walk' && d > MODEL.walk.maxKm) best = { mode: 'didi', minutes: didi };
  return { mode: best.mode, minutes: Math.max(2, Math.round(best.minutes)), km: +d.toFixed(2), estimated: true };
}
