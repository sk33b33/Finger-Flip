/**
 * Grabs.
 *
 * A grab is not a new input. It is the same thing as a catch — a finger held on
 * the deck — just held for longer, and it is named by *where* on the deck the
 * hold happens. That is exactly how grabs work on a real board, and it means
 * the whole grab vocabulary comes free from the contact solver that was already
 * there.
 *
 * Zones, in board-local space (+X toe side, +Z nose):
 *
 *          nose
 *      +---------+
 *      | M  | N  |      N  nose      (either rail, out past the front truck)
 *      |----|----|      M  mute      (toe rail, forward)
 *  heel| ML | IN |toe   IN indy      (toe rail, between the trucks)
 *      |----|----|      ML melon     (heel rail, between the trucks)
 *      |    T    |      T  tail      (either rail, out past the back truck)
 *      +---------+
 *          tail
 */

import Config from '../core/Config.js';

/** @typedef {{name:string, base:number, difficulty:number}} GrabDefinition */

/** @type {Record<string, GrabDefinition>} */
export const GRABS = {
  INDY: { name: 'Indy', base: 260, difficulty: 1.25 },
  MELON: { name: 'Melon', base: 280, difficulty: 1.3 },
  MUTE: { name: 'Mute', base: 320, difficulty: 1.4 },
  NOSE: { name: 'Nosegrab', base: 340, difficulty: 1.45 },
  TAIL: { name: 'Tailgrab', base: 300, difficulty: 1.35 },
  STALEFISH: { name: 'Stalefish', base: 420, difficulty: 1.6 },
};

/**
 * Which grab a hold at this point on the deck counts as.
 * @param {{x:number, z:number}} local contact point in board-local metres
 * @returns {string|null} a key into GRABS, or null if it is just a catch
 */
export function classify(local) {
  const G = Config.grabs;
  const alongTip = Math.abs(local.z) > G.tipZone;
  const onRail = Math.abs(local.x) > G.railZone;

  // A hold in the middle of the deck is a catch, not a grab: there is nothing
  // to get hold of there.
  if (!alongTip && !onRail) return null;

  if (alongTip) return local.z > 0 ? 'NOSE' : 'TAIL';

  const toeSide = local.x > 0;
  const forward = local.z > G.frontTruckZ;
  const rearward = local.z < -G.frontTruckZ;

  if (toeSide) return forward ? 'MUTE' : 'INDY';
  return rearward ? 'STALEFISH' : 'MELON';
}

/**
 * Watches the two fingers over a flight and reports the best grab held.
 *
 * "Best" is the longest, because duration is what the brief rewards and what
 * reads on screen — a grab you tapped is not a grab.
 */
export default class GrabTracker {
  constructor() {
    this.reset();
  }

  reset() {
    /** @type {string|null} */
    this.current = null;
    this.currentHold = 0;
    /** @type {string|null} */
    this.best = null;
    this.bestHold = 0;
    this.totalHeld = 0;
    this._holds = [0, 0];
    this._zones = [null, null];
  }

  /** True once the current hold has lasted long enough to count. */
  get isGrabbing() {
    return this.current !== null && this.currentHold >= Config.grabs.minHold;
  }

  get definition() {
    return this.best ? GRABS[this.best] : null;
  }

  /** Name for the HUD while the grab is still building, or null. */
  get liveName() {
    if (!this.current) return null;
    return GRABS[this.current].name;
  }

  /**
   * @param {FingerFlipController} fingers
   * @param {number} realDelta
   */
  update(fingers, realDelta) {
    const G = Config.grabs;
    let bestZone = null;
    let bestHold = 0;

    for (let i = 0; i < fingers.fingers.length; i++) {
      const f = fingers.fingers[i];
      const gripping = f.contact >= G.minContact;
      const zone = gripping ? classify(f.localContact) : null;

      if (zone && zone === this._zones[i]) {
        this._holds[i] += realDelta;
      } else {
        this._holds[i] = zone ? realDelta : 0;
        this._zones[i] = zone;
      }

      if (zone && this._holds[i] > bestHold) {
        bestHold = this._holds[i];
        bestZone = zone;
      }
    }

    this.current = bestZone;
    this.currentHold = bestHold;

    if (bestZone && bestHold >= G.minHold) {
      this.totalHeld += realDelta;
      if (bestHold > this.bestHold) {
        this.bestHold = bestHold;
        this.best = bestZone;
      }
    }
  }

  /** Points for the grab held on this flight. */
  score() {
    if (!this.best) return { name: null, points: 0, difficulty: 1, hold: 0 };
    const def = GRABS[this.best];
    const G = Config.grabs;
    // Duration pays, but with diminishing returns: holding one grab for the
    // whole flight should not beat working the board.
    const held = Math.min(this.bestHold, G.maxScoringHold);
    const points = def.base + held * G.pointsPerSecondHeld;
    return { name: def.name, points: Math.round(points), difficulty: def.difficulty, hold: held };
  }
}
