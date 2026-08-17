import { Vector3, Quaternion } from 'three';
import Config from '../core/Config.js';

/**
 * FingerFlipController — the core mechanic.
 *
 * The model is fingerboard physics, because that is what the player is actually
 * doing: two fingers on a deck. A finger that is in contact is pressing DOWN in
 * the stance frame (the non-rotating frame that follows the board's position).
 * Everything falls out of one cross product:
 *
 *     tau = r x F
 *
 * where r is the contact point on the deck, in board-local space, and F is the
 * press plus the lateral scrape.
 *
 *   - Press at the tail  (r.z < 0)  ->  pitch: the pop.
 *   - Press on the toe edge (r.x > 0) -> negative roll: a kickflip.
 *   - Press on the heel edge (r.x < 0) -> positive roll: a heelflip.
 *   - Scrape sideways across the tail -> yaw: a shuvit.
 *   - Do two at once -> a 360 flip. Nothing about that is special-cased.
 *
 * A finger only grips while it is over the deck AND the deck is near it. Slide
 * the finger off the edge and contact breaks at maximum offset, which is
 * precisely the flick. Press a finger back onto the spinning deck and the catch
 * damping kills the rotation: that is how you stop a flip where you want it.
 *
 * Impulses are computed against REAL elapsed time, not world time, so input
 * stays responsive while the world crawls.
 */

const _q = new Quaternion();
const _pl = new Vector3();
const _r = new Vector3();
const _f = new Vector3();
const _tau = new Vector3();
const _tmp = new Vector3();
const _inv = new Quaternion();

// A finger is re-solved every time it travels this far, so no flick can skip
// over the deck between frames.
const SUBSTEP_TRAVEL = 0.025; // metres
const MAX_SUBSTEPS = 10;

export class Finger {
  constructor(label) {
    this.label = label; // 'left' | 'right'
    this.pointerId = null;
    this.active = false;
    this.wasActive = false;

    /** Position in the stance frame, metres. y is always 0: the hand plane. */
    this.pos = new Vector3();
    /** Where it was last frame, so a fast frame can be swept rather than jumped. */
    this.prevPos = new Vector3();
    /** The point actually solved against this substep. */
    this.samplePos = new Vector3();
    /** Velocity in the stance frame, metres per REAL second. */
    this.vel = new Vector3();

    /** 0..1 how firmly this finger is on the deck right now. */
    this.contact = 0;
    /** Contact point in board-local space, for drawing the fingertip marker. */
    this.localContact = new Vector3();
    /** Signed distance from the deck plane; used by the HUD depth cue. */
    this.planeDistance = 0;

    // Bookkeeping the scoring system reads.
    this.flicks = 0;
    this.contactTime = 0;
    this.lastReleaseSpeed = 0;
  }

  reset() {
    this.pointerId = null;
    this.active = false;
    this.wasActive = false;
    this.pos.set(0, 0, 0);
    this.prevPos.set(0, 0, 0);
    this.samplePos.set(0, 0, 0);
    this.vel.set(0, 0, 0);
    this.contact = 0;
    this.planeDistance = 0;
    this.flicks = 0;
    this.contactTime = 0;
    this.lastReleaseSpeed = 0;
  }
}

export default class FingerFlipController {
  constructor() {
    this.left = new Finger('left');
    this.right = new Finger('right');
    this.fingers = [this.left, this.right];

    // Aggregated trick telemetry, consumed by ScoreSystem.
    this.totalFlicks = 0;
    this.caught = false;
    this.catchStrength = 0;
    this.lastCatchAtNormalisedTime = -1;
    this.peakSpin = 0;
    this._carrierVel = null;

    this.halfLength = Config.board.length * 0.5;
    this.halfWidth = Config.board.width * 0.5;
    // How far the deck can be from the fingertip and still be in contact. This is
    // the reach of the mechanic: a board rolled past about 35 degrees has moved
    // out from under a finger placed near the bolts, which is why you catch a
    // flip as it comes back around flat rather than whenever you like.
    this.contactThickness = 0.13;
  }

  reset() {
    this.left.reset();
    this.right.reset();
    this.totalFlicks = 0;
    this.caught = false;
    this.catchStrength = 0;
    this.lastCatchAtNormalisedTime = -1;
    this.peakSpin = 0;
  }

