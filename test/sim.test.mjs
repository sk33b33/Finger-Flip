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
import {
  groundHeight,
  groundNormal,
  groundSlopeZ,
  isLip,
  getFeatures,
  featureHeightAt,
} from '../src/sim/Park.js';
import Skater from '../src/sim/Skater.js';

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

test('the park never drops away under a rider without being a lip', () => {
  // The property that matters: the ground may rise as steeply as it likes —
  // that is a transition or a wall, and the rider decelerates against it — but
  // it must never fall away from under them except at a lip, which is exactly
  // what launches them. A surprise drop is a landing the player cannot read.
  let worst = 0;
  let worstAt = 0;
  for (const x of [-3.4, 0, 3.4]) {
    for (let z = 0; z < 220; z += 0.05) {
      const a = groundHeight(x, z);
      const b = groundHeight(x, z + 0.05);
      if (b >= a) continue; // rising ground is fine
      if (isLip(x, z)) continue; // an intentional launch edge
      if (a - b > worst) {
        worst = a - b;
        worstAt = z;
      }
    }
  }
  assert.ok(worst < 0.06, `surprise drop of ${worst.toFixed(3)}m at z=${worstAt.toFixed(2)}`);
});

test('the run loops seamlessly', () => {
  // The lap descends and climbs back, so the property that matters is that it
  // arrives back at exactly the height it started — a step at the seam would be
  // a wall appearing out of nowhere every lap — and that it gets there smoothly
  // rather than snapping in the last metre.
  assert.equal(groundHeight(0, 0), 0);
  assert.equal(groundHeight(0, 0), groundHeight(0, 220));
  assert.ok(
    Math.abs(groundHeight(0, 219.9)) < 0.002,
    `ground is ${groundHeight(0, 219.9).toFixed(4)}m off the seam height just before it`,
  );
});

test('the lap descends and recovers', () => {
  // The shape the terrain is meant to have: flat off the seam, a clear drop, a
  // level stretch, then back to where it started.
  const at = (z) => groundHeight(0, z) - featureHeightAt(0, z);
  assert.equal(at(10), 0, 'should be flat off the seam');
  assert.ok(at(120) < -2.5, `should have dropped by the level section, got ${at(120).toFixed(2)}`);
  assert.ok(Math.abs(at(120) - at(140)) < 0.05, 'the level section should be level');
  assert.ok(at(219) > -0.1, `should be back at the seam height, got ${at(219).toFixed(2)}`);
});

test('the descent never reads as a launch lip', () => {
  // isLip treats a drop steeper than a 0.2 grade as a takeoff edge. A downhill
  // above that would put the rider permanently airborne, so the bare terrain
  // has to stay well under it.
  for (let z = 0; z < 220; z += 0.25) {
    if (featureHeightAt(0, z) > 0.02) continue; // built features may be lips
    assert.ok(!isLip(0, z, 0.5), `bare terrain at z=${z.toFixed(1)} reads as a lip`);
  }
});

test('the park has launchable lips spread through the run', () => {
  const lips = [];
  for (let z = 0; z < 220; z += 0.25) {
    if (isLip(0, z, 0.5) && !isLip(0, z + 0.25, 0.5)) lips.push(z);
  }
  assert.ok(lips.length >= 5, `expected several launch lips, found ${lips.length}`);
  // Spread out, not bunched: the rider needs run-up between features.
  for (let i = 1; i < lips.length; i++) {
    assert.ok(lips[i] - lips[i - 1] > 8, `lips at ${lips[i - 1]} and ${lips[i]} are too close`);
  }
});

test('a kicker face tilts its normal back at the rider', () => {
  const n = groundNormal(0, 31, new Vector3());
  assert.ok(n.z < -0.2, `kicker normal ${n.z.toFixed(2)} should lean backwards`);
});

