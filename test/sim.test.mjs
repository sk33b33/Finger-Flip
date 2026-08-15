/**
 * Headless simulation tests. The sim layer never imports the renderer, so the
 * whole trick pipeline can be driven and graded from Node.
 *
 *   node --test test/sim.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Vector3, Quaternion } from 'three';

import Board from '../src/sim/Board.js';
import FingerFlipController from '../src/sim/Fingers.js';
import { recognise } from '../src/sim/Tricks.js';
import { evaluateLanding, Quality } from '../src/sim/Landing.js';
import Config from '../src/core/Config.js';
import { groundHeight, groundNormal, isLip } from '../src/sim/Park.js';

const STANCE = new Quaternion(); // identity: board travelling down +Z, level
const REAL_DT = 1 / 60;
const HALF_W = Config.board.width * 0.5;

/**
 * Drives the board through one flight with a scripted finger script.
 *
 * @param {Array<{t:number, finger:'left'|'right', along:number, across:number,
 *                vAcross:number, vAlong:number}>} script
 *        Entries are held from their `t` (real seconds) until the next entry.
 *        A missing entry means both fingers are off the board.
 */
function flight(script, { airTime = 0.95, timeScale = 0.13 } = {}) {
  const board = new Board();
  board.reset(new Vector3(0, 1.2, 0), 0);
  board.airborne = true;
  board.velocity.set(0, 4.6, 9);

  const fingers = new FingerFlipController();
  const samples = [];

  let worldT = 0;
  let realT = 0;
  let guard = 0;
  while (worldT < airTime && guard++ < 20000) {
    // Fingers are driven in REAL time, the world in scaled time.
    for (const f of fingers.fingers) {
      f.active = false;
      f.vel.set(0, 0, 0);
    }
    const active = script.filter((s) => realT >= s.t && realT < s.t + (s.dur ?? 0.12));
    for (const s of active) {
      const f = s.finger === 'left' ? fingers.left : fingers.right;
      f.active = true;
      const local = realT - s.t;
      f.pos.set(s.across + (s.vAcross ?? 0) * local, 0, s.along + (s.vAlong ?? 0) * local);
      f.vel.set(s.vAcross ?? 0, 0, s.vAlong ?? 0);
    }

    fingers.update(board, STANCE, REAL_DT, worldT / airTime);

    const worldDt = REAL_DT * timeScale;
    let remaining = worldDt;
    while (remaining > 1e-9) {
      const step = Math.min(Config.sim.fixedStep, remaining);
      board.step(step);
      remaining -= step;
      worldT += step;
    }
    realT += REAL_DT;
    samples.push({ realT, worldT, spin: board.spin.clone(), w: board.angularVelocity.length() });
  }
  return { board, fingers, samples, realT, worldT };
}

test('a flick off the toe edge of the nose produces a kickflip', () => {
  // Finger starts just toe-side of the centreline near the nose and slides out
  // over the rail, exactly like a front-foot flick.
  const { board } = flight([
    { t: 0.1, finger: 'right', along: 0.3, across: 0.0, vAcross: 2.6, dur: 0.16 },
  ]);

  assert.ok(
    board.spin.z < -0.6,
    `expected roll toward the kickflip side, got ${board.spin.z.toFixed(3)} turns`,
  );
  const trick = recognise(board.spin);
  assert.match(trick.name, /Kickflip/, `named "${trick.name}" (spin ${fmt(board.spin)})`);
});

test('the same flick off the heel edge produces a heelflip', () => {
  const { board } = flight([
    { t: 0.1, finger: 'right', along: 0.3, across: 0.0, vAcross: -2.6, dur: 0.16 },
  ]);
  assert.ok(board.spin.z > 0.6, `expected positive roll, got ${board.spin.z.toFixed(3)}`);
  assert.match(recognise(board.spin).name, /Heelflip/);
});

test('a symmetric scoop across the tail produces a shove-it, not a flip', () => {
  // The scoop stays centred on the deck, so the roll arm sweeps symmetrically
  // through zero and cancels, leaving only the scrape's yaw torque. Drag past
  // the rail instead and it turns into a varial, exactly like real life.
  const { board } = flight([
    { t: 0.1, finger: 'left', along: -0.3, across: -0.062, vAcross: 1.9, dur: 0.065 },
  ]);
  assert.ok(
    Math.abs(board.spin.y) > 3 * Math.abs(board.spin.z),
    `yaw ${board.spin.y.toFixed(2)} should dominate roll ${board.spin.z.toFixed(2)}`,
  );
});

test('pressing the very tip of the tail pitches the board (the pop)', () => {
  const { board } = flight([
    { t: 0.1, finger: 'left', along: -0.38, across: 0, vAcross: 0, dur: 0.25 },
  ]);
  assert.ok(board.spin.x < -0.1, `expected nose-up pitch, got ${board.spin.x.toFixed(3)}`);
});

