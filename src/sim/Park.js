import { Vector3 } from 'three';
import { LAYOUTS, DEFAULT_LAYOUT, findLayout } from './Layouts.js';

/**
 * The skatepark, defined once as a height function.
 *
 * Collision, the landing surface normal, the camera's ground clearance and the
 * visual mesh are all generated from sampleGround(). There is no second,
 * drifting copy of the level geometry.
 *
 * Which park is a runtime choice — see sim/Layouts.js for the data and the
 * constraints every layout has to satisfy. Everything below reads the ACTIVE
 * layout, so the whole file is layout-agnostic: the only thing that changes
 * when you pick a different park is `active`.
 *
 * Each layout is periodic over its own run length with flat ground at the seam,
 * so the run loops forever without a visible join.
 */

let active = findLayout(DEFAULT_LAYOUT);

/** Switch parks. Returns the layout now in play. */
export function setLayout(id) {
  const next = findLayout(id);
  if (next) active = next;
  return active;
}

export function getLayout() {
  return active;
}

/** Every park, for the map picker. */
export function listLayouts() {
  return LAYOUTS.map(({ id, name, blurb, runLength }) => ({ id, name, blurb, runLength }));
}

/**
 * Height of the underlying ground at z, before anything is built on it.
 *
 * The profile is a list of control points joined by smoothsteps, which gives a
 * continuous derivative everywhere — and therefore a continuous surface normal,
 * without which landings feel arbitrary. The first and last points are pinned
 * to y = 0 so the lap closes.
 *
 * Exported because the visual layer needs the gradient on its own: the far
 * ground beyond the park has to follow the same slope, and it can only do that
 * without cutting through the park if it knows the terrain apart from the
 * features standing on it.
 */
export function terrainHeight(z) {
  const p = active.terrain;
  const t = wrapZ(z);
  for (let i = 0; i < p.length - 1; i++) {
    const a = p[i];
    const b = p[i + 1];
    if (t > b.z) continue;
    if (t <= a.z) return a.y;
    return a.y + (b.y - a.y) * smoothstep(a.z, b.z, t);
  }
  return p[p.length - 1].y;
}

const _n = new Vector3();

/** Wrap a world Z into the park's repeating domain. */
export function wrapZ(z) {
  const RUN = active.runLength;
  let t = z % RUN;
  if (t < 0) t += RUN;
  return t;
}

/** Height of the park surface under (x, z): the terrain, plus anything built on it. */
export function groundHeight(x, z) {
  const t = wrapZ(z);
  return terrainHeight(t) + featureHeightAt(x, t);
}

/**
 * How far the built features rise above the terrain at a point. Separate from
 * groundHeight because several things care about height ABOVE the ground rather
 * than absolute height — the wood/concrete split, and what counts as climbable.
 */
export function featureHeightAt(x, z) {
  const t = wrapZ(z);
  let h = 0;
  for (const f of active.features) {
    h = Math.max(h, featureHeight(f, x, t));
  }
  return h;
}

