/**
 * Grabs and body spin.
 *
 *   node --test test/grabs.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Vector3 } from 'three';

import GrabTracker, { classify, GRABS } from '../src/sim/Grabs.js';
import FingerFlipController from '../src/sim/Fingers.js';
import Skater from '../src/sim/Skater.js';
import { recognise, fullName, quantiseBodySpin } from '../src/sim/Tricks.js';
import { perform, railFlick } from './harness.mjs';
import Config from '../src/core/Config.js';

// ------------------------------------------------------------- zones ------

test('holding a rail between the trucks is an Indy or a Melon', () => {
  assert.equal(classify({ x: 0.09, z: 0 }), 'INDY');
  assert.equal(classify({ x: -0.09, z: 0 }), 'MELON');
});

test('holding a rail forward of the front truck is a Mute', () => {
  assert.equal(classify({ x: 0.09, z: 0.18 }), 'MUTE');
});

test('holding the heel rail behind the back truck is a Stalefish', () => {
  assert.equal(classify({ x: -0.09, z: -0.18 }), 'STALEFISH');
});

test('holding a tip is a Nosegrab or a Tailgrab', () => {
  assert.equal(classify({ x: 0, z: 0.36 }), 'NOSE');
  assert.equal(classify({ x: 0, z: -0.36 }), 'TAIL');
});

test('holding the middle of the deck is a catch, not a grab', () => {
  assert.equal(classify({ x: 0, z: 0 }), null);
  assert.equal(classify({ x: 0.02, z: 0.1 }), null);
});

test('every grab in the table has a name and a score', () => {
  for (const [key, def] of Object.entries(GRABS)) {
    assert.ok(def.name, `${key} has no name`);
    assert.ok(def.base > 0, `${key} scores nothing`);
    assert.ok(def.difficulty >= 1, `${key} has no difficulty`);
  }
});

// ----------------------------------------------------------- tracking -----

/** Hold one finger at a fixed spot on the deck for `seconds` of real time. */
function hold(x, z, seconds, fps = 60) {
  const fingers = new FingerFlipController();
  const tracker = new GrabTracker();
  const f = fingers.fingers[0];
  f.contact = 1;
  f.localContact.set(x, 0, z);
  const dt = 1 / fps;
  for (let t = 0; t < seconds; t += dt) tracker.update(fingers, dt);
  return tracker;
}

test('a brief touch is not a grab', () => {
  const t = hold(0.09, 0, Config.grabs.minHold * 0.5);
  assert.equal(t.isGrabbing, false);
  assert.equal(t.best, null);
});

test('a sustained hold becomes a grab and keeps its duration', () => {
  const t = hold(0.09, 0, 1.2);
  assert.equal(t.isGrabbing, true);
  assert.equal(t.best, 'INDY');
  assert.ok(t.bestHold > 1.0, `held ${t.bestHold.toFixed(2)}s`);
  assert.equal(t.score().name, 'Indy');
  assert.ok(t.score().points > GRABS.INDY.base);
});

test('moving to a different zone restarts the hold', () => {
  const fingers = new FingerFlipController();
  const tracker = new GrabTracker();
  const f = fingers.fingers[0];
  f.contact = 1;
  const dt = 1 / 60;

  f.localContact.set(0.09, 0, 0); // indy
  for (let i = 0; i < 40; i++) tracker.update(fingers, dt);
  assert.equal(tracker.current, 'INDY');

  f.localContact.set(-0.09, 0, 0); // slid across to melon
  tracker.update(fingers, dt);
  assert.equal(tracker.current, 'MELON');
  assert.ok(tracker.currentHold < 0.05, 'the new hold should start from zero');
});

test('letting go ends the grab', () => {
  const fingers = new FingerFlipController();
  const tracker = new GrabTracker();
  const f = fingers.fingers[0];
  f.contact = 1;
  f.localContact.set(0.09, 0, 0);
  for (let i = 0; i < 40; i++) tracker.update(fingers, 1 / 60);
  assert.equal(tracker.isGrabbing, true);

  f.contact = 0;
  tracker.update(fingers, 1 / 60);
  assert.equal(tracker.isGrabbing, false);
  // But the flight still remembers the best grab, for scoring.
  assert.equal(tracker.best, 'INDY');
});

test('a longer grab scores more than a shorter one', () => {
  const short = hold(0.09, 0, 0.5).score();
  const long = hold(0.09, 0, 2.5).score();
  assert.ok(long.points > short.points * 1.3, `${short.points} -> ${long.points}`);
});

