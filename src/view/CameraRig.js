import { Vector3, MathUtils, Quaternion } from 'three';
import Config from '../core/Config.js';
import { groundHeight } from '../sim/Park.js';

/**
 * CameraController.
 *
 * Two framings, cross-faded in REAL time so the move stays cinematic while the
 * world is crawling:
 *
 *   FOLLOW — a chase camera behind and above the rider.
 *   TRICK  — a close orbit on the board, looking slightly down at it.
 *
 * The trick shot is the one that has to earn its keep. Gameplay readability
 * comes first, so it obeys three rules:
 *   1. It looks DOWN at the board, because the flip axis has to be visible.
 *   2. It keeps the board's long axis roughly across the screen, so the nose
 *      and tail sit on opposite sides and each hand has an obvious target.
 *   3. It pulls back and tilts up as the board falls, so the landing surface
 *      comes into frame before the player has to commit.
 */

const _pos = new Vector3();
const _look = new Vector3();
const _tmp = new Vector3();
const _tmp2 = new Vector3();
const _q = new Quaternion();
const _view = new Vector3();
const _right = new Vector3();
const _up = new Vector3();
const _long = new Vector3();
const _short = new Vector3();
const _drift = new Vector3();
const _side = new Vector3();

export default class CameraRig {
  constructor(camera) {
    this.camera = camera;
    this.position = new Vector3(0, 3, -6);
    this.lookAt = new Vector3();
    this.fov = Config.camera.fov;

    /** 0 = chase, 1 = trick close-up. Driven by the game state machine. */
    this.trickBlend = 0;
    this.orbit = Config.camera.trickOrbitStart;
    this.shake = 0;
    this._shakeSeed = Math.random() * 100;

    /**
     * The stance frame the trick camera and the finger mapping share: yaw-only,
     * captured at takeoff so it never spins with the board.
     */
    this.stanceQuat = new Quaternion();
    this.stanceYaw = 0;

    // Set by fitToViewport(): which way round the trick shot frames the deck,
    // and how far back it sits so the flick window is a usable number of pixels.
    this.trickAzimuthOffset = 0;
    this.fittedDistance = Config.camera.trickMinDistance;

    // Board position last frame, so the trick camera can travel with it.
    this._lastBoardPos = new Vector3();
    this._hadBoard = false;
  }

  reset(skater) {
    this.trickBlend = 0;
    this.orbit = Config.camera.trickOrbitStart;
    this.shake = 0;
    this.setStanceYaw(skater.yaw);
    this.fitToViewport();
    this._hadBoard = false;
    this.chaseTarget(skater, _pos, _look);
    this.position.copy(_pos);
    this.lookAt.copy(_look);
    this.fov = Config.camera.fov;
    this.apply();
  }

  setStanceYaw(yaw) {
    this.stanceYaw = yaw;
    this.stanceQuat.setFromAxisAngle(UP, yaw);
  }

  /** Start of a trick: lock the orbit to a known, readable starting angle. */
  beginTrick(skater) {
    this.setStanceYaw(skater.yaw);
    this.orbit = Config.camera.trickOrbitStart;
    this.fitToViewport();
  }

  /**
   * Choose the trick shot's orientation and distance from the viewport shape.
   *
   * The deck is long and thin, and the distance a finger must travel to flick
   * off a rail is measured in real screen pixels — so a framing that works on a
   * desktop leaves a landscape phone with a 47px flick window, which is not a
   * control, it is a dare.
   *
   * Both candidate framings (deck across the screen, deck up the screen) are
   * costed and the one needing the least distance wins, which picks landscape
   * framing on wide viewports and portrait framing on tall ones with no aspect
   * thresholds anywhere.
   */
  fitToViewport() {
    const C = Config.camera;
    const aspect = this.camera.aspect || 1;
    const halfAngle = Math.tan(MathUtils.degToRad(C.trickFov) * 0.5);
    const elevation = MathUtils.degToRad(C.trickElevationDeg);

    let bestOffset = 0;
    let bestDistance = Infinity;
    let bestShortFloor = Infinity;

    for (const offset of [0, 0.25]) {
      const azimuth = this.stanceYaw + (C.trickAzimuthTurns + offset) * Math.PI * 2;

      // View direction is fixed by azimuth and elevation, independent of range.
      _view.set(-Math.sin(azimuth) * Math.cos(elevation), -Math.sin(elevation), -Math.cos(azimuth) * Math.cos(elevation)).normalize();
      _right.crossVectors(_view, UP).normalize();
      _up.crossVectors(_right, _view).normalize();

      // The deck's two axes in world space, at this stance.
      _long.set(0, 0, Config.board.length).applyQuaternion(this.stanceQuat);
      _short.set(Config.board.width, 0, 0).applyQuaternion(this.stanceQuat);

      // Range at which an axis fills `fraction` of whichever screen axis it
      // maps onto. The larger of the two requirements is the binding one.
      const need = (v, fraction) =>
        Math.max(
          Math.abs(v.dot(_up)) / (2 * fraction * halfAngle),
          Math.abs(v.dot(_right)) / (2 * fraction * halfAngle * aspect),
        );

      // Pick the orientation on the long-axis fit ALONE. Folding the
      // short-axis floor in here would make both candidates land on the same
      // clamped number and the orientation signal would vanish.
      const longFit = need(_long, C.trickFitLongAxis);
      if (longFit < bestDistance) {
        bestDistance = longFit;
        bestOffset = offset;
        bestShortFloor = need(_short, C.trickFitShortAxis);
      }
    }

    // Then apply the flick-window floor to the winner: never further back than
    // the range at which the deck's width stops being a usable gesture. On an
    // extreme viewport the two constraints fight, and keeping the flick usable
    // wins — the nose and tail are allowed to run off the edges.
    this.trickAzimuthOffset = bestOffset;
    this.fittedDistance = MathUtils.clamp(
      Math.min(bestDistance, bestShortFloor),
      C.trickMinDistance,
      C.trickMaxDistance,
    );
  }

