import { Vector3, Vector2, Quaternion } from 'three';
import Config from '../core/Config.js';

/**
 * Turns raw pointers and keys into the two fingers the simulation understands.
 *
 * A fingertip lives on the "hand plane": the horizontal plane through the
 * board's centre, in the stance frame (yaw-locked at takeoff, so it never spins
 * with the trick). A touch is turned into a point on that plane by casting the
 * screen position back through the camera and intersecting the plane, which
 * means dragging along the board on screen really does drag along the board in
 * the world, at any camera angle, with no per-camera special cases.
 *
 * This used to project the two stance axes into screen space and invert the
 * 2x2. That is a linearisation of a perspective projection about the board's
 * centre, and it drifts the further out you go: measured at the trick camera's
 * own 41 degrees, a fingertip at the rail came back up to 14mm across and 30mm
 * along from where it really was. 14mm is a quarter of `fingers.edgeBias`, the
 * offset at which a flick starts producing roll — enough to put a little
 * unwanted flip on a scoop that was dead down the centreline. The intersection
 * below is exact instead, for the same handful of operations.
 *
 * Both fingers are identical: whichever end of the deck you touch is the end
 * you have hold of. There is no left-hand-only or right-hand-only move.
 */

// Where the keyboard fingers rest: over the truck bolts, which is where a
// skater's feet actually sit and where the pitch arm is short enough that a
// rail flick reads as a flip rather than an end-over-end.
const HOME_ALONG = 0.22;
/**
 * How close to parallel a ray may get before the plane it is aimed at stops
 * being a surface and starts being a line. Looking along the hand plane, every
 * screen position maps to somewhere near infinity, so those are refused.
 */
const MIN_RAY_Y = 1e-4;

const _origin = new Vector3();
const _dir = new Vector3();
const _hit = new Vector3();

export default class FingerMapper {
  constructor(input, fingerController) {
    this.input = input;
    this.fingers = fingerController;
    this.stanceQuat = new Quaternion();
    this.invStance = new Quaternion();
    this.camera = null;
    this.boardPos = new Vector3();
    this.planeY = 0;
    this.aspect = 1;

    // Whether the camera can say anything useful about the hand plane at all.
    this.basis = { ok: false };

    // Keyboard fingers keep their own positions between frames.
    this.keyFinger = [
      { along: -HOME_ALONG, across: 0, speed: 0, home: -HOME_ALONG, keys: KEYS_LEFT },
      { along: HOME_ALONG, across: 0, speed: 0, home: HOME_ALONG, keys: KEYS_RIGHT },
    ];
    this.usingKeyboard = false;
  }

  reset() {
    this.keyFinger[0].along = -HOME_ALONG;
    this.keyFinger[0].across = 0;
    this.keyFinger[1].along = HOME_ALONG;
    this.keyFinger[1].across = 0;
    for (const f of this.fingers.fingers) {
      f.pointerId = null;
      f.active = false;
      f.pos.set(0, 0, 0);
      f.vel.set(0, 0, 0);
    }
  }

  /**
   * Point the mapping at the camera and the board it is working on.
   *
   * The hand plane is horizontal, so its normal is world up whatever the
   * stance is doing — the stance quaternion is yaw-only and orients the axes
   * WITHIN the plane, not the plane itself.
   *
   * @param {PerspectiveCamera} camera
   * @param {Vector3} boardPos
   * @param {Quaternion} stanceQuat
   */
  updateBasis(camera, boardPos, stanceQuat) {
    this.stanceQuat.copy(stanceQuat);
    this.invStance.copy(stanceQuat).invert();
    this.camera = camera;
    this.planeY = boardPos.y;
    this.boardPos.copy(boardPos);
    this.aspect = camera.aspect || 1;
    // A camera sitting exactly in the plane sees it edge-on and can say
    // nothing about where along it a touch landed.
    this.basis.ok = Math.abs(camera.position.y - boardPos.y) > MIN_RAY_Y;
  }

  /**
   * Screen NDC (aspect-corrected) to hand-plane metres.
   *
   * @returns {Vector2} x = across the deck, y = along it. (0, 0) when the
   *          screen position does not meet the plane in front of the camera,
   *          which is the board's own centre and the only safe thing to say.
   */
  screenToPlane(sx, sy, out) {
    if (!this.basis.ok || !this.camera) {
      out.set(0, 0);
      return out;
    }
    // Back to raw NDC: the caller works in aspect-corrected space so that a
    // screen distance means the same thing on both axes.
    const ndcX = sx / (this.aspect || 1);

    _origin.setFromMatrixPosition(this.camera.matrixWorld);
    _dir.set(ndcX, sy, 0.5).unproject(this.camera).sub(_origin);

    if (Math.abs(_dir.y) < MIN_RAY_Y) {
      out.set(0, 0);
      return out;
    }
    const t = (this.planeY - _origin.y) / _dir.y;
    if (t <= 0) {
      // The plane is behind the camera; there is nothing to touch.
      out.set(0, 0);
      return out;
    }
    _hit.copy(_dir).multiplyScalar(t).add(_origin).sub(this.boardPos).applyQuaternion(this.invStance);
    out.set(_hit.x, _hit.z);
    return out;
  }

