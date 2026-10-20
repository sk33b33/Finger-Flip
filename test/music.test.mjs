/**
 * The synthesised music bed, in the parts that are decisions rather than sound.
 *
 * The scheduling and the voices need an AudioContext and are checked by ear.
 * What can be proved here is everything that decides WHAT is played — and that
 * is where the bugs that matter live: a bed that plays a note outside the key,
 * or that does not actually thin out when the board leaves the ground, is
 * broken in a way no amount of careful synthesis fixes.
 *
 *   node --test test/music.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CHORDS,
  PENTATONIC,
  bassAt,
  chordAt,
  drumsAt,
  hz,
  leadAt,
  rand,
} from '../src/audio/Music.js';

const BAR = 16;
const bars = (n) => Array.from({ length: n }, (_, i) => i);
const steps = () => Array.from({ length: BAR }, (_, i) => i);

// ------------------------------------------------------------- the notes ----

test('every note it can play is in the key', () => {
  // A minor. The pentatonic cannot clash by construction, but the chord tones
  // have to be checked, and an off-by-one in the table would be a semitone
  // that sounds wrong under everything for as long as the game is open.
  const A_MINOR = new Set([0, 2, 3, 5, 7, 8, 10]);
  const inKey = (semi) => A_MINOR.has(((semi % 12) + 12) % 12);

  for (const c of CHORDS) {
    for (const semi of [c.root, c.third, c.fifth]) {
      assert.ok(inKey(semi), `chord tone ${semi} is out of key`);
    }
    // A triad, not a cluster: third above root, fifth above third.
    assert.ok(c.third > c.root && c.fifth > c.third, 'chord tones out of order');
  }
  for (const p of PENTATONIC) assert.ok(inKey(p), `${p} is not in A minor`);

  for (const bar of bars(8)) {
    for (const step of steps()) {
      for (const energy of [0, 0.5, 1]) {
        const b = bassAt(step, bar, energy);
        if (b !== null) assert.ok(inKey(b), `bass played ${b}`);
        const l = leadAt(step, bar, energy, 0);
        if (l !== null) assert.ok(inKey(l), `lead played ${l}`);
      }
    }
  }
});

test('the progression is four bars and it loops', () => {
  assert.equal(CHORDS.length, 4);
  for (const bar of bars(12)) {
    assert.equal(chordAt(bar), CHORDS[bar % 4]);
  }
  // Negative bars cannot happen, but a modulo that returns undefined for one
  // would be a silent dropout rather than an error.
  assert.ok(chordAt(-1));
  assert.ok(chordAt(-7));
});

test('A2 is where it says it is, and an octave is an octave', () => {
  assert.ok(Math.abs(hz(0) - 110) < 1e-9);
  assert.ok(Math.abs(hz(12) - 220) < 1e-9);
  assert.ok(Math.abs(hz(-12) - 55) < 1e-9);
});

// ------------------------------------------------------------ the pattern ---

test('it reacts to energy instead of playing one loop forever', () => {
  const hats = (energy) =>
    steps().filter((s) => drumsAt(s, 0, energy, 0).hat > 0).length;

  assert.equal(hats(0), 0, 'a stationary rider gets no hats at all');
  assert.ok(hats(0.5) > 0, 'rolling brings them in');
  assert.ok(hats(1) > hats(0.5), 'and speed doubles them up');

  const bassNotes = (energy) =>
    steps().filter((s) => bassAt(s, 0, energy) !== null).length;
  assert.ok(bassNotes(1) > bassNotes(0.2), 'the bass fills in too');
});

test('the drums go half-time in slow motion, and only on the downbeats', () => {
  // This is what reads as the music slowing down. Pitching the whole bed down
  // would detune it against sound effects that are not shifting with it.
  for (const step of steps()) {
    const d = drumsAt(step, 0, 1, 1);
    if (step % 8 !== 0) {
      assert.ok(!d.kick && !d.snare && d.hat === 0, `step ${step} still playing`);
    }
  }
  assert.ok(drumsAt(0, 0, 1, 1).kick, 'the downbeat has to survive');
  // And the hats are gone whatever the energy, because that is the top end
  // that makes slow motion sound busy.
  for (const energy of [0, 0.5, 1]) {
    assert.equal(drumsAt(2, 0, energy, 1).hat, 0);
  }
});

test('the lead stays out of the way', () => {
  // It is the one voice that draws attention, so it is gated three ways.
  const any = (bar, energy, slowmo) =>
    steps().some((s) => leadAt(s, bar, energy, slowmo) !== null);

  assert.ok(!any(1, 0.2, 0), 'silent when the rider is slow');
  assert.ok(!any(1, 1, 1), 'and silent in the trick window');
  assert.ok(!any(0, 1, 0), 'and it sits out every other bar');
  assert.ok(any(1, 1, 0), 'but it does play at speed');

  // Sparse within the bars it does play: a note on every eighth would be a
  // melody competing with the game rather than a bed under it.
  const count = steps().filter((s) => leadAt(s, 1, 1, 0) !== null).length;
  assert.ok(count > 0 && count <= 5, `${count} lead notes in one bar`);
});

test('the bar always has a downbeat to hang on', () => {
  for (const bar of bars(8)) {
    for (const energy of [0, 0.5, 1]) {
      assert.ok(drumsAt(0, bar, energy, 0).kick, `bar ${bar} has no kick on one`);
      assert.equal(bassAt(0, bar, energy), chordAt(bar).root, 'and no root');
    }
  }
});

test('the backbeat is where a backbeat goes', () => {
  for (const energy of [0, 1]) {
    assert.ok(drumsAt(4, 0, energy, 0).snare);
    assert.ok(drumsAt(12, 0, energy, 0).snare);
    assert.ok(!drumsAt(5, 0, energy, 0).snare);
  }
});

// --------------------------------------------------------------- variety ----

test('fills are deterministic, so a bar sounds the same every time round', () => {
  // The variation has to come from the bar number, not from Math.random, or
  // the bed shimmers instead of having a shape.
  for (const bar of bars(16)) {
    for (const step of steps()) {
      assert.equal(rand(bar, step, 3), rand(bar, step, 3));
    }
  }
  const once = steps().map((s) => JSON.stringify(drumsAt(s, 5, 0.8, 0)));
  const twice = steps().map((s) => JSON.stringify(drumsAt(s, 5, 0.8, 0)));
  assert.deepEqual(twice, once);
});

test('but different bars really do differ', () => {
  // Deterministic is not the same as identical: if every bar hashed the same
  // the progression would be the only thing moving.
  const shape = (bar) => steps().map((s) => JSON.stringify(drumsAt(s, bar, 0.8, 0))).join('');
  const seen = new Set(bars(16).map(shape));
  assert.ok(seen.size > 1, 'every bar played exactly the same pattern');
});

test('rand is spread across 0..1 rather than clustered', () => {
  // A hash that returns 0.97 every time would silently disable every fill.
  const values = [];
  for (const bar of bars(40)) for (const step of steps()) values.push(rand(bar, step, 1));
  const lo = values.filter((v) => v < 0.5).length;
  assert.ok(lo > values.length * 0.35 && lo < values.length * 0.65, `${lo}/${values.length} below half`);
  assert.ok(Math.min(...values) < 0.05 && Math.max(...values) > 0.95, 'range is too narrow');
});