  chaseTarget(skater, outPos, outLook) {
    const C = Config.camera;
    const back = _tmp.set(-Math.sin(skater.yaw), 0, -Math.cos(skater.yaw));
    // Held slightly off the centreline. A skater stands across the board, so a
    // camera directly behind sees nothing but their own profile with one leg
    // hiding the other — a few degrees to the side opens the stance up and
    // shows the board under their feet.
    const side = _side.set(Math.cos(skater.yaw), 0, -Math.sin(skater.yaw));
    outPos
      .copy(skater.position)
      .addScaledVector(back, C.followDistance)
      .addScaledVector(side, C.followOffset)
      .add(_tmp2.set(0, C.followHeight, 0));
    // Never let the chase camera dip into a ramp.
    const floor = groundHeight(outPos.x, outPos.z) + 0.95;
    if (outPos.y < floor) outPos.y = floor;
    // Aim low and not too far ahead: it keeps the board in frame under the
    // rider's feet, which is the thing the player is about to be flipping.
    outLook.copy(skater.position).add(_tmp2.set(0, 0.95, 0));
    outLook.addScaledVector(_tmp.set(Math.sin(skater.yaw), 0, Math.cos(skater.yaw)), 1.9);
  }

  /**
   * @param {Board} board
   * @param {number} flightT 0..1 through the flight
   */
  trickTarget(board, flightT, outPos, outLook) {
    const C = Config.camera;

    // Orbit around the stance frame, not the board: the shot must not spin with
    // the trick or the player loses all sense of which way is which.
    const azimuth =
      this.stanceYaw +
      (C.trickAzimuthTurns + this.trickAzimuthOffset + this.orbit) * Math.PI * 2;
    const elevation = MathUtils.degToRad(C.trickElevationDeg);

    // Rise and retreat through the flight so the ground enters frame in time.
    const fall = smoothstep(0.4, 1.0, flightT);
    const dist = this.fittedDistance * (1 + fall * C.landingPullback);

    const horizontal = Math.cos(elevation) * dist;
    const vertical = Math.sin(elevation) * dist + fall * C.landingRise * this.fittedDistance;

    outPos.set(
      board.position.x + Math.sin(azimuth) * horizontal,
      board.position.y + vertical,
      board.position.z + Math.cos(azimuth) * horizontal,
    );

    const floor = groundHeight(outPos.x, outPos.z) + 0.34;
    if (outPos.y < floor) outPos.y = floor;

    // Look slightly below the board late in the flight so the landing surface
    // sits in the lower third of the screen rather than off the bottom.
    outLook.copy(board.position);
    outLook.y -= fall * 0.45;
  }

  /**
   * @param {number} realDelta wall-clock seconds
   */
  update(realDelta, { skater, board, flightT }) {
    const C = Config.camera;

    // Ride along with the board before smoothing. The board is still travelling
    // at speed during the trick, and lerping toward a moving target leaves it
    // trailing off-centre — which on a phone means the deck drifts out of frame
    // exactly when the player is trying to work it. Carrying the board's own
    // movement across first leaves the lerp only the framing error to close.
    if (this._hadBoard) {
      _drift.subVectors(board.position, this._lastBoardPos);
      this.position.addScaledVector(_drift, this.trickBlend);
      this.lookAt.addScaledVector(_drift, this.trickBlend);
    }
    this._lastBoardPos.copy(board.position);
    this._hadBoard = true;

    this.chaseTarget(skater, _pos, _look);
    let targetFov = C.fov;

    if (this.trickBlend > 0.001) {
      this.orbit += C.trickOrbitRate * realDelta;
      this.trickTarget(board, flightT, _tmp, _tmp2);
      const b = smoothstep(0, 1, this.trickBlend);
      _pos.lerp(_tmp, b);
      _look.lerp(_tmp2, b);
      targetFov = MathUtils.lerp(C.fov, C.trickFov, b);
    }

    // Exponential smoothing, frame-rate independent.
    const k = 1 - Math.exp(-C.followLag * realDelta);
    const kt = 1 - Math.exp(-C.trickLerp * realDelta);
    const rate = Math.max(k, this.trickBlend > 0.001 ? kt : 0);
    this.position.lerp(_pos, rate);
    this.lookAt.lerp(_look, rate);
    this.fov = MathUtils.lerp(this.fov, targetFov, rate);

    if (this.shake > 0.0005) {
      this.shake *= Math.exp(-6 * realDelta);
      const t = performance.now() * 0.001 + this._shakeSeed;
      const a = this.shake * 0.12;
      this.position.x += Math.sin(t * 47.3) * a;
      this.position.y += Math.sin(t * 39.1 + 1.7) * a;
      this.position.z += Math.sin(t * 53.7 + 3.1) * a;
    }

    this.apply();
  }

  apply() {
    this.camera.position.copy(this.position);
    this.camera.lookAt(this.lookAt);
    if (Math.abs(this.camera.fov - this.fov) > 0.01) {
      this.camera.fov = this.fov;
      this.camera.updateProjectionMatrix();
    }
  }

  addShake(amount) {
    this.shake = Math.min(1.2, this.shake + amount);
  }
}

const UP = new Vector3(0, 1, 0);

function smoothstep(a, b, x) {
  if (b <= a) return x >= b ? 1 : 0;
  const t = MathUtils.clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
}
