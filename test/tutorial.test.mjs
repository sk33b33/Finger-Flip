/**
 * The guided tutorial.
 *
 * The important test in here is the last group: the paths the tutorial DRAWS
 * on the deck are replayed through the real finger solver and have to still
 * produce the trick they claim to teach. A ghost is a promise, and a ghost
 * that has quietly drifted out of step with the physics teaches somebody the
 * wrong thing with complete confidence.
 *
 *   node --test test/tutorial.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import Config from '../src/core/Config.js';

import Tutorial, { LESSONS, Outcome } from '../src/game/Tutorial.js';
import { perform } from './harness.mjs';

const rolling = (o = {}) => ({
  state: 'ROLL',
  charging: false,
  caught: false,
  spin: { x: 0, y: 0, z: 0 },
  ...o,
});

/** Drive a tutorial through a list of contexts and report where it ends up. */
function play(steps) {
  const t = new Tutorial();
  const seen = [t.current.title];
  for (const ctx of steps) {
    const r = t.update(rolling(ctx));
    if (r.outcome !== Outcome.WAITING) seen.push(t.current ? t.current.title : '(finished)');
  }
  return { tutorial: t, seen };
}

// ------------------------------------------------------------- the script ---

test('it is a sequence, and nothing is skipped by accident', () => {
  const t = new Tutorial();
  // Being in the air does not satisfy "hold to charge", even though a later
  // lesson wants exactly that. A tutorial that advances two steps on one
  // action leaves the player having never done one of them.
  assert.equal(t.update(rolling({ state: 'AIR' })).outcome, Outcome.WAITING);
  assert.equal(t.current.title, 'Roll in');

  assert.equal(t.update(rolling({ charging: true })).outcome, Outcome.ADVANCED);
  assert.equal(t.current.title, 'Let it go');
});

test('a whole run through finishes', () => {
  const { tutorial, seen } = play([
    { charging: true },
    { state: 'AIR' },
    { state: 'AIR', spin: { x: 0, y: 0, z: -0.6 } },
    { state: 'AIR', caught: true, spin: { x: 0, y: 0, z: -1 } },
    { state: 'ROLL' },
    { state: 'AIR' },
    { state: 'AIR', spin: { x: 0, y: -0.3, z: 0 } },
    { state: 'ROLL' },
  ]);
  assert.equal(tutorial.finished, true, `got as far as ${seen.at(-1)}`);
  assert.equal(seen.length, LESSONS.length + 1);
});

test('the two flick lessons hover, and the rest do not', () => {
  // Hovering is what makes the lesson untimed. It has to be on exactly the
  // steps that ask for a flick: leave it on while they are trying to land and
  // the board never reaches the ground.
  const t = new Tutorial();
  assert.equal(t.hovering, false, 'the roll-in must not freeze the world');

  t.update(rolling({ charging: true }));
  t.update(rolling({ state: 'AIR' }));
  assert.equal(t.current.title, 'Now flip it');
  assert.equal(t.hovering, true);

  t.update(rolling({ state: 'AIR', spin: { x: 0, y: 0, z: -0.6 } }));
  assert.equal(t.hovering, true, 'the catch needs to wait too');

  t.update(rolling({ state: 'AIR', caught: true }));
  assert.equal(t.current.title, 'Ride away');
  assert.equal(t.hovering, false, 'a hovering board can never land');
});

test('a slam rewinds to the start of that trick, not to the beginning', () => {
  // Losing the kickflip because you fluffed the shove-it would be its own
  // small punishment, and the tutorial does not punish.
  const t = new Tutorial();
  for (const ctx of [
    { charging: true },
    { state: 'AIR' },
    { state: 'AIR', spin: { x: 0, y: 0, z: -0.6 } },
    { state: 'AIR', caught: true },
    { state: 'ROLL' },
    { state: 'AIR' },
  ]) {
    t.update(rolling(ctx));
  }
  assert.equal(t.current.block, 1, 'should be on the shove-it by now');
  t.rewind();
  assert.equal(t.current.block, 1, 'rewound past the trick it was teaching');
  assert.equal(t.current.title, LESSONS.find((l) => l.block === 1).title);
});

test('rewinding the first trick goes to the very start, and stops there', () => {
  const t = new Tutorial();
  t.update(rolling({ charging: true }));
  t.rewind();
  assert.equal(t.index, 0);
  t.rewind();
  assert.equal(t.index, 0, 'rewind must not run off the front');
});

