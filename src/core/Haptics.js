/**
 * Haptics. A thin, forgiving wrapper: vibration is unavailable on iOS Safari
 * and on every desktop, so every call has to be a no-op that costs nothing
 * rather than something the caller has to guard.
 *
 * The patterns are deliberately short. A trick is a fast sequence of small
 * events, and long buzzes on a phone read as errors.
 */
const SUPPORTED =
  typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function';

const PATTERNS = {
  pop: 14,
  flick: 9,
  grab: [0, 10, 24, 10],
  catch: 18,
  land: 26,
  perfect: [0, 18, 30, 26],
  bail: [0, 40, 45, 70],
  denied: [0, 8, 40, 8],
};

export default class Haptics {
  constructor() {
    this.enabled = SUPPORTED;
  }

  /** @param {keyof PATTERNS} name */
  fire(name) {
    if (!this.enabled) return;
    const pattern = PATTERNS[name];
    if (pattern === undefined) return;
    try {
      navigator.vibrate(pattern);
    } catch {
      // A browser that advertises vibrate and then throws is not worth chasing.
      this.enabled = false;
    }
  }

  toggle() {
    this.enabled = SUPPORTED && !this.enabled;
    return this.enabled;
  }
}
