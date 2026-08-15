/**
 * Measures how much rotation one flick actually produces, emulating the exact
 * input path the game uses (keyboard ramp -> mapper -> substepped solver), at
 * several frame rates. Used to tune Config.fingers without guessing.
 *
 *   node tools/tune.mjs [forceScale] [pressPerSpeed]
 */
import { Vector3, Quaternion } from 'three';
import Board from '../src/sim/Board.js';
import FingerFlipController from '../src/sim/Fingers.js';
import { recognise } from '../src/sim/Tricks.js';
import Config from '../src/core/Config.js';

if (process.argv[2]) Config.fingers.forceScale = +process.argv[2];

const STANCE = new Quaternion();
const HOME = 0.22;

/**
 * @param {object} opts
 *   holdSeconds — how long the key is held (a flick is a tap)
 *   dir         — +1 toe rail (kickflip), -1 heel rail (heelflip)
 *   fps         — simulated frame rate
 */
function flick({ holdSeconds = 0.14, dir = 1, fps = 60, airTime = 1.12, timeScale = 0.13, along = HOME } = {}) {
  const board = new Board();
  board.reset(new Vector3(0, 1.5, 0), 0);
  board.airborne = true;
  board.velocity.set(0, 8.9, 10);
  board.angularVelocity.set(Config.pop.pitchKick, 0, 0);

  const fingers = new FingerFlipController();
  const f = fingers.right;
  const rd = 1 / fps;

  let across = 0;
  let speed = 0;
  let worldT = 0;
  let realT = 0;

  while (worldT < airTime) {
    const moving = realT < holdSeconds;
    f.prevPos.set(across, 0, along);
    let vx = 0;
    if (moving) {
      speed += (Config.fingers.keyboardSpeed - speed) * Math.min(1, Config.fingers.keyboardRamp * rd);
      vx = dir * speed;
      across = Math.max(-0.62, Math.min(0.62, across + vx * rd));
    } else {
      speed = 0;
      const step = Config.fingers.keyboardReturn * rd;
      across = Math.abs(across) <= step ? 0 : across - Math.sign(across) * step;
    }
    f.pos.set(across, 0, along);
    f.vel.set(vx, 0, 0);
    f.active = moving;

    fingers.update(board, STANCE, rd, worldT / airTime);

    let remaining = rd * timeScale;
    while (remaining > 1e-9) {
      const step = Math.min(Config.sim.fixedStep, remaining);
      board.step(step);
      remaining -= step;
      worldT += step;
    }
    realT += rd;
  }
  return { spin: board.spin.clone(), omega: board.angularVelocity.length(), trick: recognise(board.spin) };
}

const fmt = (r) =>
  `roll ${r.spin.z.toFixed(2)}  yaw ${r.spin.y.toFixed(2)}  pitch ${r.spin.x.toFixed(2)}  -> ${r.trick.name}`;

console.log(`forceScale ${Config.fingers.forceScale}, pressPerSpeed via Fingers.js\n`);
for (const fps of [144, 60, 30]) {
  console.log(`--- ${fps} fps ---`);
  for (const hold of [0.08, 0.12, 0.16, 0.22]) {
    console.log(`  hold ${(hold * 1000).toFixed(0).padStart(3)}ms : ${fmt(flick({ holdSeconds: hold, fps }))}`);
  }
}
console.log('\nheel side (hold 160ms, 60fps):', fmt(flick({ holdSeconds: 0.16, dir: -1 })));
console.log('at the tail (hold 160ms, 60fps):', fmt(flick({ holdSeconds: 0.16, along: -HOME })));
