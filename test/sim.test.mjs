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
import { evaluateLanding, predictTouchdown, Quality } from '../src/sim/Landing.js';
import Config from '../src/core/Config.js';
import { nailScale } from '../src/core/GameTime.js';
import {
  runLength,
  groundHeight,
  groundNormal,
  groundSlopeZ,
  isLip,
  getFeatures,
  featureHeightAt,
  terrainHeight,
  setLayout,
  listLayouts,
} from '../src/sim/Park.js';
import Skater from '../src/sim/Skater.js';

const STANCE = new Quaternion(); // identity: board travelling down +Z, level
const REAL_DT = 1 / 60;
const HALF_W = Config.board.width * 0.5;

/**
 * Runs a check against every park, then puts the default one back.
 *
 * The layout is module state in sim/Park.js, so a test that switches it and
 * walks away poisons everything after it. This is the only sanctioned way to
 * change parks in the suite.
 */
function forEachLayout(fn) {
  try {
    for (const layout of listLayouts()) {
      setLayout(layout.id);
      fn(layout);
    }
  } finally {
    setLayout('funrun');
  }
}

/** Trailing edges of every launch lip in the park currently loaded. */
function findLips(step = 0.25) {
  const lips = [];
  const run = runLength();
  for (let z = 0; z < run; z += step) {
    if (isLip(0, z, 0.5) && !isLip(0, z + step, 0.5)) lips.push(z);
  }
  return lips;
}

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

test('a flat board still turning rides away, badly', () => {
  // The deal with the player is that straightening the deck before the wheels
  // touch is enough. A board that has come round flat but is still turning
  // THROUGH flat has been straightened out, so it lands — scruffily, for a
  // fraction of the points, but it lands. This used to slam.
  const board = new Board();
  board.reset(new Vector3(0, 0, 20), 0);
  board.angularVelocity.set(0, 0, 12);
  const r = evaluateLanding(board, new Vector3(0, 1, 0), new Vector3(0, 0, 1), new Vector3(0, 0, 20));
  assert.notEqual(r.quality, Quality.BAIL, 'a level deck should not slam on spin alone');
  assert.equal(r.quality, Quality.SLAM, `expected a scruffy landing, got ${r.quality}`);
  assert.ok(r.reasons.some((s) => /caught/i.test(s)), 'and it should still say why it scored badly');
});

test('a board spinning wildly at touchdown still bails', () => {
  // Generous is not infinite. Past the threshold there is no landing it.
  const board = new Board();
  board.reset(new Vector3(0, 0, 20), 0);
  board.angularVelocity.set(0, 0, Config.landing.bailSpin + 3);
  const r = evaluateLanding(board, new Vector3(0, 1, 0), new Vector3(0, 0, 1), new Vector3(0, 0, 20));
  assert.equal(r.quality, Quality.BAIL);
});

