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
  }

  reset(skater) {
    this.trickBlend = 0;
    this.orbit = Config.camera.trickOrbitStart;
    this.shake = 0;
    this.setStanceYaw(skater.yaw);
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
  }

  chaseTarget(skater, outPos, outLook) {
    const C = Config.camera;
    const back = _tmp.set(-Math.sin(skater.yaw), 0, -Math.cos(skater.yaw));
    outPos
      .copy(skater.position)
      .addScaledVector(back, C.followDistance)
      .add(_tmp2.set(0, C.followHeight, 0));
    // Never let the chase camera dip into a ramp.
    const floor = groundHeight(outPos.x, outPos.z) + 0.85;
    if (outPos.y < floor) outPos.y = floor;
    // Aim low and not too far ahead: it keeps the board in frame under the
    // rider's feet, which is the thing the player is about to be flipping.
    outLook.copy(skater.position).add(_tmp2.set(0, 0.72, 0));
    outLook.addScaledVector(_tmp.set(Math.sin(skater.yaw), 0, Math.cos(skater.yaw)), 2.2);
  }

  /**
   * @param {Board} board
   * @param {number} flightT 0..1 through the flight
   */
  trickTarget(board, flightT, outPos, outLook) {
    const C = Config.camera;

    // Orbit around the stance frame, not the board: the shot must not spin with
    // the trick or the player loses all sense of which way is which.
    const azimuth = this.stanceYaw + (C.trickAzimuthTurns + this.orbit) * Math.PI * 2;
    const elevation = MathUtils.degToRad(C.trickElevationDeg);

    // Rise and retreat through the flight so the ground enters frame in time.
    const fall = smoothstep(0.4, 1.0, flightT);
    const dist = C.trickDistance + fall * C.landingPullback;

    const horizontal = Math.cos(elevation) * dist;
    const vertical = Math.sin(elevation) * dist + fall * C.landingRise;

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