test('grab scoring saturates so it cannot beat working the board', () => {
  const long = hold(0.09, 0, Config.grabs.maxScoringHold).score();
  const forever = hold(0.09, 0, Config.grabs.maxScoringHold * 3).score();
  assert.equal(long.points, forever.points);
});

// ---------------------------------------------------------- body spin -----

test('popping straight gives no body spin', () => {
  const s = new Skater();
  s.reset(4);
  s.takeOff(1, 0);
  assert.equal(s.spinRate, 0);
});

test('popping out of a carve carries the rotation into the air', () => {
  const s = new Skater();
  s.reset(4);
  s.takeOff(1, 1);
  assert.ok(s.spinRate > 0, 'a full carve should wind up a spin');

  const other = new Skater();
  other.reset(4);
  other.takeOff(1, -1);
  assert.ok(other.spinRate < 0, 'carving the other way should spin the other way');
});

test('a nudge of steer is not enough to spin', () => {
  const s = new Skater();
  s.reset(4);
  s.takeOff(1, Config.pop.bodySpinDeadzone * 0.5);
  assert.equal(s.spinRate, 0, 'small steering corrections must not become spins');
});

test('body spin accumulates in the air and flips the stance on a half turn', () => {
  const s = new Skater();
  s.reset(4);
  s.position.y = 3;
  s.takeOff(1, 1);
  // Run just long enough to sweep half a turn.
  const target = Math.PI / s.spinRate;
  for (let t = 0; t < target; t += 1 / 240) s.stepAir(1 / 240);
  assert.ok(Math.abs(s.airYaw - 0.5) < 0.06, `airYaw ${s.airYaw.toFixed(3)} turns`);

  const wasFakie = s.fakie;
  s.velocity.y = -1;
  s.land(false);
  assert.notEqual(s.fakie, wasFakie, 'a 180 should land you switch');
});

// --------------------------------------------------------- trick names ----

test('the full call reads the way a skater would say it', () => {
  const kickflip = recognise({ x: 0, y: 0, z: -1 });
  assert.equal(fullName(kickflip, null, 0), 'Kickflip');
  assert.equal(fullName(kickflip, 'Indy', 0), 'Kickflip Indy');
  assert.equal(fullName(kickflip, 'Indy', 1), 'Kickflip Indy 360');
  assert.equal(fullName(kickflip, null, -0.5), 'Kickflip 180');
});

test('an ollie with a grab is called by the grab alone', () => {
  const ollie = recognise({ x: 0, y: 0, z: 0 });
  assert.equal(fullName(ollie, 'Melon', 0), 'Melon');
  assert.equal(fullName(ollie, null, 0), 'Ollie');
});

test('body spin is named in half turns', () => {
  assert.equal(quantiseBodySpin(0.48), 0.5);
  assert.equal(quantiseBodySpin(0.9), 1);
  assert.equal(quantiseBodySpin(0.1), 0);
});

// ---------------------------------------------------- grabs in a flight ---

test('flick first, then grab: the grab holds the rotation where you took it', () => {
  // A grab IS a catch held long enough to have a name, so the order matters
  // exactly as it does on a real board: flick, let it come round, then grab.
  const flickOnly = perform([railFlick({ dir: 1 })]);
  const flickThenGrab = perform([
    railFlick({ dir: 1 }),
    { finger: 0, at: 5.0, hold: 4, across: 0.085, along: -0.05, plant: true },
  ]);

  assert.ok(
    Math.abs(flickThenGrab.spin.z) > 0.6,
    'the flip must complete before the grab takes hold: ' + flickThenGrab.spin.z.toFixed(2),
  );
  assert.ok(
    flickThenGrab.omega < flickOnly.omega * 0.4,
    `the grab should still the board: ${flickOnly.omega.toFixed(2)} -> ${flickThenGrab.omega.toFixed(2)}`,
  );
  assert.equal(classify(new Vector3(0.085, 0, -0.05)), 'INDY');
});

test('grabbing too early kills the flip before it happens', () => {
  const early = perform([
    railFlick({ dir: 1 }),
    { finger: 0, at: 0.4, hold: 4, across: 0.085, along: -0.05, plant: true },
  ]);
  assert.ok(
    Math.abs(early.spin.z) < 0.5,
    'grabbing on top of the flick should smother it: ' + early.spin.z.toFixed(2),
  );
});