test('an upside-down board bails however still it is', () => {
  // The one unconditional bail left: a deck landing inverted is definitively
  // not "straightened out", so no amount of relaxing the other terms saves it.
  const board = new Board();
  board.reset(new Vector3(0, 0, 20), 0);
  board.quaternion.setFromAxisAngle(new Vector3(0, 0, 1), Math.PI);
  board.angularVelocity.set(0, 0, 0);
  const r = evaluateLanding(board, new Vector3(0, 1, 0), new Vector3(0, 0, 1), new Vector3(0, 0, 20));
  assert.equal(r.quality, Quality.BAIL);
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

test('every run loops seamlessly', () => {
  // Each lap climbs back to exactly the height it started — a step at the seam
  // would be a wall appearing out of nowhere every lap — and gets there
  // smoothly rather than snapping in the last metre.
  forEachLayout(({ id, runLength: run }) => {
    assert.equal(groundHeight(0, 0), 0, `${id} does not start at zero`);
    assert.equal(groundHeight(0, 0), groundHeight(0, run), `${id} steps at the seam`);
    assert.ok(
      Math.abs(groundHeight(0, run - 0.1)) < 0.002,
      `${id} is ${groundHeight(0, run - 0.1).toFixed(4)}m off the seam height just before it`,
    );
  });
});

test('the Fun Run lap descends and recovers', () => {
  setLayout('funrun');
  // The shape the terrain is meant to have: flat off the seam, a clear drop, a
  // level stretch, then back to where it started.
  const at = (z) => groundHeight(0, z) - featureHeightAt(0, z);
  assert.equal(at(10), 0, 'should be flat off the seam');
  assert.ok(at(120) < -2.5, `should have dropped by the level section, got ${at(120).toFixed(2)}`);
  assert.ok(Math.abs(at(120) - at(140)) < 0.05, 'the level section should be level');
  assert.ok(at(219) > -0.1, `should be back at the seam height, got ${at(219).toFixed(2)}`);
});

test('terrain is never a launch lip, however steep', () => {
  // isLip measures the BUILT structure, not the ground: you launch off the end
  // of a ledge, not off a hillside. Keyed off absolute height instead, any
  // terrain past a 0.2 grade read as one continuous lip and the rider was
  // permanently airborne — which capped how steep a hill could be and made
  // bowls impossible.
  forEachLayout(({ id, runLength: run }) => {
    for (let z = 0; z < run; z += 0.25) {
      if (featureHeightAt(0, z) > 0.02) continue; // built features may be lips
      assert.ok(!isLip(0, z, 0.5), `${id}: bare terrain at z=${z.toFixed(1)} reads as a lip`);
    }
  });
});

test('every park has launchable lips spread through the run', () => {
  forEachLayout(({ id }) => {
    const lips = findLips();
    assert.ok(lips.length >= 4, `${id}: expected several launch lips, found ${lips.length}`);
    // Spread out, not bunched: the rider needs run-up between features.
    for (let i = 1; i < lips.length; i++) {
      assert.ok(
        lips[i] - lips[i - 1] > 8,
        `${id}: lips at ${lips[i - 1]} and ${lips[i]} are too close`,
      );
    }
  });
});

test('a kicker face tilts its normal back at the rider', () => {
  setLayout('funrun');
  const n = groundNormal(0, 31, new Vector3());
  assert.ok(n.z < -0.2, `kicker normal ${n.z.toFixed(2)} should lean backwards`);
});

test('the quarterpipe steepens toward its lip', () => {
  // A transition is defined by its curve: shallow at the bottom, near vertical
  // at the top. A constant slope would just be a bank.
  // Sampled inside the transition, which spans z 66 to its lip just under 68.
  setLayout('funrun');
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
 * exactly the part that changes whenever the rolling speed is retuned.
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

test('every feature in every park is climbable at the rolling speed', () => {
  // A rider at cruise can only rise v^2 / 2g before stalling, so a feature
  // taller than that budget is not a ramp, it is a wall. This is the single
  // constraint that governs how big anything in a layout may be.
  const budget = (Config.skater.maxSpeed * Config.skater.maxSpeed) / (2 * -Config.sim.gravity);
  forEachLayout(({ id }) => {
    for (const f of getFeatures()) {
      assert.ok(
        f.height < budget * 0.92,
        `${id}: ${f.type} at z=${f.z0} is ${f.height}m, but the rider can only climb ` +
          `${budget.toFixed(2)}m at ${Config.skater.maxSpeed} m/s`,
      );
    }
  });
});

test('the rider reaches every lip in every park with speed left over', () => {
  // The climb budget is necessary but not sufficient: rolling friction, the
  // shape of the approach and whatever the terrain is doing underneath all cost
  // speed too. This is the test that actually rides each park.
  forEachLayout(({ id }) => {
    for (const lip of findLips()) {
      const r = runUpTo(lip, 0.5);
      assert.ok(!r.stalled, `${id}: stalled short of the lip at z=${lip} (reached ${r.z?.toFixed(1)})`);
      assert.ok(
        r.arrivedAt > 2.0,
        `${id}: crawled onto the lip at z=${lip} with only ${r.arrivedAt.toFixed(2)} m/s`,
      );
    }
  });
});

test('the rider clears the bank-to-bank gap', () => {
  setLayout('funrun');
  // Bank one's lip is at z=129 and bank two's face starts at 133.6. Horizontal
  // carry scales with the rolling speed, so this is the feature most at risk
  // whenever that is retuned in either direction.
  const weak = runUpTo(129, 0.35);
  const full = runUpTo(129, 1.0);
  assert.ok(
    weak.land > 133.6,
    `a weak pop should still reach the far bank: landed at ${weak.land.toFixed(1)}`,
  );
  assert.ok(full.carried > weak.carried, 'a full pop should carry further than a weak one');
});

test('retuning the rolling speed did not collapse hangtime', () => {
  setLayout('funrun');
  // Air time comes mostly from the pop, not the ramp, so it should barely move
  // when the speed does. If this drops, the trick window has shrunk with it.
  const big = runUpTo(160.45, 1.0);
  assert.ok(big.airTime > 1.0, `expected real hangtime, got ${big.airTime.toFixed(2)}s`);
  assert.ok(big.peak > 1.6, `expected real height, got ${big.peak.toFixed(2)}m`);
});

test('a transition cannot launch the rider out of the park', () => {
  setLayout('funrun');
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
  setLayout('funrun');
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
  setLayout('funrun');
  // The haul back to the seam is shallower than the descent, but it is 75m of
  // it. A rider who arrives at the seam crawling has a bad first feature.
  const up = rollShoulder(146, 219, Config.skater.maxSpeed * 0.75);
  assert.ok(
    up.speed > Config.skater.maxSpeed * 0.85,
    `crawled to the seam at ${up.speed.toFixed(2)} m/s`,
  );
});

test('the terrain never rises above the seam', () => {
  // The far ground is a sheet tracking terrainHeight() 6cm below it, and that
  // only stays under the park because features exclusively ADD height. If the
  // terrain ever rose above 0, the apron would cut through the flat ground at
  // the seam — which is the shape of the bug it replaced, where a slab three
  // metres above the descent hid the whole park the instant a trick lifted the
  // camera over its lid.
  forEachLayout(({ id, runLength: run }) => {
    assert.equal(terrainHeight(0), 0, `${id} does not start at zero`);
    assert.equal(terrainHeight(0), terrainHeight(run), `${id} steps at the seam`);
    for (let z = 0; z < run; z += 0.25) {
      assert.ok(
        terrainHeight(z) <= 1e-9,
        `${id}: terrain rose to ${terrainHeight(z).toFixed(3)} at z=${z}`,
      );
    }
  });
});

test('the terrain is the ground wherever nothing is built on it', () => {
  // groundHeight = terrain + features, so off to the side of every feature the
  // two must agree exactly. This is the relationship the apron is offset from.
  forEachLayout(({ id, runLength: run }) => {
    for (let z = 0; z < run; z += 1) {
      const x = 8.5; // outside the widest feature
      assert.ok(
        Math.abs(groundHeight(x, z) - terrainHeight(z)) < 1e-9,
        `${id}: ground and terrain disagree at z=${z}`,
      );
    }
  });
});

test('terrainHeight wraps like the park does', () => {
  forEachLayout(({ id, runLength: run }) => {
    for (const f of [0.05, 0.3, 0.6, 0.9]) {
      const z = f * run;
      assert.ok(Math.abs(terrainHeight(z) - terrainHeight(z + run)) < 1e-9, `${id}: no wrap at ${z}`);
      assert.ok(
        Math.abs(terrainHeight(z) - terrainHeight(z - 2 * run)) < 1e-9,
        `${id}: no wrap back at ${z}`,
      );
    }
  });
});

// -------------------------------------------------- touchdown & pacing ----

test('predictTouchdown solves a fall onto flat ground', () => {
  setLayout('funrun');
  // Dropped from 2m over the flat run-in with no horizontal speed:
  // t = sqrt(2h / g).
  const expected = Math.sqrt((2 * 2) / -Config.sim.gravity);
  const { t, point } = predictTouchdown(new Vector3(0, 2, 10), new Vector3(0, 0, 0));
  assert.ok(Math.abs(t - expected) < 0.01, `expected ${expected.toFixed(3)}s, got ${t.toFixed(3)}`);
  assert.ok(Math.abs(point.y) < 1e-6, 'should land on the ground, not through it');
});

test('predictTouchdown accounts for ground rising to meet the board', () => {
  // The whole reason it marches instead of solving: the surface is h(x, z), and
  // over a kicker it comes UP at the falling board. Solving against y = 0 would
  // put the landing late every time.
  setLayout('funrun');
  const from = new Vector3(0, 1.5, 27); // already over the warm-up kicker (z 26-32)
  const vel = new Vector3(0, 0, 9.5);
  const onRamp = predictTouchdown(from, vel).t;
  const flat = Math.sqrt((2 * 1.5) / -Config.sim.gravity);
  assert.ok(onRamp < flat, `ramp should be met sooner: ${onRamp.toFixed(3)} vs ${flat.toFixed(3)}`);
  const { point } = predictTouchdown(from, vel);
  assert.ok(
    Math.abs(point.y - groundHeight(point.x, point.z)) < 1e-6,
    'the predicted point must be ON the surface',
  );
});

test('a board already on the floor has no time left', () => {
  setLayout('funrun');
  assert.equal(predictTouchdown(new Vector3(0, -1, 10), new Vector3(0, -3, 0)).t, 0);
});

test('slow motion holds one flat scale, then eases out near the floor', () => {
  const N = Config.nail;
  // Flat for the bulk of the flight.
  for (const t of [3.0, 1.5, N.releaseWithin + 0.01]) {
    assert.equal(nailScale(t), N.timeScale, `should still be flat at ${t}s out`);
  }
  // Then monotonically quicker as the ground comes up — no corner, no reversal.
  let prev = N.timeScale;
  for (let t = N.releaseWithin; t >= 0; t -= 0.02) {
    const s = nailScale(t);
    assert.ok(s >= prev - 1e-9, `time scale went backwards at ${t.toFixed(2)}s out`);
    assert.ok(s <= N.releaseTimeScale + 1e-9, 'and never overshoots the release scale');
    prev = s;
  }
  assert.ok(Math.abs(nailScale(0) - N.releaseTimeScale) < 1e-9, 'and arrives at it');
});

test('the wind-out lasts the same time off a big launch and a small one', () => {
  // This is the point of keying the release to seconds-to-the-floor rather than
  // a fraction of the flight. Under the old scheme the release fired at 72% of
  // the flight whatever that was worth, so a big launch got seconds of easing
  // and a flat pop got a fraction of one. Now every trick gets the same run-in
  // to the floor.
  setLayout('funrun');
  const g = -Config.sim.gravity;
  const N = Config.nail;

  /**
   * Flies a whole arc from takeoff at `vy0` and reports where the pacing
   * changes: how long before touchdown the ease-out starts, and how far
   * through the flight that is. From takeoff, not from the apex — the rise is
   * half the window and the player is working the board through it.
   */
  function windOut(vy0) {
    const dt = 0.002;
    // The board leaves the ground riding a few centimetres above it. Starting
    // the probe at exactly y = 0 reads as already landed and the whole flight
    // scores as zero seconds out.
    const y0 = 0.06;
    const flight = (vy0 + Math.sqrt(vy0 * vy0 + 2 * g * y0)) / g;
    for (let elapsed = 0; elapsed <= flight; elapsed += dt) {
      const y = y0 + vy0 * elapsed - 0.5 * g * elapsed * elapsed;
      const vy = vy0 - g * elapsed;
      const { t } = predictTouchdown(new Vector3(0, Math.max(y, 0), 10), new Vector3(0, vy, 0));
      if (nailScale(t) > N.timeScale + 1e-9) {
        return { secondsLeft: t, fraction: elapsed / flight, height: y, flight };
      }
    }
    return null;
  }

  // The smallest pop the game can produce, and a launch off the big kicker.
  const small = windOut(Config.pop.minUp);
  const big = windOut(Config.pop.maxUp + 4);
  assert.ok(small && big, 'both flights should reach the ease-out');
  assert.ok(big.flight > small.flight * 1.9, 'the two flights must really differ');

  // The thing that must match: seconds of run-in to the floor.
  assert.ok(
    Math.abs(small.secondsLeft - big.secondsLeft) < 0.01,
    `wind-out started ${small.secondsLeft.toFixed(3)}s out vs ${big.secondsLeft.toFixed(3)}s`,
  );
  assert.ok(
    Math.abs(small.secondsLeft - N.releaseWithin) < 0.01,
    `and it should be releaseWithin (${N.releaseWithin}s), got ${small.secondsLeft.toFixed(3)}`,
  );

  // And the thing that is now allowed to differ, which is exactly what the old
  // fraction-of-flight release got wrong: a taller launch spends a smaller
  // share of its descent winding out, and a greater height, because it arrives
  // at the floor faster. Same seconds, different fraction.
  assert.ok(
    big.fraction > small.fraction + 0.1,
    `the big launch should ease out later in its flight: ${big.fraction.toFixed(2)} vs ${small.fraction.toFixed(2)}`,
  );
  assert.ok(big.height > small.height, 'and from higher up, since it is falling faster');

  // And every flight keeps a real flat window, including the smallest one there
  // is. Without this the shortest pop would spend its whole airtime winding out
  // and never be properly slowed at all — the same height dependence in a new
  // costume.
  assert.ok(
    small.fraction > 0.4,
    `even a minimum pop should hold full depth for most of its flight, got ${small.fraction.toFixed(2)}`,
  );
});

test('a catch holds the board with the rider, not against the ground', () => {
  // A planted finger holds the deck WITH you. The catch used to damp the
  // board's horizontal velocity toward zero in WORLD space, which brakes it
  // against ground the pair of you are flying over at cruise — so every held
  // catch slid the board out from under the rider, worse the faster the game
  // got. It read as "Board shot out" on landings that looked perfect.
  const carrier = new Vector3(0, 0, Config.skater.maxSpeed);
  const board = new Board();
  board.reset(new Vector3(0, 1.2, 0), 0);
  board.airborne = true;
  board.velocity.copy(carrier);
  board.angularVelocity.set(0, 0, 6);

  const fingers = new FingerFlipController();
  for (const [f, along] of [
    [fingers.left, -0.28],
    [fingers.right, 0.28],
  ]) {
    f.active = true;
    f.pos.set(0, 0, along);
    f.prevPos.copy(f.pos);
    f.vel.set(0, 0, 0);
  }

  let drift = 0; // how far the board slips behind the rider, in metres
  for (let i = 0; i < 60; i++) {
    fingers.update(board, STANCE, REAL_DT, 0.7, carrier);
    drift += (carrier.z - board.velocity.z) * REAL_DT * 0.13; // world seconds
  }

  assert.ok(
    Math.abs(board.velocity.z - carrier.z) < 0.05,
    `the board should keep pace with the rider, ${board.velocity.z.toFixed(2)} vs ${carrier.z.toFixed(2)}`,
  );
  assert.ok(
    Math.abs(drift) < Config.landing.bailDrift * 0.1,
    `a held catch drifted the board ${drift.toFixed(3)}m out from under the rider`,
  );
});

test('with no rider to hold it, a catch still settles the board', () => {
  // The carrier is optional, and without one the damping has to behave exactly
  // as it always did — a loose board is being stopped against the world.
  const board = new Board();
  board.reset(new Vector3(0, 1.2, 0), 0);
  board.airborne = true;
  board.velocity.set(1.5, 0, 1.5);

  const fingers = new FingerFlipController();
  for (const [f, along] of [
    [fingers.left, -0.28],
    [fingers.right, 0.28],
  ]) {
    f.active = true;
    f.pos.set(0, 0, along);
    f.prevPos.copy(f.pos);
    f.vel.set(0, 0, 0);
  }
  for (let i = 0; i < 60; i++) fingers.update(board, STANCE, REAL_DT, 0.7);
  assert.ok(Math.hypot(board.velocity.x, board.velocity.z) < 0.5, 'should bleed toward rest');
});

test('a launch off a rising ramp is not mistaken for a landing', () => {
  // The auto-launch fires about half a metre BEFORE a lip, so for the first
  // few centimetres the transition is still climbing faster than the arc is.
  // A marcher that takes the first ground crossing it finds calls that an
  // immediate touchdown: off the quarterpipe it reported a quarter of a second
  // for a flight that ran a second and a half. The trick camera uses this to
  // know how far through the flight it is, so it sat at full landing pullback
  // for the whole trick with the deck tiny in frame.
  setLayout('funrun');

  // On the quarterpipe's face (z 66 to its lip just under 68), popping.
  const z = 67.2;
  const from = new Vector3(0, groundHeight(0, z) + 0.06, z);
  const vel = new Vector3(0, 6.5, 10);
  const { t, point } = predictTouchdown(from, vel);

  assert.ok(t > 0.8, `expected a real flight off the transition, got ${t.toFixed(3)}s`);
  assert.ok(point.z > z + 5, `and it should carry well past the lip, landed at z=${point.z.toFixed(1)}`);
  assert.ok(
    Math.abs(point.y - groundHeight(point.x, point.z)) < 1e-6,
    'the predicted point must still be on the surface',
  );
});

test('a board driven into a wall still reports a touchdown', () => {
  // The other side of that rule: if the arc never gets clear of the ground, the
  // first crossing is the honest answer rather than the far horizon.
  setLayout('funrun');
  const z = 66.4; // low on the transition, barely moving
  const from = new Vector3(0, groundHeight(0, z) + 0.02, z);
  const { t } = predictTouchdown(from, new Vector3(0, 0.2, 9));
  assert.ok(t > 0 && t < 1.0, `expected a prompt touchdown, got ${t.toFixed(3)}s`);
});

test('a body resting on the ground has no flight left', () => {
  setLayout('funrun');
  assert.equal(predictTouchdown(new Vector3(0, -1, 10), new Vector3(0, -3, 0)).t, 0);
  // But one sitting on the deck and moving UP is taking off, not landing.
  assert.ok(predictTouchdown(new Vector3(0, 0, 10), new Vector3(0, 6, 0)).t > 0.5);
});
