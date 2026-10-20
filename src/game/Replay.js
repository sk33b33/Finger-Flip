/**
 * Instant replay.
 *
 * The slow-motion close-up is the best thing in this game and it lasts about a
 * second. This keeps the last few seconds so it can be watched again, from
 * anywhere.
 *
 * ## Transforms, not inputs
 *
 * The obvious way to build a replay on a deterministic simulation is to record
 * the inputs and run the sim again. This records the ANSWERS instead — where
 * the board and the rider actually were, every rendered frame.
 *
 * That is deliberate. Input replay is only correct while the simulation is
 * bit-for-bit reproducible, and this one is not quite: the bail throw reads the
 * landing, the park can be swapped, the fixed-step accumulator is fed by a
 * real clock. Every one of those is fixable, and every one of them would
 * become a thing that silently breaks replays whenever somebody touches it.
 * Recording transforms cannot drift from what was on screen, because it IS
 * what was on screen.
 *
 * The cost is memory, and it is nothing: six seconds at 60fps is 360 frames of
 * seventeen floats, about 24KB, in one Float32Array allocated once. No objects
 * are created per frame, which matters when the thing being recorded is the
 * frame loop.
 */

import { Quaternion } from 'three';

/** position(3) + quaternion(4), twice, plus three pose values and a timestamp. */
const STRIDE = 3 + 4 + 3 + 4 + 3 + 1;
const T = STRIDE - 1;

export default class Replay {
  /**
   * @param {{seconds?:number, fps?:number}} o how much to keep. Six seconds
   *        covers the longest flight in the game with the roll-in and the
   *        ride-away either side of it.
   */
  constructor({ seconds = 6, fps = 60 } = {}) {
    this.capacity = Math.ceil(seconds * fps);
    this.data = new Float32Array(this.capacity * STRIDE);
    this.count = 0;
    this.head = 0; // next slot to write
    this.markIn = null;
    this.markOut = null;
  }

  reset() {
    this.count = 0;
    this.head = 0;
    this.markIn = null;
    this.markOut = null;
  }

  /**
   * One rendered frame. Written straight into the ring, no allocation.
   *
   * @param {number} t real seconds since the run started
   */
  record(t, boardPos, boardQuat, riderPos, riderQuat, crouch, lean, air) {
    const i = this.head * STRIDE;
    const d = this.data;
    d[i] = boardPos.x;
    d[i + 1] = boardPos.y;
    d[i + 2] = boardPos.z;
    d[i + 3] = boardQuat.x;
    d[i + 4] = boardQuat.y;
    d[i + 5] = boardQuat.z;
    d[i + 6] = boardQuat.w;
    d[i + 7] = riderPos.x;
    d[i + 8] = riderPos.y;
    d[i + 9] = riderPos.z;
    d[i + 10] = riderQuat.x;
    d[i + 11] = riderQuat.y;
    d[i + 12] = riderQuat.z;
    d[i + 13] = riderQuat.w;
    d[i + 14] = crouch;
    d[i + 15] = lean;
    d[i + 16] = air;
    d[i + T] = t;

    this.head = (this.head + 1) % this.capacity;
    if (this.count < this.capacity) this.count++;
  }

  /** Oldest-first index of the n'th stored frame. */
  slotAt(n) {
    const start = this.count < this.capacity ? 0 : this.head;
    return ((start + n) % this.capacity) * STRIDE;
  }

  timeAt(n) {
    return this.data[this.slotAt(n) + T];
  }

  /** Remember where the interesting bit started. */
  mark(t) {
    this.markIn = t;
    this.markOut = null;
  }

  /**
   * Close the clip. A little padding either side: a replay that starts exactly
   * at the pop and stops exactly at the wheels touching cuts off both the
   * wind-up and the roll-away, which are half of what makes it look like
   * skating.
   */
  close(t, { pre = 0.45, post = 0.7 } = {}) {
    if (this.markIn === null) return null;
    this.markOut = t + post;
    this.markIn -= pre;
    return this.clip();
  }

  /**
   * The marked clip as a range of stored frames, or null if there is not
   * enough of one to be worth watching.
   * @returns {{from:number, to:number, duration:number}|null}
   */
  clip() {
    if (this.markIn === null || this.markOut === null || this.count < 4) return null;
    let from = 0;
    let to = this.count - 1;
    while (from < to && this.timeAt(from) < this.markIn) from++;
    while (to > from && this.timeAt(to) > this.markOut) to--;
    // Back off one so a clip whose mark fell between two frames still opens
    // just before the action rather than just after it.
    if (from > 0) from--;
    const duration = this.timeAt(to) - this.timeAt(from);
    if (to - from < 4 || duration < 0.2) return null;
    return { from, to, duration };
  }

  /**
   * Sample the clip at `t` seconds in, writing into the meshes.
   *
   * Interpolated between the two frames either side, so a replay played back
   * slower than it was recorded is smooth rather than a 60fps flipbook — and
   * playing it slower is most of the point.
   *
   * @returns {boolean} false once the clip has run out
   */
  sample(clip, t, board, rider, pose) {
    const startT = this.timeAt(clip.from);
    const want = startT + t;
    if (want >= this.timeAt(clip.to)) {
      this.write(this.slotAt(clip.to), 1, this.slotAt(clip.to), board, rider, pose);
      return false;
    }

    let n = clip.from;
    while (n < clip.to && this.timeAt(n + 1) <= want) n++;

    const a = this.slotAt(n);
    const b = this.slotAt(Math.min(n + 1, clip.to));
    const ta = this.data[a + T];
    const tb = this.data[b + T];
    const span = tb - ta;
    const alpha = span > 1e-6 ? (want - ta) / span : 0;
    this.write(a, alpha, b, board, rider, pose);
    return true;
  }

  /** Blend one stored frame toward another and hand it out. */
  write(a, alpha, b, board, rider, pose) {
    const d = this.data;
    const mix = (i) => d[a + i] + (d[b + i] - d[a + i]) * alpha;

    board.position.set(mix(0), mix(1), mix(2));
    board.quaternion
      .set(d[a + 3], d[a + 4], d[a + 5], d[a + 6])
      .slerp(_tmp.set(d[b + 3], d[b + 4], d[b + 5], d[b + 6]), alpha);

    rider.position.set(mix(7), mix(8), mix(9));
    rider.quaternion
      .set(d[a + 10], d[a + 11], d[a + 12], d[a + 13])
      .slerp(_tmp.set(d[b + 10], d[b + 11], d[b + 12], d[b + 13]), alpha);

    pose.crouch = mix(14);
    pose.lean = mix(15);
    pose.air = mix(16);
  }
}

const _tmp = new Quaternion();