test('a planted finger catches a spinning board', () => {
  const board = new Board();
  board.reset(new Vector3(0, 1.2, 0), 0);
  board.airborne = true;
  board.angularVelocity.set(0, 0, 8); // spinning hard

  const fingers = new FingerFlipController();
  fingers.left.active = true;
  fingers.left.pos.set(0, 0, -0.28);
  fingers.left.prevPos.copy(fingers.left.pos);
  fingers.left.vel.set(0, 0, 0);
  fingers.right.active = true;
  fingers.right.pos.set(0, 0, 0.28);
  fingers.right.prevPos.copy(fingers.right.pos);
  fingers.right.vel.set(0, 0, 0);

  const before = board.angularVelocity.length();
  for (let i = 0; i < 30; i++) {
    fingers.update(board, STANCE, REAL_DT, 0.7);
    board.step(REAL_DT * 0.13);
  }
  const after = board.angularVelocity.length();
  assert.ok(after < before * 0.35, `catch should kill spin: ${before.toFixed(2)} -> ${after.toFixed(2)}`);
  assert.ok(fingers.caught, 'catch should be recorded for scoring');
});

test('a flat, aligned, still board lands PERFECT', () => {
  const board = new Board();
  board.reset(new Vector3(0, 0, 20), 0);
  const r = evaluateLanding(board, new Vector3(0, 1, 0), new Vector3(0, 0, 1), new Vector3(0, 0, 20));
  assert.equal(r.quality, Quality.PERFECT, r.reasons.join(', '));
});

test('landing switch (nose pointing backwards) is legal, not a bail', () => {
  const board = new Board();
  board.reset(new Vector3(0, 0, 20), Math.PI);
  const r = evaluateLanding(board, new Vector3(0, 1, 0), new Vector3(0, 0, 1), new Vector3(0, 0, 20));
  assert.equal(r.quality, Quality.PERFECT);
  assert.equal(r.fakie, true);
});

test('landing upside down bails', () => {
  const board = new Board();
  board.reset(new Vector3(0, 0, 20), 0);
  board.quaternion.setFromAxisAngle(new Vector3(0, 0, 1), Math.PI);
  const r = evaluateLanding(board, new Vector3(0, 1, 0), new Vector3(0, 0, 1), new Vector3(0, 0, 20));
  assert.equal(r.quality, Quality.BAIL);
});

test('a board still spinning at touchdown bails', () => {
  const board = new Board();
  board.reset(new Vector3(0, 0, 20), 0);
  board.angularVelocity.set(0, 0, 12);
  const r = evaluateLanding(board, new Vector3(0, 1, 0), new Vector3(0, 0, 1), new Vector3(0, 0, 20));
  assert.equal(r.quality, Quality.BAIL);
  assert.ok(r.reasons.some((s) => /caught/i.test(s)));
});

test('trick recogniser names combined rotations', () => {
  assert.equal(recognise({ x: 0, y: -1, z: -1 }).name, '360 Flip');
  assert.equal(recognise({ x: 0, y: -0.5, z: -1 }).name, 'Varial Kickflip');
  assert.equal(recognise({ x: -1, y: 0, z: 0 }).name, 'Impossible');
  assert.equal(recognise({ x: 0, y: 0, z: 0.02 }).name, 'Ollie');
  // Outside the table it still composes something sensible.
  assert.match(recognise({ x: 0, y: -2, z: -4 }).name, /Quad Kickflip/);
});

test('park geometry is continuous and has launchable lips', () => {
  // Ramp faces must be smooth so the surface normal never jumps mid-landing.
  // Lips are allowed to be cliffs: that is what launches the rider.
  let maxJump = 0;
  for (let z = 0; z < 220; z += 0.05) {
    const a = groundHeight(0, z);
    const b = groundHeight(0, z + 0.05);
    const step = Math.abs(b - a);
    if (b < a && isLip(0, z)) continue; // an intentional lip
    maxJump = Math.max(maxJump, step);
  }
  assert.ok(maxJump < 0.06, `ramp face has a ${maxJump.toFixed(3)}m step per 5cm`);
  assert.ok(groundHeight(0, 0) === 0 && groundHeight(0, 219.9) === 0, 'run must loop seamlessly');

  let lips = 0;
  for (let z = 0; z < 220; z += 0.5) if (isLip(0, z)) lips++;
  assert.ok(lips > 4, `expected several launch lips, found ${lips}`);

  const n = groundNormal(0, 68, new Vector3());
  assert.ok(n.z < -0.2, 'the kicker face should tilt its normal backwards');
});

function fmt(v) {
  return `pitch ${v.x.toFixed(2)} yaw ${v.y.toFixed(2)} roll ${v.z.toFixed(2)}`;
}
