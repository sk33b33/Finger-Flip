/**
 * The music bed, synthesised.
 *
 * Spotify needs Premium, so for most players the Music tab is a sign-in button
 * they cannot use and the game is SFX over silence. Everything else here is
 * generated at runtime — the textures, the park, every sound effect — so the
 * soundtrack is too. No files, nothing licensed, nothing to download.
 *
 * It is not a loop played back. There is a grid, a chord progression and a set
 * of pattern rules, and the notes are scheduled a fraction of a second ahead of
 * the audio clock as they are needed. That is what lets it react: the bed can
 * thin out the instant the board leaves the ground and thicken again on the
 * landing, because the next bar has not been decided yet.
 *
 * ## How it reacts
 *
 *   energy   0..1 from the game. Rolling slowly is a bassline and a kick;
 *            at speed the full kit and the lead come in.
 *   slowmo   0..1. Hats drop, the drums go half-time, the filter closes and
 *            the pad swells. The TEMPO does not change: pitch-shifting the
 *            whole bed down was the obvious thing to try and it sounds broken,
 *            because the sound effects around it are not shifting with it.
 *            Half-time reads as the music slowing without anything detuning.
 *   duck     0..1 from Spotify. If the player has their own music, this gets
 *            out of the way entirely rather than playing underneath it.
 *
 * The pattern functions at the bottom are pure and exported, so the musical
 * decisions can be tested in Node with no audio context at all.
 */

const BPM = 94;
const STEPS_PER_BAR = 16; // sixteenths
const SECONDS_PER_STEP = 60 / BPM / 4;

/** How far ahead of the clock notes are scheduled, and how often we look. */
const LOOKAHEAD_SECONDS = 0.18;
const TICK_MS = 35;

/**
 * A minor, four bars, vi-IV-I-V. Semitone offsets from A, plus the triad
 * degrees. Deliberately the most well-worn progression there is: this plays
 * under everything the player does for as long as they play, so it has to be
 * something that does not demand attention and does not grate.
 */
export const CHORDS = [
  { root: 0, third: 3, fifth: 7 }, // Am
  { root: -4, third: 0, fifth: 3 }, // F
  { root: 3, third: 7, fifth: 10 }, // C
  { root: -2, third: 2, fifth: 5 }, // G
];

/** A minor pentatonic, in semitones from the root. Nothing here can clash. */
export const PENTATONIC = [0, 3, 5, 7, 10];

const A2 = 110; // the bass register this is all built on

/** Semitones above A2 to Hz. */
export function hz(semitones) {
  return A2 * Math.pow(2, semitones / 12);
}

/** Which chord a bar sits on. */
export function chordAt(bar) {
  return CHORDS[((bar % CHORDS.length) + CHORDS.length) % CHORDS.length];
}

/**
 * Deterministic hash, so "random" fills are the same every time the bar comes
 * round and the bed has a shape rather than a shimmer.
 */