  /**
   * Sample input and write the two fingers' stance-frame positions/velocities.
   * @param {number} realDelta
   */
  update(realDelta) {
    const free = [];
    // Release any finger whose pointer has lifted.
    for (const f of this.fingers.fingers) {
      if (f.pointerId !== null) {
        const p = this.input.pointers.get(f.pointerId);
        if (!p || !p.down) {
          f.pointerId = null;
          f.active = false;
        }
      }
      if (f.pointerId === null) free.push(f);
    }

    // Claim new pointers. Either finger can take either end of the board, so
    // there is nothing to assign beyond "first free slot".
    for (const p of this.input.pointers.values()) {
      if (!p.down || p.owner !== null) continue;
      const slot = free.shift();
      if (!slot) break;
      slot.pointerId = p.id;
      p.owner = 'finger';
      this.usingKeyboard = false;
      // Snap the finger to where the player actually touched, without a
      // spurious sweep or velocity spike on the first frame.
      const q = this.screenToPlane(p.x * (this.aspect || 1), p.y, _tmpV2);
      slot.pos.set(q.x, 0, q.y);
      slot.prevPos.copy(slot.pos);
      slot.vel.set(0, 0, 0);
      slot.active = true;
    }

    for (const f of this.fingers.fingers) {
      if (f.pointerId === null) continue;
      const p = this.input.pointers.get(f.pointerId);
      if (!p) continue;
      const q = this.screenToPlane(p.x * (this.aspect || 1), p.y, _tmpV2);
      const prev = _prev.set(f.pos.x, f.pos.z);
      f.pos.set(q.x, 0, q.y);
      if (realDelta > 1e-5) {
        f.vel.set((q.x - prev.x) / realDelta, 0, (q.y - prev.y) / realDelta);
      }
      f.active = true;
    }

    this.updateKeyboard(realDelta);
  }

  updateKeyboard(realDelta) {
    const F = Config.fingers;
    for (let i = 0; i < 2; i++) {
      const finger = this.fingers.fingers[i];
      if (finger.pointerId !== null) continue; // a real pointer owns this slot

      const state = this.keyFinger[i];
      const K = state.keys;
      const inp = this.input;

      let dAcross = 0;
      let dAlong = 0;
      if (inp.anyDown(...K.left)) dAcross -= 1;
      if (inp.anyDown(...K.right)) dAcross += 1;
      if (inp.anyDown(...K.forward)) dAlong += 1;
      if (inp.anyDown(...K.back)) dAlong -= 1;

      const planted = inp.anyDown(...K.plant);
      const moving = dAcross !== 0 || dAlong !== 0;
      if (moving || planted) this.usingKeyboard = true;

      // The fingertip is always somewhere; prevPos is where it was before this
      // frame's step, so the solver can sweep the whole path rather than
      // teleporting over the deck.
      finger.prevPos.set(state.across, 0, state.along);

      let vx = 0;
      let vz = 0;
      if (moving) {
        // Ramp up to full speed rather than snapping, so a tap nudges the deck
        // and a held key delivers a proper flick.
        state.speed += (F.keyboardSpeed - state.speed) * Math.min(1, F.keyboardRamp * realDelta);
        const len = Math.hypot(dAcross, dAlong);
        vx = (dAcross / len) * state.speed;
        vz = (dAlong / len) * state.speed;
        state.across = clamp(state.across + vx * realDelta, -0.62, 0.62);
        state.along = clamp(state.along + vz * realDelta, -0.72, 0.72);
      } else {
        state.speed = 0;
        if (!planted) {
          // Drift back to the home spot on the deck, lifted clear of it, so the
          // next tap is another clean flick rather than a dead key.
          const home = state.home;
          state.across = approach(state.across, 0, F.keyboardReturn * realDelta);
          state.along = approach(state.along, home, F.keyboardReturn * realDelta);
        }
      }

      finger.pos.set(state.across, 0, state.along);
      finger.vel.set(vx, 0, vz);
      finger.active = moving || planted;
    }
  }

  /** Put the keyboard fingers back on the deck at the start of a trick. */
  homeKeyFingers() {
    this.keyFinger[0].along = -HOME_ALONG;
    this.keyFinger[0].across = 0;
    this.keyFinger[0].speed = 0;
    this.keyFinger[1].along = HOME_ALONG;
    this.keyFinger[1].across = 0;
    this.keyFinger[1].speed = 0;
  }
}

const _tmpV2 = new Vector2();
const _prev = new Vector2();

function clamp(v, a, b) {
  return v < a ? a : v > b ? b : v;
}

/** Move `v` toward `target` by at most `step`. */
function approach(v, target, step) {
  const d = target - v;
  if (Math.abs(d) <= step) return target;
  return v + Math.sign(d) * step;
}

const KEYS_LEFT = {
  left: ['KeyA'],
  right: ['KeyD'],
  forward: ['KeyW'],
  back: ['KeyS'],
  plant: ['KeyQ', 'KeyE', 'ShiftLeft'],
};

const KEYS_RIGHT = {
  left: ['ArrowLeft'],
  right: ['ArrowRight'],
  forward: ['ArrowUp'],
  back: ['ArrowDown'],
  plant: ['Slash', 'Period', 'ShiftRight', 'Enter'],
};
