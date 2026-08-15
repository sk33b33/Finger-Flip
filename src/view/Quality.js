import Config from '../core/Config.js';

/**
 * Adaptive quality.
 *
 * The slow-motion composite is the most expensive thing the game draws — the
 * radial blur samples the scene six times per colour channel — and it switches
 * on at exactly the moment the player most needs a steady frame rate. On a
 * phone at a device pixel ratio of 2 that is a real risk.
 *
 * So the renderer gives ground in a fixed order, cheapest visual loss first:
 *
 *   0  everything on, full pixel ratio
 *   1  pixel ratio 1.5
 *   2  radial blur down to three taps
 *   3  pixel ratio 1.0
 *   4  bloom off
 *
 * It only steps down after a sustained overrun, and steps back up far more
 * slowly than it steps down: oscillating between tiers looks far worse than
 * simply sitting at the lower one.
 */

const TIERS = [
  { pixelRatio: 1.0, radialTaps: 6, bloom: true, label: 'full' },
  { pixelRatio: 0.75, radialTaps: 6, bloom: true, label: 'high' },
  { pixelRatio: 0.75, radialTaps: 3, bloom: true, label: 'medium' },
  { pixelRatio: 0.5, radialTaps: 3, bloom: true, label: 'low' },
  { pixelRatio: 0.5, radialTaps: 3, bloom: false, label: 'minimum' },
];

export default class QualityManager {
  /**
   * @param {Stage} stage
   * @param {PostFX} postFX
   */
  constructor(stage, postFX) {
    this.stage = stage;
    this.postFX = postFX;
    this.tier = 0;
    this.enabled = true;

    this._overBudget = 0;
    this._underBudget = 0;
    this._basePixelRatio = Math.min(
      typeof devicePixelRatio === 'number' ? devicePixelRatio : 1,
      Config.fx.maxPixelRatio,
    );
    this.apply();
  }

  get label() {
    return TIERS[this.tier].label;
  }

  /**
   * @param {number} realDelta seconds of wall clock for the frame just drawn
   */
  update(realDelta) {
    if (!this.enabled) return;
    const Q = Config.fx.adaptive;

    // A single long frame is a hiccup — a tab switch, a texture upload, a GC.
    // Only a run of them is a quality problem.
    if (realDelta > Q.budgetSeconds) {
      this._overBudget += realDelta;
      this._underBudget = 0;
    } else if (realDelta < Q.comfortableSeconds) {
      this._underBudget += realDelta;
      this._overBudget = 0;
    }

    if (this._overBudget > Q.dropAfterSeconds && this.tier < TIERS.length - 1) {
      this.tier++;
      this._overBudget = 0;
      this._underBudget = 0;
      this.apply();
    } else if (this._underBudget > Q.raiseAfterSeconds && this.tier > 0) {
      this.tier--;
      this._overBudget = 0;
      this._underBudget = 0;
      this.apply();
    }
  }

  apply() {
    const t = TIERS[this.tier];
    const ratio = Math.max(0.5, this._basePixelRatio * t.pixelRatio);

    if (Math.abs(this.stage.renderer.getPixelRatio() - ratio) > 0.01) {
      this.stage.renderer.setPixelRatio(ratio);
      // The render targets are sized in device pixels, so they have to follow.
      this.stage.resize();
    }

    this.postFX.setRadialTaps(t.radialTaps);
    this.postFX.bloomEnabled = t.bloom;
  }

  /** Pin to a tier and stop adapting. Used by the effects toggle. */
  setTier(tier) {
    this.tier = Math.max(0, Math.min(TIERS.length - 1, tier));
    this.apply();
  }

  static get tierCount() {
    return TIERS.length;
  }
}