  /**
   * @param {Board} board
   * @param {Quaternion} stanceQuat world rotation of the stance frame
   * @param {number} realDelta seconds of wall-clock time since the last frame
   * @param {number} flightT normalised progress through the air, 0..1
   * @param {Vector3|null} carrierVel the rider's velocity, if there is a rider.
   *        A planted finger holds the board WITH you, so the catch bleeds the
   *        board's drift relative to the RIDER rather than relative to the
   *        world. Damping toward world zero instead brakes the deck against
   *        ground you are both flying over at cruise, so it slides out from
   *        under you the whole time you hold a catch — and worse the faster the
   *        game gets, which is how it finally showed up.
   */
  update(board, stanceQuat, realDelta, flightT = 0, carrierVel = null) {
    if (realDelta <= 0) return;
    // Read by solveFinger, which is where the catch damping lives.
    this._carrierVel = carrierVel;

    const spinMag = board.angularVelocity.length();
    if (spinMag > this.peakSpin) this.peakSpin = spinMag;

    // A fast flick can cross the whole deck inside one frame, and on a slow
    // frame it certainly will. Solving once per frame would let the finger jump
    // clean over the contact window, so the sweep is substepped: the mechanic
    // then behaves the same at 30fps as at 144.
    // prevPos is owned by FingerMapper: it is where the fingertip was before
    // this frame's motion, which for a touch is the last sample and for a key
    // is the position before this frame's step.
    let maxTravel = 0;
    for (const f of this.fingers) {
      if (f.active) maxTravel = Math.max(maxTravel, f.pos.distanceTo(f.prevPos));
    }
    const n = Math.min(MAX_SUBSTEPS, Math.max(1, Math.ceil(maxTravel / SUBSTEP_TRAVEL)));
    const dt = realDelta / n;

    for (let i = 0; i < n; i++) {
      const t = (i + 1) / n;
      // Board rotation expressed in the stance frame, refreshed per substep
      // because the catch damping changes it as we go.
      _q.copy(stanceQuat).invert().multiply(board.quaternion);
      _inv.copy(_q).invert();

      for (const finger of this.fingers) {
        finger.samplePos.lerpVectors(finger.prevPos, finger.pos, t);
        this.solveFinger(finger, board, stanceQuat, _q, _inv, dt, flightT, i === 0);
      }
    }

    for (const f of this.fingers) f.prevPos.copy(f.pos);
  }

