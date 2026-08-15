/**
 * The trick vocabulary, driven through the real input path.
 *
 * Every case here is a recipe a player could physically perform with two
 * fingers. If one of these stops naming the right trick, the mechanic has
 * drifted and the game has become unlearnable — which is the failure mode the
 * brief cares most about.
 *
 *   node --test test/tricks.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { perform, railFlick, scoop, tipDrag, catchBoard } from './harness.mjs';
import Config from '../src/core/Config.js';

const show = (r) =>
  `${r.trick.name} (roll ${r.spin.z.toFixed(2)} yaw ${r.spin.y.toFixed(2)} pitch ${r.spin.x.toFixed(2)})`;

test('doing nothing but popping is an Ollie', () => {
  const r = perform([]);
  assert.equal(r.trick.name, 'Ollie', show(r));
});

test('a flick off the toe rail is a Kickflip', () => {
  const r = perform([railFlick({ dir: 1 })]);
  assert.equal(r.trick.name, 'Kickflip', show(r));
});

test('a flick off the heel rail is a Heelflip', () => {
  const r = perform([railFlick({ dir: -1 })]);
  assert.equal(r.trick.name, 'Heelflip', show(r));
});

test('a scoop across the tail is a Shove-it', () => {
  const r = perform([scoop({ dir: 1 })]);
  assert.match(r.trick.name, /Shove-it/, show(r));
});

test('scooping the other way reverses the Shove-it', () => {
  const a = perform([scoop({ dir: 1 })]);
  const b = perform([scoop({ dir: -1 })]);
  assert.ok(Math.sign(a.spin.y) !== Math.sign(b.spin.y), `${show(a)} vs ${show(b)}`);
});

test('a rail flick and an opposing scoop make a varial or a 360 Flip', () => {
  // The two fingers have to scrape in OPPOSITE directions to make a couple.
  // Both pushing the same way just shoves the board sideways, which is exactly
  // what happens on a real board and is why varials take two hands.
  const r = perform([railFlick({ dir: 1 }), scoop({ dir: -1, at: 0.12 })]);
  assert.match(r.trick.name, /Varial Kickflip|360 Flip|Hardflip|540 Flip/, show(r));
  assert.ok(r.spin.z < -0.7, 'the flip half must actually happen: ' + show(r));
  assert.ok(Math.abs(r.spin.y) > 0.25, 'the shove-it half must too: ' + show(r));
});

test('a slow drag out to the tail tip is an Impossible', () => {
  const r = perform([tipDrag()]);
  assert.equal(r.trick.name, 'Impossible', show(r));
  assert.ok(
    Math.abs(r.spin.x) > Math.abs(r.spin.z) * 3,
    'it should be pitch, not roll: ' + show(r),
  );
});

test('a fast finger skims where a slow one levers', () => {
  // The same path, taken quickly, must not pitch the board the same way: this
  // is what stops every flip from turning into an accidental nosedive.
  const slow = perform([tipDrag({ speed: 0.7 })]);
  const fast = perform([tipDrag({ speed: 2.7, hold: 0.12 })]);
  assert.ok(
    Math.abs(fast.spin.x) < Math.abs(slow.spin.x) * 0.6,
    `fast ${fast.spin.x.toFixed(2)} should pitch far less than slow ${slow.spin.x.toFixed(2)}`,
  );
});

test('two rail flicks in a row give a double flip', () => {
  const r = perform([
    railFlick({ at: 0.1, hold: 0.14, dir: 1 }),
    railFlick({ at: 0.42, hold: 0.14, dir: 1 }),
  ]);
  assert.ok(r.spin.z < -1.7, 'expected roughly two flips: ' + show(r));
});

test('planting both fingers stops the board dead', () => {
  const spinning = perform([railFlick({ dir: 1 })]);
  const caught = perform([railFlick({ dir: 1 }), ...catchBoard({ at: 0.55, hold: 0.7 })]);
  assert.ok(spinning.omega > 4, 'uncaught board should still be spinning: ' + spinning.omega.toFixed(2));
  assert.ok(
    caught.omega < 1.0,
    `a catch should stop it: ${caught.omega.toFixed(2)} rad/s (${show(caught)})`,
  );
  assert.ok(caught.fingers.caught, 'the catch should be recorded for scoring');
});

test('a catch holds the rotation where it was, so timing decides the landing', () => {
  // Times are in REAL seconds: in slow motion the flight lasts several of them,
  // and where in that window you plant your fingers is the whole skill.
  const early = perform([railFlick({ dir: 1 }), ...catchBoard({ at: 1.6, hold: 8 })]);
  const late = perform([railFlick({ dir: 1 }), ...catchBoard({ at: 5.0, hold: 6 })]);
  assert.ok(
    Math.abs(late.spin.z) > Math.abs(early.spin.z) + 0.2,
    `catching later should leave more rotation: early ${early.spin.z.toFixed(2)}, late ${late.spin.z.toFixed(2)}`,
  );
});

test('the same finger path gives the same trick at any frame rate', () => {
  const recipe = [railFlick({ at: 0.1, hold: 0.15, dir: 1 })];
  const results = [144, 90, 60, 30].map((fps) => perform(recipe, { fps }));
  const rolls = results.map((r) => r.spin.z);
  const spread = Math.max(...rolls) - Math.min(...rolls);
  assert.ok(
    spread < 0.2,
    `flip amount must not depend on frame rate: ${rolls.map((v) => v.toFixed(2)).join(', ')}`,
  );
  const names = new Set(results.map((r) => r.trick.name));
  assert.equal(names.size, 1, `named differently across frame rates: ${[...names].join(' / ')}`);
});

test('input stays responsive however slow the world is', () => {
  // The premise of the whole mechanic: an identical real-time flick delivers an
  // identical spin rate whatever the world time scale is. What slow motion buys
  // the player is real seconds to act in, not extra force.
  const fast = perform([railFlick({ dir: 1 })], { timeScale: 1 });
  const slow = perform([railFlick({ dir: 1 })], { timeScale: 0.13 });

  assert.ok(
    Math.abs(fast.spin.z - slow.spin.z) < 0.12,
    `the flick must not care about time scale: ${fast.spin.z.toFixed(2)} vs ${slow.spin.z.toFixed(2)}`,
  );
  assert.ok(
    slow.realTime > fast.realTime * 4,
    `slow motion must widen the real-time window: ${fast.realTime.toFixed(2)}s vs ${slow.realTime.toFixed(2)}s`,
  );
});

test('a gentle flick under-rotates and a firm one completes', () => {
  const soft = perform([railFlick({ hold: 0.05, dir: 1 })]);
  const firm = perform([railFlick({ hold: 0.14, dir: 1 })]);
  assert.ok(Math.abs(soft.spin.z) < 0.6, 'a tap should not complete a flip: ' + show(soft));
  assert.ok(Math.abs(firm.spin.z) > 0.85, 'a committed flick should: ' + show(firm));
});

test('every trick in the table has a unique rotation signature', () => {
  const seen = new Map();
  for (const t of TRICK_TABLE()) {
    const key = `${t.roll}|${t.yaw}|${t.pitch}`;
    assert.ok(!seen.has(key), `${t.name} collides with ${seen.get(key)}`);
    seen.set(key, t.name);
  }
});

function TRICK_TABLE() {
  // Imported lazily so the table stays the single source of truth.
  return require_tricks();
}

let _tricks;
function require_tricks() {
  if (!_tricks) {
    _tricks = globalThis.__TRICKS__;
  }
  return _tricks;
}

// Populate the table reference without a circular import.
const { TRICKS } = await import('../src/sim/Tricks.js');
globalThis.__TRICKS__ = TRICKS;

test('config exposes every value the brief asks to be tunable', () => {
  const required = [
    'nail.timeScale',
    'nail.enterDuration',
    'nail.exitDuration',
    'nail.meterMax',
    'fingers.forceScale',
    'fingers.catchDamping',
    'board.invInertia',
    'landing.perfectTiltDeg',
    'landing.cleanTiltDeg',
    'score.comboStep',
    'camera.trickMinDistance',
    'camera.trickMaxDistance',
    'camera.trickFitLongAxis',
    'camera.trickFitShortAxis',
    'camera.trickFov',
  ];
  for (const path of required) {
    const value = path.split('.').reduce((o, k) => (o ? o[k] : undefined), Config);
    assert.notEqual(value, undefined, `Config.${path} is missing`);
  }
});
