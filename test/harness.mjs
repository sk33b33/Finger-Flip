import { Vector3, Quaternion } from 'three';
import Board from '../src/sim/Board.js';
import FingerFlipController from '../src/sim/Fingers.js';
import { recognise } from '../src/sim/Tricks.js';
import Config from '../src/core/Config.js';

/**
 * Replays a scripted flight through the real input path — the same keyboard
 * ramp, mapper geometry and substepped solver the game uses — so a "recipe"
 * here is something a player could actually perform.
 *
 * A move is { finger, at, hold, across, along, dAcross, dAlong, plant }:
 *   finger   0 = left/tail-side virtual finger, 1 = right/nose-side
 *   at       real seconds into the flight when the input starts
 *   hold     how long it is held, in real seconds
 *   across   starting offset from the deck centreline (metres)
 *   along    starting offset from the deck centre (metres, + = nose)
 *   dAcross  direction of travel across the deck, -1..1
 *   dAlong   direction of travel along the deck, -1..1
 *   plant    hold still and catch instead of moving
 *   speed    optional override of the finger's travel speed
 */
export const STANCE = new Quaternion();

export function perform(moves, opts = {}) {
  const {
    fps = 60,
    airTime = 1.12,
    timeScale = Config.nail.timeScale,
    home = [-0.22, 0.22],
  } = opts;

  const board = new Board();
  board.reset(new Vector3(0, 1.5, 0), 0);
  board.airborne = true;
  board.velocity.set(0, 8.9, 10);
  board.angularVelocity.set(Config.pop.pitchKick, 0, 0);

  const fingers = new FingerFlipController();
  const state = [
    { across: 0, along: home[0], speed: 0, home: home[0] },
    { across: 0, along: home[1], speed: 0, home: home[1] },
  ];

  const rd = 1 / fps;
  let realT = 0;
  let worldT = 0;
  let guard = 0;

  while (worldT < airTime && guard++ < 40000) {
    for (let i = 0; i < 2; i++) {
      const f = fingers.fingers[i];
      const s = state[i];
      const move = moves.find(
        (m) => m.finger === i && realT >= m.at && realT < m.at + m.hold,
      );

      f.prevPos.set(s.across, 0, s.along);

      if (move && realT - rd < move.at) {
        // First frame of the move: place the fingertip where the recipe says.
        if (move.across !== undefined) s.across = move.across;
        if (move.along !== undefined) s.along = move.along;
        s.speed = 0;
        f.prevPos.set(s.across, 0, s.along);
      }

      let vx = 0;
      let vz = 0;
      if (move && !move.plant) {
        const max = move.speed ?? Config.fingers.keyboardSpeed;
        s.speed += (max - s.speed) * Math.min(1, Config.fingers.keyboardRamp * rd);
        const dx = move.dAcross ?? 0;
        const dz = move.dAlong ?? 0;
        const len = Math.hypot(dx, dz) || 1;
        vx = (dx / len) * s.speed;
        vz = (dz / len) * s.speed;
        s.across = clamp(s.across + vx * rd, -0.62, 0.62);
        s.along = clamp(s.along + vz * rd, -0.72, 0.72);
      } else if (!move) {
        s.speed = 0;
        const step = Config.fingers.keyboardReturn * rd;
        s.across = approach(s.across, 0, step);
        s.along = approach(s.along, s.home, step);
      }

      f.pos.set(s.across, 0, s.along);
      f.vel.set(vx, 0, vz);
      f.active = !!move;
    }

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

  return {
    board,
    fingers,
    spin: board.spin.clone(),
    omega: board.angularVelocity.length(),
    trick: recognise(board.spin),
    realTime: realT,
  };
}

/** A finger flicking off one rail near the nose: the flip input. */
export function railFlick({ finger = 1, at = 0.12, hold = 0.13, dir = 1, along = 0.22 } = {}) {
  return { finger, at, hold, across: 0, along, dAcross: dir };
}

/** A finger scooping across the middle of the tail: the shove-it input. */
export function scoop({ finger = 0, at = 0.12, hold = 0.085, dir = 1, along = -0.36 } = {}) {
  // Short and sharp, out near the tail tip where the yaw arm is longest, and
  // staying inside the full-grip zone so the roll arm sweeps through zero and
  // cancels. Drag it further and it turns into a varial, which is exactly what
  // over-scooping does on a real board.
  return { finger, at, hold, across: -dir * 0.04, along, dAcross: dir };
}

/** A finger dragged along the very tip: the end-over-end input. */
export function tipDrag({ finger = 0, at = 0.1, hold = 0.45, along = -0.24, speed = 0.7 } = {}) {
  // Slow and deliberate, so the finger keeps its leverage instead of skimming.
  return { finger, at, hold, across: 0, along, dAlong: -1, speed };
}

/** Both fingers planted flat on the deck: the catch. */
export function catchBoard({ at = 0.5, hold = 0.6 } = {}) {
  return [
    { finger: 0, at, hold, across: 0, along: -0.2, plant: true },
    { finger: 1, at, hold, across: 0, along: 0.2, plant: true },
  ];
}

function clamp(v, a, b) {
  return v < a ? a : v > b ? b : v;
}

function approach(v, target, step) {
  const d = target - v;
  return Math.abs(d) <= step ? target : v + Math.sign(d) * step;
}