test('the quarterpipe steepens toward its lip', () => {
  // A transition is defined by its curve: shallow at the bottom, near vertical
  // at the top. A constant slope would just be a bank.
  // Sampled inside the transition, which spans z 66 to its lip just under 68.
  const low = groundSlopeZ(0, 66.6);
  const high = groundSlopeZ(0, 67.8);
  assert.ok(low > 0.1, `the base should already rise, got ${low.toFixed(2)}`);
  assert.ok(high > low * 2, `the lip should be far steeper: ${low.toFixed(2)} -> ${high.toFixed(2)}`);
});

test('the landing bank of the gap slopes away from the rider', () => {
  // You land on it and ride down; if its normal pointed back at you it would
  // be a wall, and every gap attempt would be a slam.
  const n = groundNormal(0, 138, new Vector3());
  assert.ok(n.z > 0.2, `landing bank normal ${n.z.toFixed(2)} should lean away`);
});

test('the hip has two peaks with a saddle between them', () => {
  const left = groundHeight(-3.4, 182);
  const middle = groundHeight(0, 182);
  const right = groundHeight(3.4, 182);
  assert.ok(left > middle + 0.3, `left peak ${left.toFixed(2)} vs saddle ${middle.toFixed(2)}`);
  assert.ok(right > middle + 0.3, `right peak ${right.toFixed(2)} vs saddle ${middle.toFixed(2)}`);
  assert.ok(Math.abs(left - right) < 0.01, 'the hip should be symmetric');
});

function fmt(v) {
  return `pitch ${v.x.toFixed(2)} yaw ${v.y.toFixed(2)} roll ${v.z.toFixed(2)}`;
}

// --------------------------------------------------------------- flight ----

/**
 * Roll the rider up to a feature the way the game does — accelerating along the
 * ground, decelerating against the slope — and launch them off its lip.
 * Teleporting them to the lip at cruise speed would skip the climb, which is
 * exactly the part that got hard when the rolling speed was halved.
 */
function runUpTo(lipZ, charge, { from = lipZ - 22 } = {}) {
  const s = new Skater();
  s.reset(from);
  s.speed = Config.skater.maxSpeed;
  const controls = { steer: 0, push: 1, brake: 0, charging: false };
  const dt = 1 / 240;

  let stalled = false;
  for (let i = 0; i < 40000; i++) {
    s.step(dt, controls);
    if (s.position.z >= lipZ) break;
    if (s.speed <= 0.6) {
      stalled = true;
      break;
    }
  }
  const arrivedAt = s.speed;
  if (stalled) return { stalled, arrivedAt, z: s.position.z };

  s.takeOff(charge, 0);
  for (let i = 0; i < 4000; i++) {
    s.stepAir(dt);
    if (s.checkTouchdown()) break;
  }
  return {
    stalled: false,
    arrivedAt,
    land: s.position.z,
    carried: s.position.z - lipZ,
    airTime: s.airTime,
    peak: s.peakHeight,
  };
}

test('every feature is climbable at the rolling speed', () => {
  // A rider at cruise can only rise v^2 / 2g before stalling. Halving the
  // rolling speed halved that budget, which is what makes this a real
  // constraint on the park rather than a note: build a feature taller than the
  // budget and it stops being a ramp and becomes a wall.
  const budget = (Config.skater.maxSpeed * Config.skater.maxSpeed) / (2 * -Config.sim.gravity);
  for (const f of getFeatures()) {
    assert.ok(
      f.height < budget * 0.92,
      `${f.type} at z=${f.z0} is ${f.height}m, but the rider can only climb ` +
        `${budget.toFixed(2)}m at ${Config.skater.maxSpeed} m/s`,
    );
  }
});

test('the rider reaches every lip with speed left over', () => {
  // The arithmetic above is necessary but not sufficient: rolling friction and
  // the shape of the approach also cost speed.
  for (const lip of [31.95, 54, 68, 112.3, 129, 160.45, 182.95]) {
    const r = runUpTo(lip, 0.5);
    assert.ok(!r.stalled, `stalled short of the lip at z=${lip} (reached ${r.z?.toFixed(1)})`);
    assert.ok(
      r.arrivedAt > 2.0,
      `crawled onto the lip at z=${lip} with only ${r.arrivedAt.toFixed(2)} m/s`,
    );
  }
});

