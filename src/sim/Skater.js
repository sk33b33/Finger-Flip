import { Vector3 } from 'three';
import Config from '../core/Config.js';
import { groundHeight, groundNormal, groundSlopeZ, isLip } from './Park.js';

/**
 * PlayerController — the rider.
 *
 * The rider is simulated separately from the board. On the ground they are
 * locked together; in the air the rider flies a clean ballistic arc while the
 * board does whatever the player's fingers make it do. The gap between the two
 * at touchdown is the "drift" the landing detector grades, which is what makes
 * keeping the board under your feet an actual skill.
 */
export default class Skater {
  constructor() {
    this.position = new Vector3(0, 0, 0);
    this.prevPosition = new Vector3();
    this.velocity = new Vector3();
    this.yaw = 0;
    this.speed = 8;
    this.airborne = false;
    this.fakie = false;
    this.crouch = 0; // 0..1, visual + pop charge
    this.popCharge = 0;
    this.airTime = 0;
    this.peakHeight = 0;
    this.takeoffSpeed = 0;
    this.takeoffY = 0;
    this.groundNormal = new Vector3(0, 1, 0);
    this.lean = 0;
    /** Rider rotation carried into the air, rad/s and accumulated turns. */
    this.spinRate = 0;
    this.airYaw = 0;
  }

  reset(z = 4) {
    this.position.set(0, groundHeight(0, z), z);
    this.prevPosition.copy(this.position);
    this.velocity.set(0, 0, 0);
    this.yaw = 0;
    this.speed = 9.5;
    this.airborne = false;
    this.fakie = false;
    this.crouch = 0;
    this.popCharge = 0;
    this.airTime = 0;
    this.peakHeight = 0;
    this.lean = 0;
    this.spinRate = 0;
    this.airYaw = 0;
    this.groundNormal.set(0, 1, 0);
  }

  snapshot() {
    this.prevPosition.copy(this.position);
  }

  heading(out = new Vector3()) {
    return out.set(Math.sin(this.yaw), 0, Math.cos(this.yaw));
  }

  /** Direction the rider is actually travelling, used for landing alignment. */
  travelDir(out = new Vector3()) {
    if (this.airborne && (this.velocity.x || this.velocity.z)) {
      return out.set(this.velocity.x, 0, this.velocity.z).normalize();
    }
    return this.heading(out);
  }

  get speedNormalised() {
    return Math.min(1, this.speed / Config.skater.maxSpeed);
  }

  /**
   * @param {number} dt world seconds
   * @param {{steer:number, push:number, brake:number, charging:boolean}} controls
   */
  step(dt, controls) {
    if (this.airborne) this.stepAir(dt);
    else this.stepGround(dt, controls);
  }

  stepGround(dt, controls) {
    const S = Config.skater;

    // Steering authority falls off with speed so fast approaches stay committed.
    const authority = 1 - S.steerSpeedFalloff * this.speedNormalised;
    this.yaw += controls.steer * S.steerRate * authority * dt;
    this.lean += (controls.steer * authority - this.lean) * Math.min(1, 8 * dt);

    // Gravity along the slope, so ramps cost speed and drops give it back.
    const slope = groundSlopeZ(this.position.x, this.position.z);
    const fwd = this.heading(_h);
    const slopeAccel = Config.sim.gravity * slope * fwd.z;

    const target = controls.push > 0 ? S.maxSpeed : S.maxSpeed * 0.72;
    if (this.speed < target) this.speed += S.accel * (controls.push > 0 ? 1 : 0.45) * dt;
    this.speed -= S.rollFriction * dt;
    this.speed += slopeAccel * dt;
    if (controls.brake > 0) this.speed -= S.brake * controls.brake * dt;
    this.speed = clamp(this.speed, 0.5, S.maxSpeed * 1.25);

    this.position.addScaledVector(fwd, this.speed * dt);
    this.position.x = softClampLane(this.position.x);
    this.position.y = groundHeight(this.position.x, this.position.z);
    groundNormal(this.position.x, this.position.z, this.groundNormal);

    // Crouch tracks the pop charge; it is what sells the ollie.
    const wantCrouch = controls.charging ? 1 : 0;
    this.crouch += (wantCrouch - this.crouch) * Math.min(1, 11 * dt);

    this.velocity.copy(fwd).multiplyScalar(this.speed);
    this.velocity.y = 0;
  }