  solveFinger(finger, board, stanceQuat, relQuat, invRel, dt, flightT, firstSubstep) {
    const released = firstSubstep && finger.wasActive && !finger.active;
    if (released) {
      finger.lastReleaseSpeed = finger.vel.length();
      if (finger.contact > 0.25) {
        finger.flicks++;
        this.totalFlicks++;
      }
    }
    const wasActive = finger.wasActive;
    if (firstSubstep) finger.wasActive = finger.active;

    if (!finger.active) {
      finger.contact *= Math.max(0, 1 - 12 * dt);
      return;
    }

    // Where the fingertip sits in the deck's own frame.
    _pl.copy(finger.samplePos).applyQuaternion(invRel);
    finger.planeDistance = _pl.y;

    const overDeck = this.footprint(_pl.x, _pl.z);
    const nearPlane = this.slab(_pl.y);
    const wasInContact = finger.contact;
    const target = overDeck * nearPlane;

    if (!wasActive && firstSubstep) {
      // The finger arrives already touching. Ramping in here would eat most of
      // the flick window, which at 60fps is only a handful of frames long.
      finger.contact = target;
    } else {
      // Contact breaks faster than it builds: the break is the flick.
      const rate = target > finger.contact ? 60 : 42;
      finger.contact += (target - finger.contact) * Math.min(1, rate * dt);
    }
    if (finger.contact < 1e-3) finger.contact = 0;

    // Losing contact while moving is a flick off the edge.
    if (wasInContact > 0.4 && finger.contact <= 0.15) {
      finger.flicks++;
      this.totalFlicks++;
    }

    if (finger.contact <= 0.001) return;

    // Contact point on the deck surface, clamped to the physical deck so a
    // finger hanging over the edge still torques from the edge itself.
    _r.set(
      clamp(_pl.x, -this.halfWidth, this.halfWidth),
      0,
      clamp(_pl.z, -this.halfLength, this.halfLength),
    );
    finger.localContact.copy(_r);

    const speed = finger.vel.length();
    const c = finger.contact;

    // --- Press: straight down in the stance frame, rotated into deck space ---
    const press = (BASE_PRESS + PRESS_PER_SPEED * speed) * c;
    _f.set(0, -press, 0).applyQuaternion(invRel);

    // --- Scrape: the finger's lateral motion, dragged along the deck ---
    // Coulomb-limited: friction can never exceed mu times the normal force, so
    // a light, fast swipe cannot shove the board harder than a firm press.
    // Grip also dies off toward the rail, because a finger sliding over the
    // edge is rolling off it rather than pushing along it. That is what keeps a
    // rail flick a clean flip while a scoop across the middle still shoves.
    const rail = 1 - smoothstep(this.halfWidth * 0.55, this.halfWidth, Math.abs(_r.x));
    _tmp.copy(finger.vel).applyQuaternion(invRel).multiplyScalar(SCRAPE_GAIN * c * rail);
    clampVector(_tmp, FRICTION_MU * press);
    _f.add(_tmp);

    // tau = r x F, straight into the body frame.
    _tau.copy(_r).cross(_f);

    // A fast finger skims; a slow one levers. A deliberate press on the tail
    // pitches the board end-over-end (the pop, the impossible), while a quick
    // flick past the same point barely does — which is exactly how a deck
    // behaves, and what stops every flip from turning into a nosedive.
    _tau.x *= 1 / (1 + speed * PITCH_SKIM);

    _tau.multiplyScalar(Config.fingers.forceScale * dt);
    clampVector(_tau, Config.fingers.maxImpulsePerFrame * dt);
    board.applyAngularImpulse(_tau);

    // A fraction of the press shoves the board bodily. Enough that a two-finger
    // stomp pushes it down, not enough that fingers can fly it around.
    _tmp.copy(_f).applyQuaternion(relQuat).applyQuaternion(stanceQuat);
    _tmp.multiplyScalar(Config.fingers.linearInfluence * Config.fingers.forceScale * dt);
    board.applyImpulse(_tmp);

    // --- Catch: a resting finger bleeds off spin ---
    // Scaled by how still the finger is, so a scraping finger keeps the board
    // spinning while a planted one stops it dead.
    const stillness = 1 / (1 + speed * 4.5);
    const damp = Config.fingers.catchDamping * c * stillness * dt;
    if (damp > 0) {
      const k = Math.max(0, 1 - damp);
      const before = board.angularVelocity.length();
      board.angularVelocity.multiplyScalar(k);
      const bled = before - board.angularVelocity.length();
      if (bled > 0.4) {
        this.caught = true;
        this.catchStrength = Math.max(this.catchStrength, Math.min(1, bled / 3));
        this.lastCatchAtNormalisedTime = flightT;
      }
      const lin = Math.max(
        0,
        1 - Config.fingers.catchLinearDamping * c * stillness * dt,
      );
      // Toward the carrier, not toward zero. With no carrier the two are the
      // same thing, so a bare board still settles the way it always did.
      const carrier = this._carrierVel;
      const cx = carrier ? carrier.x : 0;
      const cz = carrier ? carrier.z : 0;
      board.velocity.x = cx + (board.velocity.x - cx) * lin;
      board.velocity.z = cz + (board.velocity.z - cz) * lin;
    }

    finger.contactTime += dt;
  }

  /** Soft-edged rectangle test over the deck footprint. Returns 0..1. */
  footprint(x, z) {
    const m = Config.fingers.gripMargin;
    const fx = 1 - smoothstep(this.halfWidth - EDGE_SOFT, this.halfWidth + m, Math.abs(x));
    const fz = 1 - smoothstep(this.halfLength - EDGE_SOFT, this.halfLength + m, Math.abs(z));
    return fx * fz;
  }

  /** How close the deck plane is to the fingertip. Returns 0..1. */
  slab(d) {
    return 1 - smoothstep(this.contactThickness * 0.45, this.contactThickness, Math.abs(d));
  }
}

const BASE_PRESS = 1.35;
const PRESS_PER_SPEED = 1.65;
const SCRAPE_GAIN = 1.0;
// How strongly a fast finger loses its end-over-end leverage.
const PITCH_SKIM = 1.35;
// Friction cannot exceed mu * normal force, so a light touch cannot shove hard.
const FRICTION_MU = 0.62;
const EDGE_SOFT = 0.012;

function clamp(v, a, b) {
  return v < a ? a : v > b ? b : v;
}

function smoothstep(a, b, x) {
  if (b <= a) return x >= b ? 1 : 0;
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
}

function clampVector(v, max) {
  const l = v.length();
  if (l > max && l > 0) v.multiplyScalar(max / l);
  return v;
}
