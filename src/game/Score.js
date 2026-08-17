import Config from '../core/Config.js';
import { Quality } from '../sim/Landing.js';

/**
 * ScoreSystem + ComboSystem.
 *
 * FinalScore = Base x Rotation x Difficulty x Style x LandingQuality x Combo
 *
 * The style term is where the finger mechanic pays off: catching the board is
 * worth more than letting it spin out, catching it late is worth more still,
 * and a trick landed off one decisive flick beats the same trick landed after
 * eight panicked corrections.
 */
export default class ScoreSystem {
  constructor() {
    this.total = 0;
    this.comboMultiplier = 1;
    this.comboLength = 0;
    this.comboPending = 0;
    this.lastTrickName = null;
    this.best = 0;
    this.history = [];
  }

  reset() {
    this.total = 0;
    this.breakCombo();
    this.history.length = 0;
  }

  /**
   * @param {object} trick   result from recognise()
   * @param {object} landing result from evaluateLanding()
   * @param {object} flight  { airTime, peakHeight, takeoffSpeed }
   * @param {object} hands   { flicks, caught, catchStrength, catchAt }
   * @param {object} extras  { grab, bodyTurns, name }
   */
  award(trick, landing, flight, hands, extras = {}) {
    const S = Config.score;
    const grab = extras.grab || { name: null, points: 0, difficulty: 1, hold: 0 };
    const bodyTurns = extras.bodyTurns || 0;

    const rotationPoints =
      Math.abs(trick.yaw) * S.rotationPer360 +
      Math.abs(trick.roll) * S.flipPer360 +
      Math.abs(trick.pitch) * S.pitchPer360 +
      Math.abs(bodyTurns) * S.bodySpinPer360;

    const airPoints =
      flight.airTime * S.airTimeBonusPerSecond +
      flight.peakHeight * S.heightBonusPerMetre +
      flight.takeoffSpeed * S.speedBonusPerMps;

    let stylePoints = 0;
    if (hands.caught) {
      stylePoints += S.catchBonus * hands.catchStrength;
      // A catch in the last third of the flight is a late correction: the exact
      // thing the slow-motion window exists to reward.
      if (hands.catchAt > 0.66) stylePoints += S.lateCatchBonus;
    }
    // One or two decisive flicks reads as style; frantic scrabbling does not.
    if (hands.flicks > 0 && hands.flicks <= 3) {
      stylePoints += S.styleSmoothness / hands.flicks;
    }

    const base = trick.base + rotationPoints + airPoints + stylePoints + grab.points;

    // How close the rotation landed to a named, whole trick.
    const styleMultiplier = 0.8 + 0.4 * Math.max(0, 1 - trick.error * 1.6);
    const landingMultiplier =
      S.landingMultiplier[landing.quality] * (0.75 + 0.25 * landing.score);

    const raw = base * trick.difficulty * grab.difficulty * styleMultiplier * landingMultiplier;

    const displayName = extras.name || trick.name;
    const repeated = displayName === this.lastTrickName && displayName !== 'Ollie';
    const repeatFactor = repeated ? S.repeatPenalty : 1;

    const points = Math.round(raw * repeatFactor);

    const bailed = landing.quality === Quality.BAIL;
    const breakdown = {
      trick: displayName,
      grab: grab.name,
      grabHold: grab.hold,
      bodyTurns,
      quality: landing.quality,
      points,
      base: Math.round(base),
      difficulty: trick.difficulty,
      style: round2(styleMultiplier),
      landing: round2(landingMultiplier),
      repeated,
      caught: hands.caught,
      lateCatch: hands.catchAt > 0.66,
      // Carried through so the profile can total it without being handed the
      // flight separately. It is already scored above; this is only bookkeeping.
      airTime: flight.airTime,
      reasons: landing.reasons,
      comboAt: this.comboMultiplier,
    };

    if (bailed) {
      this.breakCombo();
      breakdown.points = 0;
      breakdown.banked = 0;
      this.history.unshift(breakdown);
      this.history.length = Math.min(this.history.length, 8);
      return breakdown;
    }

    // Points ride in the combo until the run is banked, exactly like a line.
    this.comboPending += points;
    this.comboLength++;
    this.comboMultiplier = Math.min(
      Config.score.comboMax,
      1 + this.comboLength * Config.score.comboStep,
    );
    this.lastTrickName = displayName;

    breakdown.pending = this.comboPending;
    breakdown.banked = 0;
    this.history.unshift(breakdown);
    this.history.length = Math.min(this.history.length, 8);
    return breakdown;
  }

  /** Cash the pending line into the run total. */
  bank() {
    if (this.comboPending <= 0) return 0;
    const banked = Math.round(this.comboPending * this.comboMultiplier);
    this.total += banked;
    if (this.total > this.best) this.best = this.total;
    this.comboPending = 0;
    this.comboLength = 0;
    this.comboMultiplier = 1;
    this.lastTrickName = null;
    return banked;
  }

  breakCombo() {
    this.comboPending = 0;
    this.comboLength = 0;
    this.comboMultiplier = 1;
    this.lastTrickName = null;
  }
}

/**
 * Nail-the-Trick resource meter. Fills from rolling and from landed tricks,
 * drains in real time while slow motion is active.
 */
export class NailMeter {
  constructor() {
    this.value = Config.nail.meterMax;
  }

  reset() {
    this.value = Config.nail.meterMax;
  }

  get normalised() {
    return this.value / Config.nail.meterMax;
  }

  get canActivate() {
    return this.value >= Config.nail.meterMinToActivate;
  }

  drain(realDelta) {
    this.value = Math.max(0, this.value - Config.nail.meterDrainPerSecondReal * realDelta);
    return this.value > 0;
  }

  gainFromRolling(realDelta, speedNormalised) {
    this.value = Math.min(
      Config.nail.meterMax,
      this.value + Config.nail.meterGainPerSecondRolling * realDelta * speedNormalised,
    );
  }

  gainFromTrick(qualityScore) {
    this.value = Math.min(
      Config.nail.meterMax,
      this.value + Config.nail.meterGainPerTrick * (0.35 + 0.65 * qualityScore),
    );
  }
}

function round2(v) {
  return Math.round(v * 100) / 100;
}
