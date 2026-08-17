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
 *
 * Heights are bounded by what the rider can actually climb. A rider arriving at
 * cruise can rise at most v^2 / 2g before stalling, so nothing here may exceed
 * that with margin — otherwise the feature is not a ramp, it is a wall you
 * grind to a halt against. There is a test for it.
 */
const FEATURES = [
  // A gentle warm-up kicker.
  { type: 'kicker', z0: 26, z1: 32, height: 0.75, halfWidth: 5.0, curve: 2.0 },

  // A ledge to pop off the end of. Its sides are vertical, which the lip
  // detector already reads as a launch edge.
  { type: 'ledge', z0: 44, z1: 54, height: 0.4, halfWidth: 2.2, blend: 0.5 },

  // Quarterpipe: a true concave transition, the shape the park otherwise
  // lacks entirely. Ride up the curve and it throws you straight upward.
  { type: 'quarter', z0: 66, radius: 2.4, height: 1.1, halfWidth: 6.5 },

  // A bank up onto a plateau, then a drop off the far end.
  { type: 'plateau', z0: 92, z1: 99, z2: 111.4, z3: 112.8, height: 1.05, halfWidth: 7.0 },

  // Bank to bank: two facing banks with a gap of flat between them. Clear the
  // gap or come up short.
  { type: 'bank', z0: 124, z1: 129, height: 1.0, halfWidth: 6.0, facing: 1 },
  { type: 'bank', z0: 135, z1: 140, height: 1.0, halfWidth: 6.0, facing: -1 },

  // The big one.
  { type: 'kicker', z0: 152, z1: 160.5, height: 1.25, halfWidth: 6.0, curve: 2.6 },

  // A hip: two kickers side by side with a saddle between them, so the natural
  // launch is off to one side and the landing is not straight ahead. Rewards a
  // body spin. They share a lip line — staggering them would leave a notch at
  // the seam for a rider crossing the middle.
  { type: 'kicker', z0: 176, z1: 183, height: 1.05, halfWidth: 4.0, curve: 2.2, offsetX: -3.4 },
  { type: 'kicker', z0: 176, z1: 183, height: 1.05, halfWidth: 4.0, curve: 2.2, offsetX: 3.4 },

  // A rolling hump to finish, ridden over rather than off.
  { type: 'roller', z0: 196, z1: 208, height: 0.8, halfWidth: 8.0 },
];

/**
 * The lap's underlying gradient, before any feature sits on top of it: flat off
 * the seam, a clear descent, a level stretch, then a long shallow recovery back
 * to zero.
 *
 * Two things constrain the shape:
 *
 *   - It MUST return to exactly 0 at the seam, or the endless loop steps.
 *   - The descent must stay well under a 0.2 grade. isLip() calls any drop
 *     steeper than that a launch edge, and a downhill above the threshold would
 *     read as one continuous lip with the rider permanently airborne.
 *
 * The recovery is spread over far more distance than the drop, so the climb is
 * barely perceptible while the descent is not.
 */
const TERRAIN = {
  // Starts past the warm-up kicker, so the first feature of the lap is on flat
  // ground and the descent does not quietly flatten its takeoff angle.
  descentStart: 34,
  descentEnd: 85,
  levelEnd: 145,
  drop: 3.0,
  // Descent peaks at an 8.8% grade over 51m; the recovery spreads the same 3m
  // over 75m for 6%. Both are comfortably under the 20% lip threshold, and the
  // asymmetry is what makes the drop read while the climb does not.
};

/**
 * Height of the underlying ground at z, before anything is built on it. Always
 * <= 0, and exactly 0 at the seam.
 *
 * Exported because the visual layer needs the gradient on its own: the far
 * ground beyond the park has to follow the same slope, and it can only do that
 * without cutting through the park if it knows the terrain apart from the
 * features standing on it.
 */
export function terrainHeight(z) {
  const T = TERRAIN;
  const t = wrapZ(z);
  if (t <= T.descentStart) return 0;
  if (t < T.descentEnd) return -T.drop * smoothstep(T.descentStart, T.descentEnd, t);
  if (t < T.levelEnd) return -T.drop;
  // The long haul back up to the seam.
  return -T.drop * (1 - smoothstep(T.levelEnd, RUN, t));
}

const _n = new Vector3();

/** Wrap a world Z into the park's repeating domain. */
export function wrapZ(z) {
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
  for (const f of FEATURES) {
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