export function rand(bar, step, salt = 0) {
  let h = (bar * 73856093) ^ (step * 19349663) ^ (salt * 83492791);
  h = Math.imul(h ^ (h >>> 15), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/**
 * What the drums do on a given sixteenth.
 *
 * @param {number} step 0..15 within the bar
 * @param {number} bar
 * @param {number} energy 0..1
 * @param {number} slowmo 0..1
 * @returns {{kick:boolean, snare:boolean, hat:number, open:boolean}}
 */
export function drumsAt(step, bar, energy, slowmo) {
  const half = slowmo > 0.5;
  // Half-time: everything that is not on a downbeat is dropped, which is what
  // makes the kit read as slowing down without any tempo change.
  if (half && step % 8 !== 0) return { kick: false, snare: false, hat: 0, open: false };

  const kick = step === 0 || step === 6 || (step === 10 && rand(bar, step, 1) > 0.45);
  const snare = step === 4 || step === 12;

  let hat = 0;
  if (!half && energy > 0.25) {
    // Eighths at low energy, sixteenths once it is moving.
    const grid = energy > 0.65 ? 2 : 4;
    if (step % grid === 0) hat = step % 4 === 0 ? 0.5 : 0.3;
  }
  const open = !half && energy > 0.5 && step === 14;
  return { kick, snare, hat, open };
}

/**
 * The bassline. Root on the downbeat, with the octave and the fifth filling in
 * as the energy comes up.
 *
 * @returns {number|null} semitones from A2, or null for a rest
 */
export function bassAt(step, bar, energy) {
  const c = chordAt(bar);
  if (step === 0) return c.root;
  if (step === 6) return c.root;
  if (energy > 0.4 && step === 10) return c.root + 12;
  if (energy > 0.7 && step === 13) return c.fifth;
  return null;
}

/**
 * The lead. Sparse on purpose: it only plays in half the bars, and only once
 * the player is actually moving, so arriving at speed sounds like something.
 */
export function leadAt(step, bar, energy, slowmo) {
  if (energy < 0.55 || slowmo > 0.3) return null;
  if (bar % 2 !== 1) return null;
  if (step % 2 !== 0) return null;
  const r = rand(bar, step, 7);
  if (r > 0.32) return null;
  // Degrees of the KEY, not of the chord. Transposing the pentatonic onto each
  // chord root is the obvious-looking thing to write and it walks the scale off
  // the key — over the F it put a B flat under a progression in A minor. All
  // four chords are diatonic here, so one pentatonic sits over the lot.
  const degree = PENTATONIC[Math.floor(rand(bar, step, 11) * PENTATONIC.length)];
  return degree + 24;
}

// ----------------------------------------------------------------- engine ---

export default class Music {
  /**
   * @param {AudioContext} ctx
   * @param {AudioNode} destination the bus everything else goes through, so
   *        the existing slow-motion filter applies to the music too
   */
  constructor(ctx, destination) {
    this.ctx = ctx;
    this.running = false;
    this.energy = 0.5;
    this.slowmo = 0;
    this.duck = 0;
    this.muted = false;
    this.step = 0;
    this.bar = 0;
    this.nextNoteTime = 0;
    this.timer = null;

    this.out = ctx.createGain();
    this.out.gain.value = 0;

    // Its own filter on top of the bus one. The bed should close down further
    // and faster than the sound effects do, so the trick window is the board
    // and not the backing track.
    this.filter = ctx.createBiquadFilter();
    this.filter.type = 'lowpass';
    this.filter.frequency.value = 16000;
    this.filter.Q.value = 0.7;

    this.filter.connect(this.out);
    this.out.connect(destination);

    this.noise = makeNoise(ctx, 1.2);
  }

  start() {
    if (this.running || !this.ctx) return;
    this.running = true;
    this.nextNoteTime = this.ctx.currentTime + 0.12;
    this.timer = setInterval(() => this.tick(), TICK_MS);
    this.applyGain();
  }

  stop() {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.out.gain.setTargetAtTime(0, this.ctx.currentTime, 0.1);
  }

  setMuted(muted) {
    this.muted = muted;
    this.applyGain();
  }

  /** 0..1. How much of the kit and the lead are playing. */
  setEnergy(energy) {
    this.energy = Math.max(0, Math.min(1, energy));
  }

  setSlowmo(slowmo) {
    this.slowmo = Math.max(0, Math.min(1, slowmo));
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.filter.frequency.setTargetAtTime(this.filterTarget(), t, 0.08);
    this.applyGain();
  }

  /** 0..1 from Spotify. At 1 this is silent: their music wins. */
  setDuck(duck) {
    this.duck = Math.max(0, Math.min(1, duck));
    this.applyGain();
  }

  /**
   * The level this bed should be sitting at, given mute, duck and slow motion.
   * Separate from applying it so an offline render can schedule the same curve
   * against its own clock — see tools/music.mjs.
   */
  gainTarget() {
    if (this.muted || !this.running) return 0;
    return 0.26 * (1 - this.duck) * (1 - this.slowmo * 0.45);
  }

  /** The cutoff that goes with it. Closes hard, and faster than the SFX bus. */
  filterTarget() {
    return 16000 - this.slowmo * 15200;
  }

  applyGain() {
    if (!this.ctx) return;
    this.out.gain.setTargetAtTime(this.gainTarget(), this.ctx.currentTime, 0.12);
  }

  /** Schedule every note that falls inside the lookahead window. */
  tick() {
    const ctx = this.ctx;
    if (!ctx || !this.running) return;
    // A tab in the background throttles timers, and the clock keeps running —
    // without this the scheduler would come back to find thousands of steps
    // owed and try to play them all at once.
    if (this.nextNoteTime < ctx.currentTime - 0.5) {
      this.nextNoteTime = ctx.currentTime + 0.05;
    }
    while (this.nextNoteTime < ctx.currentTime + LOOKAHEAD_SECONDS) {
      this.schedule(this.step, this.bar, this.nextNoteTime);
      this.nextNoteTime += SECONDS_PER_STEP;
      this.step++;
      if (this.step >= STEPS_PER_BAR) {
        this.step = 0;
        this.bar++;
      }
    }
  }

  schedule(step, bar, when) {
    if (this.muted || this.duck > 0.9) return;
    const { energy, slowmo } = this;

    const d = drumsAt(step, bar, energy, slowmo);
    if (d.kick) this.kick(when);
    if (d.snare) this.snare(when, 0.6 + energy * 0.25);
    if (d.hat) this.hat(when, d.hat, false);
    if (d.open) this.hat(when, 0.5, true);

    const b = bassAt(step, bar, energy);
    if (b !== null) this.bass(when, hz(b), SECONDS_PER_STEP * (step === 0 ? 5.5 : 2.6));

    const l = leadAt(step, bar, energy, slowmo);
    if (l !== null) this.pluck(when, hz(l));

    // The pad changes once a bar, and swells as the world slows.
    if (step === 0) this.pad(when, chordAt(bar));
  }

  // ------------------------------------------------------------ the voices ---

  kick(when) {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = 'sine';
    // The pitch drop IS the kick: a sine at a fixed frequency is a beep.
    o.frequency.setValueAtTime(128, when);
    o.frequency.exponentialRampToValueAtTime(42, when + 0.09);
    g.gain.setValueAtTime(0.0001, when);
    g.gain.exponentialRampToValueAtTime(0.9, when + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, when + 0.3);
    o.connect(g);
    g.connect(this.filter);
    o.start(when);
    o.stop(when + 0.34);
  }

  snare(when, level) {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 1900;
    bp.Q.value = 0.8;
    const g = ctx.createGain();
    g.gain.setValueAtTime(level * 0.42, when);
    g.gain.exponentialRampToValueAtTime(0.0001, when + 0.17);
    src.connect(bp);
    bp.connect(g);
    g.connect(this.filter);
    src.start(when, Math.random() * 0.4);
    src.stop(when + 0.2);
  }

  hat(when, level, open) {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 7200;
    const g = ctx.createGain();
    const len = open ? 0.26 : 0.045;
    g.gain.setValueAtTime(level * 0.38, when);
    g.gain.exponentialRampToValueAtTime(0.0001, when + len);
    src.connect(hp);
    hp.connect(g);
    g.connect(this.filter);
    src.start(when, Math.random() * 0.4);
    src.stop(when + len + 0.02);
  }

  bass(when, freq, length) {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.value = freq;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    // A filter envelope, not a static cutoff: this is what gives it the pluck.
    lp.frequency.setValueAtTime(freq * 9, when);
    lp.frequency.exponentialRampToValueAtTime(freq * 2.2, when + length * 0.7);
    lp.Q.value = 5;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, when);
    g.gain.exponentialRampToValueAtTime(0.3, when + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, when + length);
    o.connect(lp);
    lp.connect(g);
    g.connect(this.filter);
    o.start(when);
    o.stop(when + length + 0.05);
  }

  pluck(when, freq) {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    o.type = 'triangle';
    o.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, when);
    g.gain.exponentialRampToValueAtTime(0.14, when + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, when + 0.42);
    o.connect(g);
    g.connect(this.filter);
    o.start(when);
    o.stop(when + 0.46);
  }

  pad(when, chord) {
    const ctx = this.ctx;
    const length = SECONDS_PER_STEP * STEPS_PER_BAR;
    // Louder as the world slows: in the trick window the pad is most of what
    // is left, and it is what stops slow motion sounding like a dropout.
    const level = 0.05 + this.slowmo * 0.1;
    for (const semi of [chord.root + 12, chord.third + 12, chord.fifth + 12]) {
      for (const detune of [-6, 6]) {
        const o = ctx.createOscillator();
        o.type = 'sawtooth';
        o.frequency.value = hz(semi);
        o.detune.value = detune;
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.0001, when);
        g.gain.linearRampToValueAtTime(level, when + length * 0.35);
        g.gain.linearRampToValueAtTime(0.0001, when + length * 1.02);
        o.connect(g);
        g.connect(this.filter);
        o.start(when);
        o.stop(when + length * 1.1);
      }
    }
  }
}

function makeNoise(ctx, seconds) {
  const buf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * seconds), ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  return buf;
}