function featureHeight(f, x, z) {
  // Features can sit off the centreline, which is what lets two of them form
  // a hip without needing a new shape.
  const lateral = lateralFalloff(x - (f.offsetX || 0), f.halfWidth);
  if (lateral <= 0) return 0;

  if (f.type === 'quarter') {
    // A true quarterpipe: a circular transition of `radius` rising to `height`.
    // h = R - sqrt(R^2 - t^2) is the concave curve, and the steepening normal
    // it produces is what converts the rider's speed into height.
    const R = f.radius;
    const h = Math.min(f.height, R);
    // Where the curve reaches `height`: solve R - sqrt(R^2 - t^2) = h.
    const reach = Math.sqrt(Math.max(0, R * R - (R - h) * (R - h)));
    if (z < f.z0 || z > f.z0 + reach) return 0;
    const t = z - f.z0;
    return (R - Math.sqrt(Math.max(0, R * R - t * t))) * lateral;
  }

  if (f.type === 'ledge') {
    // A raised slab with softened ends so the run-up is rideable; the far end
    // stays sharp, which is the bit you pop off.
    if (z < f.z0 - f.blend || z > f.z1) return 0;
    const rise = smoothstep(f.z0 - f.blend, f.z0, z);
    return f.height * rise * lateral;
  }

  if (f.type === 'bank') {
    // A flat-faced bank. `facing` +1 rises along +Z and is what you launch off;
    // -1 falls along +Z and is what you land on. A landing bank needs a short
    // steep lead-in rather than a bare vertical step, or a rider who comes up
    // short teleports to the top of the wall instead of hitting it.
    const lead = f.facing > 0 ? 0 : (f.lead ?? 1.4);
    if (z < f.z0 - lead || z > f.z1) return 0;
    if (z < f.z0) return f.height * smoothstep(f.z0 - lead, f.z0, z) * lateral;
    const t = (z - f.z0) / (f.z1 - f.z0);
    const shaped = f.facing > 0 ? smoothstep(0, 1, t) : smoothstep(0, 1, 1 - t);
    return f.height * shaped * lateral;
  }

  if (f.type === 'kicker') {
    if (z < f.z0 || z > f.z1) return 0;
    const t = (z - f.z0) / (f.z1 - f.z0);
    // t^curve: shallow entry, steep lip. Reads and rides like a kicker.
    return f.height * Math.pow(t, f.curve) * lateral;
  }

  if (f.type === 'plateau') {
    if (z < f.z0 || z > f.z3) return 0;
    let t;
    if (z < f.z1) t = smoothstep(f.z0, f.z1, z);
    else if (z < f.z2) t = 1;
    else t = 1 - smoothstep(f.z2, f.z3, z); // the drop-off
    return f.height * t * lateral;
  }

  if (f.type === 'roller') {
    if (z < f.z0 || z > f.z1) return 0;
    const t = (z - f.z0) / (f.z1 - f.z0);
    return f.height * Math.sin(t * Math.PI) * lateral;
  }

  return 0;
}

/** 1 in the middle of a feature, easing to 0 at its edges. */
function lateralFalloff(x, halfWidth) {
  const a = Math.abs(x);
  if (a >= halfWidth) return 0;
  return 1 - smoothstep(halfWidth * 0.72, halfWidth, a);
}

/** Surface normal by central difference. Cheap and always consistent with the height. */
export function groundNormal(x, z, out = new Vector3()) {
  const e = 0.12;
  const dx = (groundHeight(x + e, z) - groundHeight(x - e, z)) / (2 * e);
  const dz = (groundHeight(x, z + e) - groundHeight(x, z - e)) / (2 * e);
  return out.set(-dx, 1, -dz).normalize();
}

/** Slope of the surface along +Z at a point. Positive means uphill. */
export function groundSlopeZ(x, z) {
  const e = 0.12;
  return (groundHeight(x, z + e) - groundHeight(x, z - e)) / (2 * e);
}

/**
 * True when a BUILT feature drops away sharply ahead: a lip. Used to launch the
 * rider even without a pop, and to tell the camera a trick is coming.
 *
 * Deliberately measured against the features alone, not the ground. You launch
 * off the end of a ledge or the lip of a kicker — structure someone built — not
 * off a hillside. Keyed off absolute height instead, any terrain steeper than a
 * 0.2 grade reads as one continuous lip and the rider is permanently airborne,
 * which put a hard ceiling on how steep a hill could be and made bowls
 * impossible. This is what lets a layout have real terrain.
 */
export function isLip(x, z, lookahead = 1.4) {
  const here = featureHeightAt(x, z);
  const ahead = featureHeightAt(x, z + lookahead);
  return here - ahead > 0.28;
}

/** Distance in metres to the next launch lip ahead, or Infinity. */
export function distanceToLip(x, z, maxLook = 26) {
  for (let d = 0.5; d < maxLook; d += 0.5) {
    if (isLip(x, z + d)) return d;
  }
  return Infinity;
}

export function getFeatures() {
  return active.features;
}

export function runLength() {
  return active.runLength;
}

export function sampleGround(x, z) {
  return {
    height: groundHeight(x, z),
    normal: groundNormal(x, z, _n.clone()),
  };
}

function smoothstep(a, b, x) {
  if (b <= a) return x >= b ? 1 : 0;
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}