test('skip finishes it without pretending it was done', () => {
  const t = new Tutorial();
  t.skip();
  assert.equal(t.finished, true);
  assert.equal(t.current, null);
  assert.equal(t.hovering, false);
  assert.equal(t.ghost, null);
  // And it keeps answering rather than throwing.
  assert.equal(t.update(rolling()).outcome, Outcome.FINISHED);
});

test('every lesson can be read and acted on', () => {
  for (const l of LESSONS) {
    assert.ok(l.title && l.title.length < 40, `bad title: ${l.title}`);
    assert.ok(l.body && l.body.length > 20, `thin body on ${l.title}`);
    assert.equal(typeof l.done, 'function');
    assert.equal(typeof l.block, 'number');
    // Markup in the copy is only ever <b> around a part of the board. It goes
    // through innerHTML, so anything else is both a surprise and a hazard.
    const tags = l.body.match(/<[^>]+>/g) || [];
    for (const tag of tags) assert.match(tag, /^<\/?b>$/, `${l.title} has ${tag}`);
  }
});

// -------------------------------------------------- the paths are honest ---

/**
 * Replay a drawn ghost path through the real solver.
 *
 * The harness takes a direction and a hold rather than an end point, so the
 * drawn path is converted back: same start, same direction, and a hold long
 * enough to cover the distance at the finger's own ramped speed.
 */
function tracePath(path) {
  const dx = path.to[0] - path.from[0];
  const dz = path.to[1] - path.from[1];
  const distance = Math.hypot(dx, dz);

  // Walk the ramp up to the drawn end point and STOP SHORT of it rather than
  // past it. One frame of overshoot is not a rounding detail here: the scoop
  // is 0.152m and the frame after that is 0.19m, which is the difference
  // between a shove-it and a varial. "Follow the line and stop at the ring"
  // has to mean the line.
  const rd = 1 / 60;
  const max = Config.fingers.keyboardSpeed;
  let speed = 0;
  let travelled = 0;
  let hold = 0;
  for (let n = 0; n < 120; n++) {
    const next = speed + (max - speed) * Math.min(1, Config.fingers.keyboardRamp * rd);
    if (travelled + next * rd > distance) break;
    speed = next;
    travelled += speed * rd;
    hold += rd;
  }

  return perform([
    {
      finger: path.finger,
      at: 0.12,
      hold,
      across: path.from[0],
      along: path.from[1],
      dAcross: dx,
      dAlong: dz,
    },
  ]);
}

test('the kickflip path it draws really does produce a kickflip', () => {
  const lesson = LESSONS.find((l) => l.title === 'Now flip it');
  const r = tracePath(lesson.ghost[0]);
  assert.match(r.trick.name, /Kickflip/, `got ${r.trick.name} (roll ${r.spin.z.toFixed(2)})`);
  // And it clears the lesson's own threshold, so tracing the line advances it.
  assert.ok(lesson.done({ spin: r.spin }), `roll ${r.spin.z.toFixed(2)} did not pass the step`);
});

test('the shove-it path it draws really does produce a shove-it', () => {
  const lesson = LESSONS.find((l) => l.title === 'Scoop the tail');
  const r = tracePath(lesson.ghost[0]);
  assert.match(r.trick.name, /Shove-it/, `got ${r.trick.name} (yaw ${r.spin.y.toFixed(2)})`);
  assert.ok(lesson.done({ spin: r.spin }), `yaw ${r.spin.y.toFixed(2)} did not pass the step`);
});

test('the paths start on the deck, even if they finish off it', () => {
  // A flick ENDS past the rail — that is what flicking off the edge means —
  // but it has to start somewhere a finger could be put down.
  const halfWidth = Config.board.width / 2 + Config.fingers.gripMargin;
  const halfLength = Config.board.length / 2 + Config.fingers.gripMargin;
  for (const l of LESSONS) {
    for (const path of l.ghost || []) {
      assert.ok(Math.abs(path.from[0]) <= halfWidth, `${l.title} starts off the rail`);
      assert.ok(Math.abs(path.from[1]) <= halfLength, `${l.title} starts past the tip`);
      assert.ok(path.finger === 0 || path.finger === 1, `${l.title} has no such finger`);
    }
  }
});

test('the catch is drawn as two plants over the trucks', () => {
  const lesson = LESSONS.find((l) => l.title === 'Catch it');
  assert.equal(lesson.ghost.length, 2, 'catching is a two-finger instruction');
  for (const p of lesson.ghost) {
    assert.equal(p.plant, true);
    assert.deepEqual(p.from, p.to, 'a plant does not travel');
  }
  // One on each end, not both on the same one.
  assert.ok(lesson.ghost[0].from[1] * lesson.ghost[1].from[1] < 0);
});
