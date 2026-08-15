import { Vector3, Quaternion } from 'three';
import Config from '../core/Config.js';

const _q = new Quaternion();
const _v = new Vector3();

/**
 * SkateboardController — the board's rigid state and integrator.
 *
 * Angular velocity is stored in the BODY frame. The gyroscopic coupling term
 * (w x Iw) is deliberately omitted: with a deck's very lopsided inertia tensor
 * it produces real but chaotic-looking precession, and the brief asks for a
 * trick system players can learn. Dropping it means a flick around one axis
 * stays around that axis, which is what a skater expects.
 *
 * Local axes: +X toe-side, +Y deck-up, +Z nose.
 */
export default class Board {
  constructor() {
    this.position = new Vector3();
    this.velocity = new Vector3();
    this.quaternion = new Quaternion();
    this.angularVelocity = new Vector3(); // body frame, rad/world-second

    // Render interpolation snapshots.
    this.prevPosition = new Vector3();
    this.prevQuaternion = new Quaternion();

    // Body-rate integrals, in turns. This is what the trick recogniser reads.
    this.spin = new Vector3(); // x = pitch, y = yaw(shuv), z = roll(flip)

    this.airborne = false;
    this.invInertia = new Vector3(
      Config.board.invInertia.x,
      Config.board.invInertia.y,
      Config.board.invInertia.z,
    );
    this.invMass = 1 / Config.board.mass;
  }

  reset(position, yaw) {
    this.position.copy(position);
    this.prevPosition.copy(position);
    this.velocity.set(0, 0, 0);
    this.quaternion.setFromAxisAngle(UP, yaw);
    this.prevQuaternion.copy(this.quaternion);
    this.angularVelocity.set(0, 0, 0);
    this.spin.set(0, 0, 0);
    this.airborne = false;
  }

  snapshot() {
    this.prevPosition.copy(this.position);
    this.prevQuaternion.copy(this.quaternion);
  }

  /** Angular impulse in BODY space, applied instantly (units: rad/s of change). */
  applyAngularImpulse(local) {
    this.angularVelocity.x += local.x * this.invInertia.x;
    this.angularVelocity.y += local.y * this.invInertia.y;
    this.angularVelocity.z += local.z * this.invInertia.z;
  }

  /** Linear impulse in WORLD space (units: N.s). */
  applyImpulse(world) {
    this.velocity.addScaledVector(world, this.invMass);
  }

  /** Local direction to world. */
  localToWorldDir(local, out = new Vector3()) {
    return out.copy(local).applyQuaternion(this.quaternion);
  }

  /** World direction to local. */
  worldToLocalDir(world, out = new Vector3()) {
    _q.copy(this.quaternion).invert();
    return out.copy(world).applyQuaternion(_q);
  }

  up(out = new Vector3()) {
    return this.localToWorldDir(UP, out);
  }

  nose(out = new Vector3()) {
    return this.localToWorldDir(FWD, out);
  }

  right(out = new Vector3()) {
    return this.localToWorldDir(RIGHT, out);
  }

  /** Advance one fixed world-time step. */
  step(dt) {
    if (this.airborne) {
      this.velocity.y += Config.sim.gravity * dt;
      const drag = Math.max(0, 1 - Config.sim.airDrag * dt);
      this.velocity.x *= drag;
      this.velocity.z *= drag;
      const angDrag = Math.max(0, 1 - Config.sim.angularDrag * dt);
      this.angularVelocity.multiplyScalar(angDrag);
    }

    this.position.addScaledVector(this.velocity, dt);
    this.integrateRotation(dt);
  }

  integrateRotation(dt) {
    const w = this.angularVelocity;
    if (w.lengthSq() < 1e-12) return;

    // Track body-rate integrals in turns for trick recognition.
    const TURN = 1 / (Math.PI * 2);
    this.spin.x += w.x * dt * TURN;
    this.spin.y += w.y * dt * TURN;
    this.spin.z += w.z * dt * TURN;

    // Exact exponential map of the body-frame rate keeps big spins stable at any
    // step size, which a first-order q += 0.5*w*q*dt does not.
    const angle = w.length() * dt;
    _v.copy(w).normalize();
    _q.setFromAxisAngle(_v, angle);
    this.quaternion.multiply(_q).normalize();
  }
}

export const UP = Object.freeze(new Vector3(0, 1, 0));
export const FWD = Object.freeze(new Vector3(0, 0, 1));
export const RIGHT = Object.freeze(new Vector3(1, 0, 0));
