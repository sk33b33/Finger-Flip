import Config from './Config.js';

/**
 * GameTimeController.
 *
 * Owns the split between real time and world time. The renderer, camera, input
 * sampling and UI all run on real time so they stay responsive; only the
 * physics simulation consumes world time, which is what slows down during
 * Nail-the-Trick.
 *
 * It also drives the fixed-timestep accumulator and reports an interpolation
 * alpha, so rendering stays smooth no matter the display refresh rate.
 */
/**
 * The world time scale during a trick, as a function of how long the board has
 * left before it reaches the ground.
 *
 * Flat for most of the flight, then easing back toward normal over the last
 * `releaseWithin` world seconds so the landing never crawls.
 *
 * A pure function of one number, deliberately: the property that matters — that
 * the window feels the same off a two-metre launch and off a flat pop — is only
 * checkable if the pacing depends on nothing but seconds-to-the-floor. Buried
 * inside the game loop it could only ever be eyeballed.
 *
 * @param {number} secondsToTouchdown world seconds, from predictTouchdown()
 */
export function nailScale(secondsToTouchdown) {
  const N = Config.nail;
  if (!(secondsToTouchdown < N.releaseWithin)) return N.timeScale;
  const t = Math.min(1, Math.max(0, 1 - secondsToTouchdown / N.releaseWithin));
  // Smoothstep, so the hand-off has no corner in it at either end.
  const eased = t * t * (3 - 2 * t);
  return N.timeScale + (N.releaseTimeScale - N.timeScale) * eased;
}

export default class GameTime {
  constructor() {
    this.timeScale = 1;
    this.targetScale = 1;
    this.rampRate = 1 / Config.nail.enterDuration;

    this.realDelta = 0;
    this.worldDelta = 0;
    this.realElapsed = 0;
    this.worldElapsed = 0;

    this._accumulator = 0;
    this.alpha = 0;
    this.steps = 0;
    this._last = 0;
  }

  /** Ease the world toward a new time scale over `duration` real seconds. */
  requestScale(scale, duration) {
    this.targetScale = scale;
    const d = Math.max(duration, 1e-3);
    this.rampRate = Math.abs(scale - this.timeScale) / d;
  }

  /** Snap immediately, used on resets. */
  setScale(scale) {
    this.timeScale = this.targetScale = scale;
  }

  get isSlow() {
    return this.timeScale < 0.9;
  }

  /**
   * Advance the clock. Returns the number of fixed physics steps to run this
   * frame; each step advances the world by Config.sim.fixedStep world seconds.
   */
  beginFrame(nowMs) {
    const now = nowMs / 1000;
    if (this._last === 0) this._last = now;
    // Clamp so a background tab or a breakpoint cannot fire a burst of steps.
    let dt = Math.min(now - this._last, 0.1);
    this._last = now;

    this.realDelta = dt;
    this.realElapsed += dt;

    if (this.timeScale !== this.targetScale) {
      const step = this.rampRate * dt;
      if (Math.abs(this.targetScale - this.timeScale) <= step) {
        this.timeScale = this.targetScale;
      } else {
        this.timeScale += Math.sign(this.targetScale - this.timeScale) * step;
      }
    }

    this.worldDelta = dt * this.timeScale;
    this.worldElapsed += this.worldDelta;

    this._accumulator += this.worldDelta;
    const fixed = Config.sim.fixedStep;
    let steps = Math.floor(this._accumulator / fixed);
    if (steps > Config.sim.maxStepsPerFrame) {
      steps = Config.sim.maxStepsPerFrame;
      this._accumulator = 0;
    } else {
      this._accumulator -= steps * fixed;
    }
    this.alpha = this._accumulator / fixed;
    this.steps = steps;
    return steps;
  }

  reset() {
    this._accumulator = 0;
    this.worldElapsed = 0;
    this.setScale(1);
  }
}
