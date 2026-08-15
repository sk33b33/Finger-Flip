import Config from '../core/Config.js';

/**
 * Original procedural audio. Every sound is synthesised from noise and
 * oscillators at runtime — there are no samples in this project, borrowed or
 * otherwise.
 *
 * The whole mix runs through one filtered bus. Entering slow motion closes the
 * filter and ducks the environment, which is what makes the trick window feel
 * like it happens somewhere else, then opens back up on the way out.
 */
export default class AudioEngine {
  constructor() {
    this.ctx = null;
    this.ready = false;
    this.muted = false;
    this.rollGain = null;
  }

  /** Must be called from a user gesture. Safe to call repeatedly. */
  start() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return;
    }
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    this.ctx = ctx;

    this.master = ctx.createGain();
    this.master.gain.value = 0.75;

    // The bus filter: wide open normally, clamped down in slow motion.
    this.busFilter = ctx.createBiquadFilter();
    this.busFilter.type = 'lowpass';
    this.busFilter.frequency.value = 18000;
    this.busFilter.Q.value = 0.6;

    // A gentle plate-ish tail, built from a synthesised impulse response.
    this.reverb = ctx.createConvolver();
    this.reverb.buffer = makeImpulse(ctx, 1.7, 2.6);
    this.reverbGain = ctx.createGain();
    this.reverbGain.gain.value = 0.16;

    this.busFilter.connect(this.master);
    this.busFilter.connect(this.reverbGain);
    this.reverbGain.connect(this.reverb);
    this.reverb.connect(this.master);
    this.master.connect(ctx.destination);

    this.noiseBuffer = makeNoise(ctx, 2.5);
    this.startRoll();
    this.ready = true;
  }

  get t() {
    return this.ctx ? this.ctx.currentTime : 0;
  }

  // ------------------------------------------------------------ rolling ---

  startRoll() {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    src.loop = true;

    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 240;
    bp.Q.value = 0.9;

    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 1400;

    const g = ctx.createGain();
    g.gain.value = 0;

    src.connect(bp);
    bp.connect(lp);
    lp.connect(g);
    g.connect(this.busFilter);
    src.start();

    this.rollGain = g;
    this.rollFilter = bp;
    this.rollLp = lp;
  }

  /** @param {number} speed m/s, @param {boolean} grounded */
  updateRoll(speed, grounded, slowmo) {
    if (!this.ready || this.muted) return;
    const n = Math.min(1, speed / Config.skater.maxSpeed);
    const target = grounded ? 0.055 + n * 0.19 : 0.0;
    const t = this.t;
    this.rollGain.gain.setTargetAtTime(target, t, 0.08);
    this.rollFilter.frequency.setTargetAtTime(150 + n * 420, t, 0.1);
    this.rollLp.frequency.setTargetAtTime(700 + n * 2600 * (1 - slowmo * 0.8), t, 0.1);
  }

  /** Duck and darken the mix as the world slows. @param {number} slowmo 0..1 */
  setSlowmo(slowmo) {
    if (!this.ready) return;
    const t = this.t;
    this.busFilter.frequency.setTargetAtTime(18000 - slowmo * 16200, t, 0.06);
    this.master.gain.setTargetAtTime(0.75 - slowmo * 0.18, t, 0.06);
    this.reverbGain.gain.setTargetAtTime(0.16 + slowmo * 0.4, t, 0.1);
  }

  // ------------------------------------------------------- one-shot cues ---

  /** Falling pitch sweep as the world drops into slow motion. */
  timeWarpIn() {
    if (!this.ready || this.muted) return;
    const ctx = this.ctx;
    const t = this.t;
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(880, t);
    osc.frequency.exponentialRampToValueAtTime(96, t + 0.42);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.22, t + 0.05);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.55);
    osc.connect(g);
    g.connect(this.busFilter);
    osc.start(t);
    osc.stop(t + 0.6);

    // A low sub thump underneath to give it weight.
    this.tone(58, 0.5, 0.26, 'sine', 0.02);
  }

  timeWarpOut() {
    if (!this.ready || this.muted) return;
    const ctx = this.ctx;
    const t = this.t;
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(120, t);
    osc.frequency.exponentialRampToValueAtTime(760, t + 0.22);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.15, t + 0.04);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
    osc.connect(g);
    g.connect(this.busFilter);
    osc.start(t);
    osc.stop(t + 0.35);
  }

  /** The tail snapping against concrete. */
  pop(power = 1) {
    if (!this.ready || this.muted) return;
    this.noiseBurst({ duration: 0.09, type: 'highpass', freq: 900, gain: 0.42 * power, decay: 0.05 });
    this.tone(180, 0.09, 0.2 * power, 'triangle', 0.004);
  }

  /** Grip tape scraping under a moving finger. */
  flick(power = 1) {
    if (!this.ready || this.muted) return;
    this.noiseBurst({
      duration: 0.16,
      type: 'bandpass',
      freq: 2400 + Math.random() * 1400,
      gain: 0.16 * power,
      decay: 0.09,
      q: 1.6,
    });
  }

  /** The board arriving back against a finger. */
  catchSound(power = 1) {
    if (!this.ready || this.muted) return;
    this.tone(240 + Math.random() * 60, 0.1, 0.2 * power, 'square', 0.003);
    this.noiseBurst({ duration: 0.07, type: 'lowpass', freq: 1600, gain: 0.2 * power, decay: 0.04 });
  }

  /** Wheels hitting the ground. `quality` 0..1 makes a good landing crisper. */
  land(quality) {
    if (!this.ready || this.muted) return;
    const clean = Math.max(0, Math.min(1, quality));
    this.noiseBurst({
      duration: 0.22,
      type: 'lowpass',
      freq: 500 + clean * 2600,
      gain: 0.34,
      decay: 0.1,
    });
    this.tone(70 + clean * 40, 0.18, 0.3, 'sine', 0.004);
    if (clean > 0.7) this.tone(1400, 0.07, 0.06, 'sine', 0.002);
  }

  bail() {
    if (!this.ready || this.muted) return;
    this.noiseBurst({ duration: 0.6, type: 'lowpass', freq: 900, gain: 0.42, decay: 0.28 });
    this.tone(52, 0.5, 0.34, 'sawtooth', 0.005);
    // A dry clatter of the board bouncing away.
    for (let i = 0; i < 5; i++) {
      setTimeout(() => {
        this.noiseBurst({
          duration: 0.06,
          type: 'bandpass',
          freq: 700 + Math.random() * 1800,
          gain: 0.1,
          decay: 0.03,
          q: 3,
        });
      }, 90 + i * (70 + Math.random() * 90));
    }
  }

  /** Rising arpeggio when a line is banked. */
  reward(steps = 3) {
    if (!this.ready || this.muted) return;
    const base = 523.25;
    const ratios = [1, 1.25, 1.5, 2, 2.5, 3];
    for (let i = 0; i < Math.min(steps, ratios.length); i++) {
      setTimeout(() => this.tone(base * ratios[i], 0.22, 0.1, 'triangle', 0.006), i * 68);
    }
  }

  denied() {
    if (!this.ready || this.muted) return;
    this.tone(160, 0.14, 0.12, 'square', 0.004);
    setTimeout(() => this.tone(120, 0.16, 0.1, 'square', 0.004), 90);
  }

  // ------------------------------------------------------------ helpers ---

  tone(freq, duration, gain, type = 'sine', attack = 0.005) {
    const ctx = this.ctx;
    const t = this.t;
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain), t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + duration);
    osc.connect(g);
    g.connect(this.busFilter);
    osc.start(t);
    osc.stop(t + duration + 0.02);
  }

  noiseBurst({ duration, type, freq, gain, decay, q = 1 }) {
    const ctx = this.ctx;
    const t = this.t;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    src.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + decay);
    src.connect(f);
    f.connect(g);
    g.connect(this.busFilter);
    src.start(t, Math.random() * 2);
    src.stop(t + duration);
  }

  toggleMute() {
    this.muted = !this.muted;
    if (this.master) this.master.gain.value = this.muted ? 0 : 0.75;
    return this.muted;
  }
}

function makeNoise(ctx, seconds) {
  const len = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  return buf;
}

/** Exponentially decaying noise: a serviceable synthetic room. */
function makeImpulse(ctx, seconds, decay) {
  const len = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < len; i++) {
      d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
    }
  }
  return buf;
}