  stepAir(dt) {
    if (this.spinRate !== 0) {
      this.yaw += this.spinRate * dt;
      this.airYaw += (this.spinRate * dt) / (Math.PI * 2);
    }
    this.velocity.y += Config.sim.gravity * dt;
    const drag = Math.max(0, 1 - Config.sim.airDrag * dt);
    this.velocity.x *= drag;
    this.velocity.z *= drag;
    this.position.addScaledVector(this.velocity, dt);
    this.airTime += dt;
    const above = this.position.y - groundHeight(this.position.x, this.position.z);
    if (above > this.peakHeight) this.peakHeight = above;
    this.crouch += (0.25 - this.crouch) * Math.min(1, 6 * dt);
  }

  /**
   * Leave the ground. A ramp lip adds its own launch even at zero charge.
   * @param {number} charge 0..1 of the pop meter
   * @param {number} steer  the steer input at the instant of the pop, -1..1
   */
  takeOff(charge, steer = 0) {
    const P = Config.pop;
    const up = P.minUp + (P.maxUp - P.minUp) * clamp01(charge);
    const fwd = this.heading(_h);
    const slope = groundSlopeZ(this.position.x, this.position.z);
    // A ramp converts forward speed into vertical speed. The slope term is
    // capped because a transition steepens toward vertical near its lip, and an
    // uncapped slope there multiplies into a launch that leaves the map.
    const rampLift = Math.min(Math.max(0, slope), P.maxLiftSlope) * this.speed * 0.62;

    this.velocity.copy(fwd).multiplyScalar(this.speed + P.forwardBoost * charge);
    this.velocity.y = up + rampLift;
    this.airborne = true;
    this.airTime = 0;
    this.peakHeight = 0;
    this.takeoffSpeed = this.speed;
    this.takeoffY = this.position.y;
    this.popCharge = 0;

    // Only a committed carve becomes a spin, so straight pops stay straight.
    const wind = Math.abs(steer) > P.bodySpinDeadzone ? steer : 0;
    this.spinRate = wind * P.bodySpinRate;
    this.airYaw = 0;

    return { up: this.velocity.y, charge, spin: this.spinRate };
  }

  /** True if the rider has fallen to or below the park surface. */
  checkTouchdown() {
    const h = groundHeight(this.position.x, this.position.z);
    return this.position.y <= h + 1e-3 && this.velocity.y <= 0;
  }

  /** Snap to the surface and resume rolling. `fakie` flips the stance. */
  land(fakie) {
    this.position.y = groundHeight(this.position.x, this.position.z);
    groundNormal(this.position.x, this.position.z, this.groundNormal);
    this.airborne = false;
    this.speed = Math.hypot(this.velocity.x, this.velocity.z);
    // The rider rolls away in the direction they are travelling, not wherever
    // the spin happened to stop, but a half-turn of body spin flips the stance.
    this.yaw = Math.atan2(this.velocity.x, this.velocity.z);
    const halfTurns = Math.round(this.airYaw * 2);
    if (halfTurns % 2 !== 0) this.fakie = !this.fakie;
    if (fakie) this.fakie = !this.fakie;
    this.spinRate = 0;
    this.velocity.y = 0;
  }

  /** Is there a launch lip within reach? Drives the "POP" prompt. */
  nearLip() {
    return isLip(this.position.x, this.position.z + 1.2, 1.6);
  }
}

const _h = new Vector3();

function clamp(v, a, b) {
  return v < a ? a : v > b ? b : v;
}

function clamp01(v) {
  return clamp(v, 0, 1);
}

/** Keep the rider in the lane without a hard wall the camera has to fight. */
function softClampLane(x) {
  const w = Config.park.laneHalfWidth;
  if (x > w) return w + (x - w) * 0.25;
  if (x < -w) return -w + (x + w) * 0.25;
  return x;
}
