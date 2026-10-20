import { TRICKS, matchCall } from '../sim/Tricks.js';

/**
 * A game of S.K.A.T.E.
 *
 * The free-skate loop grades how WELL you flicked. This grades whether you
 * produced the trick you were asked for, which is a different skill and the one
 * the trick table was always implicitly about: twenty-four named rows, and
 * nothing in the game had ever asked for a particular one of them.
 *
 * Rules, as close to the real game as a single player allows: the game sets a
 * trick, you try to match it. Miss it and you take a letter. Five letters and
 * you are out. "Miss" covers all three ways to fail — bailing, riding away too
 * scruffily to count, and landing something clean that simply was not what was
 * called — because in the real game there is no difference between them.
 *
 * Pure and renderer-free: it is handed what the sim already produced and hands
 * back what the HUD should say. No DOM, no audio, no three.js, so the whole
 * mode can be played out in Node.
 */

export const LETTERS = 'SKATE';

export const Outcome = Object.freeze({
  LANDED: 'LANDED',
  WRONG: 'WRONG',
  BAILED: 'BAILED',
  SKETCHY: 'SKETCHY',
});

/**
 * How hard the called tricks are allowed to get, by round.
 *
 * It opens on the five tricks somebody could do on their first go and widens
 * from there. Without this, round one could call a Ghetto Bird and the mode
 * would be over before it taught anybody anything.
 */
export function difficultyCapFor(round) {
  if (round < 3) return 1.5;
  return Math.min(4.0, 1.5 + (round - 2) * 0.22);
}

/** mulberry32: small, fast, and good enough that a seed means a run. */
function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export default class SkateGame {
  /**
   * @param {{seed?:number, tricks?:Array}} opts  a seed makes a run
   *        reproducible, which is what lets the mode be tested at all.
   */
  constructor({ seed = (Math.random() * 2 ** 32) >>> 0, tricks = TRICKS } = {}) {
    this.seed = seed >>> 0;
    this.tricks = tricks;
    this.reset();
  }

  reset() {
    this.random = prng(this.seed);
    this.round = 0;
    this.landedCount = 0;
    this.letterCount = 0;
    this.history = [];
    // Cleared BEFORE picking, not just reassigned by it. pick() excludes the
    // previous call so the same trick is never asked for twice running, and
    // leaving the last game's trick in place here would shrink the pool — so
    // reset() would open on a different trick than a fresh game of the same
    // seed, and the seed would stop meaning a game.
    this.called = null;
    this.called = this.pick();
  }

  get letters() {
    return LETTERS.slice(0, this.letterCount);
  }

  get done() {
    return this.letterCount >= LETTERS.length;
  }

  /** The letter that is about to be taken, for the HUD to show at risk. */
  get nextLetter() {
    return this.done ? null : LETTERS[this.letterCount];
  }

  /** Pick a trick for this round: inside the cap, and never the last one again. */
  pick() {
    const cap = difficultyCapFor(this.round);
    const previous = this.called?.name;
    let pool = this.tricks.filter((t) => t.difficulty <= cap && t.name !== previous);
    // The cap can only exclude everything if the table's easiest trick is above
    // it, which would be a table problem — but falling back beats throwing.
    if (!pool.length) pool = this.tricks.filter((t) => t.name !== previous);
    if (!pool.length) pool = this.tricks;
    return pool[Math.floor(this.random() * pool.length)];
  }

  /**
   * One attempt at the called trick.
   *
   * @param {object} o
   * @param {ReturnType<import('../sim/Tricks.js').recognise>} o.performed
   * @param {{quality:string}} o.landing
   * @returns {{outcome:string, reason:string, letter:string|null, called:object,
   *            next:object|null, letters:string, done:boolean, closeness:number}}
   */
  attempt({ performed, landing }) {
    if (this.done) {
      return {
        outcome: Outcome.WRONG,
        reason: 'Out',
        letter: null,
        called: this.called,
        next: null,
        letters: this.letters,
        done: true,
        closeness: 0,
      };
    }

    const called = this.called;
    const match = matchCall(called.name, performed);

    // Order matters: a bail is a bail even if the board happened to come round
    // to the right trick on the way to the floor.
    let outcome;
    let reason;
    if (landing.quality === 'BAIL') {
      outcome = Outcome.BAILED;
      reason = 'Did not ride away';
    } else if (landing.quality === 'SLAM') {
      outcome = Outcome.SKETCHY;
      reason = 'Too sketchy to count';
    } else if (!match.hit) {
      outcome = Outcome.WRONG;
      reason = match.reason;
    } else {
      outcome = Outcome.LANDED;
      reason = '';
    }

    const landed = outcome === Outcome.LANDED;
    let letter = null;
    if (landed) {
      this.landedCount++;
    } else {
      letter = LETTERS[this.letterCount];
      this.letterCount++;
    }

    this.history.unshift({ called: called.name, got: performed.name, outcome, reason });
    this.history.length = Math.min(this.history.length, 12);

    // A landed trick moves the game on. A letter does not: you get the same
    // trick again, which is both how the real game works and the only way the
    // mode teaches anything.
    if (landed) {
      this.round++;
      this.called = this.done ? called : this.pick();
    }

    return {
      outcome,
      reason,
      letter,
      called,
      next: this.done ? null : this.called,
      letters: this.letters,
      done: this.done,
      closeness: match.closeness,
    };
  }

  /** What the run was worth, for the profile and the stats screen. */
  summary() {
    return {
      landed: this.landedCount,
      letters: this.letters,
      done: this.done,
      round: this.round,
    };
  }
}
