/**
 * Called shots, and the game of S.K.A.T.E. built on them.
 *
 * The whole mode is pure: it is handed what the simulation already produced
 * and hands back what the HUD should say, so a full game can be played out
 * here with no renderer, no audio and no DOM.
 *
 *   node --test test/skate.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { TRICKS, recognise, matchCall, trickByName } from '../src/sim/Tricks.js';
import SkateGame, { LETTERS, Outcome, difficultyCapFor } from '../src/game/Skate.js';

/** A performance that is `off` turns away from the named trick's ideal roll. */
const perform = (t, { roll = 0, yaw = 0, pitch = 0 } = {}) =>
  recognise({ z: t.roll + roll, y: t.yaw + yaw, x: t.pitch + pitch });

const CLEAN = { quality: 'CLEAN' };

// ------------------------------------------------------- the called shot ----

test('a called trick is judged harder than a free one', () => {
  // This is the entire point of the mode. recognise() quantises generously,
  // because in free skating the game should credit what you clearly meant — a
  // board 70% of the way round still reads as a kickflip. Asked for a specific
  // trick, "clearly meant" is not good enough.
  const sloppy = recognise({ z: -0.7, y: 0, x: 0 });
  assert.equal(sloppy.name, 'Kickflip', 'free skating still calls this one');

  const called = matchCall('Kickflip', sloppy);
  assert.equal(called.axes, true, 'it is the right shape');
  assert.equal(called.clean, false, 'but not inside the tolerance');
  assert.equal(called.hit, false);
  assert.equal(called.reason, 'Not clean enough');
});

test('tolerance is per trick, and it is finally doing something', () => {
  // Every row has carried a tolerance since the table was written and nothing
  // read it. If this ever goes back to being dead data, these fail.
  for (const t of TRICKS) {
    assert.ok(t.tolerance > 0, `${t.name} has no tolerance`);
  }
  // A triple gets more slop than an ollie, because there is nothing to be
  // imprecise about on an ollie.
  assert.ok(trickByName('Triple Kickflip').tolerance > trickByName('Ollie').tolerance);

  // And the grading actually uses the row's own number rather than a constant.
  const drift = 0.26;
  assert.equal(matchCall('Ollie', recognise({ z: drift, y: 0, x: 0 })).clean, false);
  assert.equal(
    matchCall('Triple Kickflip', recognise({ z: -3 + drift, y: 0, x: 0 })).clean,
    true,
  );
});

test('every trick in the table can be called and hit', () => {
  // Guards the seam between the recogniser and the table: a row whose axes do
  // not round-trip through quantise() would be a trick the mode could ask for
  // and nobody could ever land.
  for (const t of TRICKS) {
    const m = matchCall(t.name, perform(t));
    assert.ok(m.hit, `${t.name} cannot be landed when called: ${m.reason}`);
    assert.ok(m.closeness > 0.9, `${t.name} scored only ${m.closeness}`);
  }
});

test('the miss reason names one thing, and the right thing', () => {
  const kick = trickByName('Kickflip');
  assert.equal(matchCall('Kickflip', perform(kick, { roll: -1 })).reason, 'Too much flip');
  assert.equal(matchCall('Kickflip', perform(kick, { roll: 1 })).reason, 'Not enough flip');
  // A heelflip when a kickflip was called is not "too much flip" — it is the
  // wrong way round, and saying so is the difference between useful and noise.
  assert.equal(matchCall('Kickflip', recognise({ z: 1, y: 0, x: 0 })).reason, 'That flipped the heel way');
  assert.equal(matchCall('Heelflip', recognise({ z: -1, y: 0, x: 0 })).reason, 'That flipped the toe way');

  const shove = trickByName('Pop Shove-it');
  assert.equal(matchCall('Pop Shove-it', perform(shove, { yaw: -0.5 })).reason, 'Over-scooped');
  assert.equal(
    matchCall('Pop Shove-it', recognise({ z: 0, y: 0.5, x: 0 })).reason,
    'Scooped the wrong way',
  );
});

test('an unknown call is refused rather than throwing', () => {
  const m = matchCall('Nollie Bigspin Heelflip Melon', recognise({ z: 0, y: 0, x: 0 }));
  assert.equal(m.hit, false);
  assert.equal(m.called, null);
});

// -------------------------------------------------------------- the game ----

test('landing the call moves the game on, missing it takes a letter', () => {
  const g = new SkateGame({ seed: 1 });
  const first = g.called;

  const miss = g.attempt({ performed: recognise({ z: 2.5, y: 1, x: 0 }), landing: CLEAN });
  assert.equal(miss.outcome, Outcome.WRONG);
  assert.equal(miss.letters, 'S');
  // Same trick again. Rerolling on a miss would mean you never get a second
  // go at the one you could not do, which is the opposite of the real game.
  assert.equal(g.called, first, 'a letter must not reroll the call');

  const hit = g.attempt({ performed: perform(first), landing: CLEAN });
  assert.equal(hit.outcome, Outcome.LANDED);
  assert.notEqual(g.called, first, 'landing it moves on');
});