test('the rider still clears the bank-to-bank gap at the halved rolling speed', () => {
  // Bank one's lip is at z=129 and bank two's face starts at 133.6. Halving the
  // rolling speed halved the horizontal carry, so this is the feature most at
  // risk from that change.
  const weak = runUpTo(129, 0.35);
  const full = runUpTo(129, 1.0);
  assert.ok(
    weak.land > 133.6,
    `a weak pop should still reach the far bank: landed at ${weak.land.toFixed(1)}`,
  );
  assert.ok(full.carried > weak.carried, 'a full pop should carry further than a weak one');
});

test('halving the rolling speed did not collapse hangtime', () => {
  // Air time comes mostly from the pop, not the ramp, so it should barely have
  // moved. If this drops, the trick window has quietly shrunk with it.
  const big = runUpTo(160.45, 1.0);
  assert.ok(big.airTime > 1.0, `expected real hangtime, got ${big.airTime.toFixed(2)}s`);
  assert.ok(big.peak > 1.6, `expected real height, got ${big.peak.toFixed(2)}m`);
});

test('a transition cannot launch the rider out of the park', () => {
  // A quarterpipe steepens toward vertical, and an uncapped slope-to-lift term
  // there multiplied into a 10m launch. The cap is what keeps it a skatepark.
  const quarter = runUpTo(68, 1.0);
  assert.ok(quarter.peak < 4.5, `quarterpipe launched to ${quarter.peak.toFixed(1)}m`);
});

/**
 * Rolls the rider along the lane's shoulder, out past every feature's
 * half-width, so what is under the wheels is the terrain and nothing else.
 * Riding the centreline instead measures the plateau and the banks pumping
 * speed, which is a different question.
 */
function rollShoulder(fromZ, toZ, startSpeed) {
  const s = new Skater();
  s.reset(fromZ);
  s.position.x = 8.5; // outside the widest feature (the roller, at 8.0)
  s.position.y = groundHeight(s.position.x, s.position.z);
  s.speed = startSpeed;
  const controls = { steer: 0, push: 1, brake: 0, charging: false };
  let peak = 0;
  for (let i = 0; i < 60000 && s.position.z < toZ; i++) {
    s.step(1 / 240, controls);
    peak = Math.max(peak, s.speed);
  }
  return { speed: s.speed, peak, z: s.position.z };
}

test('the descent gives speed back without running away with the game', () => {
  // Gravity along the descent outruns rolling friction roughly five to one, so
  // without a ceiling the rider spends a third of every lap pinned at the cap
  // and the speedo never shows the speed the game is tuned around.
  const S = Config.skater;
  const down = rollShoulder(36, 84, S.maxSpeed);
  assert.ok(
    down.peak > S.maxSpeed * 1.02,
    `the descent should be worth free speed, got ${down.peak.toFixed(2)}`,
  );
  assert.ok(
    down.peak <= S.maxSpeed * S.overspeed + 1e-6,
    `the descent hit ${(down.peak * 3.6).toFixed(0)} km/h, over the ceiling`,
  );

  // And the level stretch that follows hands it back, so the number the player
  // reads for most of the lap is the cruise.
  const level = rollShoulder(86, 144, down.speed);
  assert.ok(
    Math.abs(level.speed - S.maxSpeed) < 0.1,
    `expected the level stretch to settle at cruise, got ${level.speed.toFixed(2)}`,
  );
});

test('the recovery climb never stalls the rider', () => {
  // The haul back to the seam is shallower than the descent, but it is 75m of
  // it. A rider who arrives at the seam crawling has a bad first feature.
  const up = rollShoulder(146, 219, Config.skater.maxSpeed * 0.75);
  assert.ok(
    up.speed > Config.skater.maxSpeed * 0.85,
    `crawled to the seam at ${up.speed.toFixed(2)} m/s`,
  );
});
