import { Vector3 } from 'three';
import Config from '../core/Config.js';

/**
 * The skatepark, defined once as a height function.
 *
 * Collision, the landing surface normal, the camera's ground clearance and the
 * visual mesh are all generated from sampleGround(). There is no second,
 * drifting copy of the level geometry.
 *
 * The layout is periodic over Config.park.runLength with flat ground at the
 * seam, so the run loops forever without a visible join.
 */

const RUN = Config.park.runLength;

/**
 * Features are ordered along +Z. Each is a smooth height ramp so that the
 * derivative (and therefore the surface normal) is continuous: a discontinuous
 * normal makes landings feel arbitrary.
 */
const FEATURES = [
  // A gentle warm-up kicker.
  { type: 'kicker', z0: 34, z1: 40.5, height: 0.95, halfWidth: 5.0, curve: 2.0 },
  // Steeper, taller: the one that gives real hangtime.
  { type: 'kicker', z0: 62, z1: 69, height: 1.5, halfWidth: 5.5, curve: 2.4 },
  // A bank up onto a plateau, then a drop off the far end.
  { type: 'plateau', z0: 92, z1: 99, z2: 111.4, z3: 112.8, height: 1.55, halfWidth: 7.0 },
  // The big one.
  { type: 'kicker', z0: 138, z1: 146.5, height: 2.05, halfWidth: 6.0, curve: 2.6 },
  // A rolling hip: two mirrored quarter shapes.
  { type: 'roller', z0: 172, z1: 184, height: 1.05, halfWidth: 8.0 },
];

const _n = new Vector3();

/** Wrap a world Z into the park's repeating domain. */
export function wrapZ(z) {
  let t = z % RUN;
  if (t < 0) t += RUN;
  return t;
}

/** Height of the park surface under (x, z). */
export function groundHeight(x, z) {
  const t = wrapZ(z);
  let h = 0;
  for (const f of FEATURES) {
    h = Math.max(h, featureHeight(f, x, t));
  }
  return h;
}

function featureHeight(f, x, z) {
  const lateral = lateralFalloff(x, f.halfWidth);
  if (lateral <= 0) return 0;

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
 * True when the surface drops away sharply ahead: a lip. Used to launch the
 * rider even without a pop, and to tell the camera a trick is coming.
 */
export function isLip(x, z, lookahead = 1.4) {
  const here = groundHeight(x, z);
  const ahead = groundHeight(x, z + lookahead);
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
  return FEATURES;
}

export function runLength() {
  return RUN;
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