test('there are three ways to miss and they are all a letter', () => {
  for (const [landing, performed, outcome] of [
    [{ quality: 'BAIL' }, null, Outcome.BAILED],
    [{ quality: 'SLAM' }, null, Outcome.SKETCHY],
    [CLEAN, recognise({ z: -3, y: -1.5, x: 0 }), Outcome.WRONG],
  ]) {
    const g = new SkateGame({ seed: 4 });
    const r = g.attempt({ performed: performed || perform(g.called), landing });
    assert.equal(r.outcome, outcome);
    assert.equal(r.letters, 'S', `${outcome} did not cost a letter`);
  }
});

test('a bail is a bail even if the board came round to the right trick', () => {
  // Order matters in the judge: you have to ride away.
  const g = new SkateGame({ seed: 9 });
  const r = g.attempt({ performed: perform(g.called), landing: { quality: 'BAIL' } });
  assert.equal(r.outcome, Outcome.BAILED);
});

test('five letters and the game is over', () => {
  const g = new SkateGame({ seed: 2 });
  const wrong = recognise({ z: -3, y: -1.5, x: -1 });
  for (let i = 0; i < LETTERS.length; i++) {
    assert.equal(g.done, false, `done after ${i} letters`);
    g.attempt({ performed: wrong, landing: CLEAN });
  }
  assert.equal(g.done, true);
  assert.equal(g.letters, 'SKATE');
  assert.equal(g.nextLetter, null);

  // And it stays over without throwing, however many more land.
  const after = g.attempt({ performed: perform(g.called), landing: CLEAN });
  assert.equal(after.done, true);
  assert.equal(g.landedCount, 0);
});

test('it opens on tricks a beginner can do', () => {
  // Round one calling a Ghetto Bird would end the mode before it taught
  // anybody anything.
  assert.ok(difficultyCapFor(0) <= 1.5);
  const easy = TRICKS.filter((t) => t.difficulty <= difficultyCapFor(0));
  assert.ok(easy.length >= 4, `only ${easy.length} opening tricks`);
  assert.ok(easy.some((t) => t.name === 'Ollie'));
  assert.ok(!easy.some((t) => t.name === 'Ghetto Bird'));

  // Across many seeds, nothing hard ever comes up first.
  for (let seed = 0; seed < 200; seed++) {
    assert.ok(new SkateGame({ seed }).called.difficulty <= 1.5);
  }
});

test('and it gets harder as you land them', () => {
  assert.ok(difficultyCapFor(10) > difficultyCapFor(3));
  // But never past the hardest thing in the table, or the cap stops meaning
  // anything and late rounds are a uniform draw.
  const hardest = Math.max(...TRICKS.map((t) => t.difficulty));
  assert.ok(difficultyCapFor(999) <= hardest + 0.3);

  const g = new SkateGame({ seed: 11 });
  const seen = [];
  for (let i = 0; i < 25; i++) {
    seen.push(g.called.difficulty);
    g.attempt({ performed: perform(g.called), landing: CLEAN });
  }
  const early = Math.max(...seen.slice(0, 3));
  const late = Math.max(...seen.slice(-8));
  assert.ok(late > early, `late calls (${late}) no harder than early (${early})`);
});

test('the same seed plays the same game', () => {
  // Which is what makes any of this testable, and what would let a daily
  // S.K.A.T.E. challenge be the same for everyone.
  const run = (seed) => {
    const g = new SkateGame({ seed });
    const out = [];
    for (let i = 0; i < 12; i++) {
      out.push(g.called.name);
      g.attempt({ performed: perform(g.called), landing: CLEAN });
    }
    return out;
  };
  assert.deepEqual(run(42), run(42));
  assert.notDeepEqual(run(42), run(43));
});

test('it never calls the same trick twice in a row', () => {
  const g = new SkateGame({ seed: 5 });
  let previous = null;
  for (let i = 0; i < 40; i++) {
    assert.notEqual(g.called.name, previous, `repeated ${previous} at round ${i}`);
    previous = g.called.name;
    g.attempt({ performed: perform(g.called), landing: CLEAN });
  }
});

test('reset puts it back to a new game of the same seed', () => {
  const g = new SkateGame({ seed: 3 });
  const opener = g.called.name;
  g.attempt({ performed: recognise({ z: -3, y: 0, x: 0 }), landing: CLEAN });
  assert.equal(g.letters, 'S');
  g.reset();
  assert.equal(g.letters, '');
  assert.equal(g.landedCount, 0);
  assert.equal(g.called.name, opener);
});
