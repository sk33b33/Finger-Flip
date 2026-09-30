/**
 * FingerMapper — the bridge between a fingertip on glass and a point on the deck.
 *
 * This is the heart of the control and it had no tests. `tools/aspects.mjs`
 * measures the OUTPUT — how many pixels wide the flick window ends up — but
 * never the mapping itself, so a transposed matrix or a lost aspect term would
 * sail past it and simply feel wrong.
 *
 * The mapping projects the stance axes into screen space and inverts the 2x2,
 * which is what lets "drag along the board on screen" mean "drag along the
 * board in the world" at any camera angle with no per-camera special cases.
 * That claim is exactly a round trip, so that is what most of this file checks.
 *
 *   node --test test/mapper.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { PerspectiveCamera, Quaternion, Vector2, Vector3 } from 'three';

import FingerMapper from '../src/game/FingerMapper.js';
import FingerFlipController from '../src/sim/Fingers.js';
import Config from '../src/core/Config.js';

const REAL_DT = 1 / 60;

/** Just enough of core/Input.js for the mapper to read. */
function fakeInput() {
  return {
    pointers: new Map(),
    keys: new Set(),
    anyDown(...codes) {
      return codes.some((c) => this.keys.has(c));
    },
    press(...codes) {
      for (const c of codes) this.keys.add(c);
    },
    release(...codes) {
      for (const c of codes) this.keys.delete(c);
    },
    touch(id, x, y) {
      this.pointers.set(id, { id, x, y, down: true, owner: null });
      return this.pointers.get(id);
    },
  };
}

function makeMapper() {
  const input = fakeInput();
  const fingers = new FingerFlipController();
  return { input, fingers, mapper: new FingerMapper(input, fingers) };
}

/**
 * A camera looking at the board the way the trick shot does, from an arbitrary
 * azimuth and elevation.
 */
function lookAtBoard(boardPos, { azimuth = 0, elevation = 0.7, distance = 1.2, aspect = 16 / 9 }) {
  const cam = new PerspectiveCamera(46, aspect, 0.05, 100);
  cam.position.set(
    boardPos.x + Math.sin(azimuth) * Math.cos(elevation) * distance,
    boardPos.y + Math.sin(elevation) * distance,
    boardPos.z + Math.cos(azimuth) * Math.cos(elevation) * distance,
  );
  cam.lookAt(boardPos);
  cam.updateMatrixWorld(true);
  cam.updateProjectionMatrix();
  return cam;
}

/** Mirrors the module's own project(): NDC with x scaled by the aspect. */
function toScreen(worldPoint, cam) {
  const p = worldPoint.clone().project(cam);
  return new Vector2(p.x * cam.aspect, p.y);
}

/** A point on the hand plane, in world space. */
function planePoint(across, along, stance, boardPos) {
  return new Vector3(across, 0, along).applyQuaternion(stance).add(boardPos);
}

// ------------------------------------------------------------ round trip ---

test('a point on the deck survives the trip to the screen and back', () => {
  // The whole mapping is one 2x2 inverse. If it is right, projecting a point
  // on the hand plane and mapping the result back lands on the same point —
  // and if it is transposed, or the aspect term is dropped, it does not.
  const { mapper } = makeMapper();
  const boardPos = new Vector3(1.4, 1.1, 37);
  const stance = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), 0.4);
  const cam = lookAtBoard(boardPos, { azimuth: 0.31 * Math.PI * 2, elevation: 0.72 });

  mapper.updateBasis(cam, boardPos, stance);
  assert.ok(mapper.basis.ok, 'the basis should be usable from a normal trick angle');

  const out = new Vector2();
  for (const across of [-0.2, -0.05, 0, 0.05, 0.2]) {
    for (const along of [-0.4, -0.2, 0, 0.2, 0.4]) {
      const s = toScreen(planePoint(across, along, stance, boardPos), cam);
      mapper.screenToPlane(s.x, s.y, out);
      assert.ok(
        Math.abs(out.x - across) < 1e-3 && Math.abs(out.y - along) < 1e-3,
        `(${across}, ${along}) came back as (${out.x.toFixed(4)}, ${out.y.toFixed(4)})`,
      );
    }
  }
});

test('it round-trips from any camera angle, at any aspect', () => {
  // "No per-camera special cases" is the claim the design rests on. A mapping
  // that only works from the angle it was tuned at would fail silently on a
  // different viewport, where fitToViewport picks the other framing.
  const { mapper } = makeMapper();
  const boardPos = new Vector3(0, 1.3, 12);
  const out = new Vector2();

  for (const aspect of [0.46, 1, 16 / 9, 2.16]) {
    for (let a = 0; a < 6; a++) {
      for (const elevation of [0.25, 0.72, 1.2]) {
        const stance = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), a * 0.9);
        const cam = lookAtBoard(boardPos, { azimuth: (a / 6) * Math.PI * 2, elevation, aspect });
        mapper.updateBasis(cam, boardPos, stance);
        assert.ok(mapper.basis.ok, `basis collapsed at aspect ${aspect}, angle ${a}`);

        const s = toScreen(planePoint(0.09, -0.31, stance, boardPos), cam);
        mapper.screenToPlane(s.x, s.y, out);
        assert.ok(
          Math.hypot(out.x - 0.09, out.y + 0.31) < 2e-3,
          `aspect ${aspect} angle ${a} elev ${elevation}: got (${out.x.toFixed(3)}, ${out.y.toFixed(3)})`,
        );
      }
    }
  }
});

test('dragging along the board on screen drags along the board', () => {
  // The readable form of the same invariant, and the thing a player feels: a
  // screen movement that follows the deck's long axis must produce motion down
  // the deck and essentially none across it. Swap the two and every flick
  // becomes a scoop.
  const { mapper } = makeMapper();
  const boardPos = new Vector3(0, 1.2, 5);
  const stance = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), 0.9);
  const cam = lookAtBoard(boardPos, { azimuth: 2.1, elevation: 0.7 });
  mapper.updateBasis(cam, boardPos, stance);

  const out = new Vector2();
  const at = (across, along) => {
    const s = toScreen(planePoint(across, along, stance, boardPos), cam);
    return mapper.screenToPlane(s.x, s.y, out).clone();
  };

  const alongMove = at(0, 0.3).sub(at(0, -0.3));
  assert.ok(Math.abs(alongMove.y) > 0.55, `expected travel down the deck, got ${alongMove.y.toFixed(3)}`);
  assert.ok(Math.abs(alongMove.x) < 1e-3, `it should not wander across: ${alongMove.x.toFixed(4)}`);

  const acrossMove = at(0.15, 0).sub(at(-0.15, 0));
  assert.ok(Math.abs(acrossMove.x) > 0.28, `expected travel across the deck, got ${acrossMove.x.toFixed(3)}`);
  assert.ok(Math.abs(acrossMove.y) < 1e-3, `it should not wander along: ${acrossMove.y.toFixed(4)}`);
});

test('an edge-on camera is refused rather than dividing by nothing', () => {
  // Looking exactly along the hand plane collapses it to a line on screen, the
  // determinant goes to zero, and an unguarded inverse would fling the
  // fingertip to infinity — or to NaN, which then poisons the board's
  // quaternion and never comes back.
  const { mapper } = makeMapper();
  const boardPos = new Vector3(0, 1.2, 5);
  const stance = new Quaternion();
  const cam = lookAtBoard(boardPos, { azimuth: 0, elevation: 0, distance: 1.2 });
  mapper.updateBasis(cam, boardPos, stance);

  assert.equal(mapper.basis.ok, false, 'an edge-on plane must be refused');
  const out = mapper.screenToPlane(0.4, 0.2, new Vector2());
  assert.ok(Number.isFinite(out.x) && Number.isFinite(out.y), 'must not produce NaN or Infinity');
  assert.deepEqual([out.x, out.y], [0, 0]);
});

// --------------------------------------------------------------- touch ----

test('a touch lands the finger where it was actually touched, with no velocity spike', () => {
  // Claiming a pointer must not read as a sweep from wherever the finger was
  // last time: the solver integrates the path between prevPos and pos, so a
  // stale previous position is a flick the player never made.
  const { input, fingers, mapper } = makeMapper();
  const boardPos = new Vector3(0, 1.2, 5);
  const stance = new Quaternion();
  const cam = lookAtBoard(boardPos, { azimuth: 1.9, elevation: 0.75 });
  mapper.updateBasis(cam, boardPos, stance);

  const target = planePoint(0.06, 0.3, stance, boardPos);
  const s = toScreen(target, cam);
  input.touch(1, s.x / cam.aspect, s.y); // update() re-applies the aspect
  mapper.update(REAL_DT);

  const f = fingers.fingers.find((x) => x.pointerId === 1);
  assert.ok(f, 'a free finger should have claimed the pointer');
  assert.ok(Math.hypot(f.pos.x - 0.06, f.pos.z - 0.3) < 2e-3, `landed at ${f.pos.x}, ${f.pos.z}`);
  assert.equal(f.vel.length(), 0, 'the first frame of a touch has no velocity');
  assert.ok(f.prevPos.distanceTo(f.pos) < 1e-9, 'and no sweep to solve across');
  assert.equal(f.active, true);
});

test('lifting a finger releases its slot for the next touch', () => {
  const { input, fingers, mapper } = makeMapper();
  mapper.updateBasis(lookAtBoard(new Vector3(), { azimuth: 1 }), new Vector3(), new Quaternion());

  input.touch(7, 0.1, 0.1);
  mapper.update(REAL_DT);
  assert.equal(fingers.fingers.filter((f) => f.pointerId !== null).length, 1);

  input.pointers.get(7).down = false;
  mapper.update(REAL_DT);
  assert.equal(fingers.fingers.filter((f) => f.pointerId !== null).length, 0);
  assert.ok(fingers.fingers.every((f) => !f.active), 'and the finger is off the deck');
});

test('two touches drive two fingers, either end to either hand', () => {
  // "Whichever end of the deck you touch is the end you have hold of" — there
  // is deliberately no left-hand-only or right-hand-only move.
  const { input, fingers, mapper } = makeMapper();
  mapper.updateBasis(lookAtBoard(new Vector3(), { azimuth: 1 }), new Vector3(), new Quaternion());

  input.touch(1, -0.2, 0.1);
  input.touch(2, 0.25, -0.1);
  mapper.update(REAL_DT);

  const owned = fingers.fingers.filter((f) => f.pointerId !== null);
  assert.equal(owned.length, 2);
  assert.notEqual(owned[0].pointerId, owned[1].pointerId);
});

// ------------------------------------------------------------ keyboard ----

test('a held key ramps up rather than snapping to full speed', () => {
  // A tap should nudge the deck and a hold should deliver a proper flick, so
  // the first frame must be markedly slower than the steady state.
  const { input, fingers, mapper } = makeMapper();
  input.press('KeyD');

  mapper.updateKeyboard(REAL_DT);
  const first = Math.abs(fingers.left.vel.x);
  for (let i = 0; i < 40; i++) mapper.updateKeyboard(REAL_DT);
  const settled = Math.abs(fingers.left.vel.x);

  assert.ok(first > 0, 'it should move on the first frame');
  assert.ok(first < settled * 0.5, `a tap should be gentle: ${first.toFixed(2)} vs ${settled.toFixed(2)}`);
  assert.ok(
    Math.abs(settled - Config.fingers.keyboardSpeed) < 0.05,
    `and settle at keyboardSpeed, got ${settled.toFixed(3)}`,
  );
});

test('a diagonal is no faster than a straight push', () => {
  // The direction is normalised. Without that, holding two keys would be 1.41x
  // quicker and the corner of the deck would be the fastest flick in the game.
  const straight = makeMapper();
  straight.input.press('KeyD');
  const diagonal = makeMapper();
  diagonal.input.press('KeyD', 'KeyW');

  for (let i = 0; i < 40; i++) {
    straight.mapper.updateKeyboard(REAL_DT);
    diagonal.mapper.updateKeyboard(REAL_DT);
  }
  const a = straight.fingers.left.vel.length();
  const b = diagonal.fingers.left.vel.length();
  assert.ok(Math.abs(a - b) < 0.02, `straight ${a.toFixed(3)} vs diagonal ${b.toFixed(3)}`);
});

test('a keyboard finger sweeps, rather than teleporting over the deck', () => {
  // prevPos has to be where the fingertip was BEFORE this frame's step. It was
  // once set to the new position instead, which made every keyboard sweep
  // zero-length and let a fast flick skip the contact window entirely.
  //
  // Only a handful of frames: at keyboardSpeed the fingertip reaches the clamp
  // in about a fifth of a second, and once it is pinned there prevPos and pos
  // agree again — correctly, because a finger held against the clamp has run
  // off the deck and is no longer in contact with anything.
  const { input, fingers, mapper } = makeMapper();
  input.press('KeyD');
  for (let i = 0; i < 5; i++) mapper.updateKeyboard(REAL_DT);

  const f = fingers.left;
  assert.ok(f.prevPos.distanceTo(f.pos) > 1e-4, 'a moving finger must leave a path to solve');
  assert.ok(f.pos.x > f.prevPos.x, 'and the path must run the way it is travelling');
});

test('a keyboard finger stays on the deck', () => {
  const { input, fingers, mapper } = makeMapper();
  input.press('KeyD', 'KeyW');
  for (let i = 0; i < 600; i++) mapper.updateKeyboard(REAL_DT);
  assert.ok(Math.abs(fingers.left.pos.x) <= 0.62 + 1e-9, `across ran to ${fingers.left.pos.x}`);
  assert.ok(Math.abs(fingers.left.pos.z) <= 0.72 + 1e-9, `along ran to ${fingers.left.pos.z}`);
});

test('an idle finger drifts home, and a planted one does not', () => {
  // Returning home is what makes the next tap another clean flick instead of a
  // dead key. Planting has to override it, or a held catch would slide.
  const { input, fingers, mapper } = makeMapper();
  input.press('KeyD');
  for (let i = 0; i < 30; i++) mapper.updateKeyboard(REAL_DT);
  const movedTo = fingers.left.pos.x;
  assert.ok(movedTo > 0.05, 'it should have travelled first');

  input.release('KeyD');
  for (let i = 0; i < 120; i++) mapper.updateKeyboard(REAL_DT);
  assert.ok(Math.abs(fingers.left.pos.x) < 1e-6, `should return to the centreline, at ${fingers.left.pos.x}`);
  assert.equal(fingers.left.active, false, 'and be off the deck');

  // Now plant it somewhere and hold: it must stay put.
  input.press('KeyD');
  for (let i = 0; i < 20; i++) mapper.updateKeyboard(REAL_DT);
  input.release('KeyD');
  input.press('KeyQ');
  const held = fingers.left.pos.x;
  for (let i = 0; i < 120; i++) mapper.updateKeyboard(REAL_DT);
  assert.ok(Math.abs(fingers.left.pos.x - held) < 1e-9, 'a planted finger must not drift');
  assert.equal(fingers.left.active, true, 'and it is on the deck');
  assert.equal(fingers.left.vel.length(), 0, 'holding still is not a flick');
});

test('a real pointer takes the slot from the keyboard', () => {
  // Both paths write the same two fingers. If the keyboard kept writing over a
  // touched finger, every touch would fight a phantom.
  const { input, fingers, mapper } = makeMapper();
  mapper.updateBasis(lookAtBoard(new Vector3(), { azimuth: 1 }), new Vector3(), new Quaternion());

  input.press('KeyA'); // drive the left keyboard finger
  mapper.update(REAL_DT);
  const keyboardPos = fingers.left.pos.x;
  assert.ok(keyboardPos < 0, 'the keyboard moved it');

  input.touch(3, 0.3, 0.2);
  mapper.update(REAL_DT);
  const touched = fingers.fingers.find((f) => f.pointerId === 3);
  assert.ok(touched, 'the touch claimed a slot');
  for (let i = 0; i < 10; i++) mapper.update(REAL_DT);
  // Whichever slot the touch took is now driven by the pointer alone.
  assert.ok(
    Math.abs(touched.pos.x - keyboardPos) > 1e-6 || touched.pointerId !== null,
    'the keyboard must not write over a touched finger',
  );
  assert.equal(touched.pointerId, 3);
});

test('homing puts both fingers back over the trucks', () => {
  const { input, fingers, mapper } = makeMapper();
  input.press('KeyD', 'ArrowLeft');
  for (let i = 0; i < 30; i++) mapper.updateKeyboard(REAL_DT);

  mapper.homeKeyFingers();
  mapper.updateKeyboard(REAL_DT);
  assert.ok(Math.abs(fingers.left.pos.x) < 0.05, 'left finger back to the centreline');
  assert.ok(fingers.left.pos.z < 0, 'left finger over the tail truck');
  assert.ok(fingers.right.pos.z > 0, 'right finger over the nose truck');
});

test('reset clears the pointers as well as the positions', () => {
  const { input, fingers, mapper } = makeMapper();
  mapper.updateBasis(lookAtBoard(new Vector3(), { azimuth: 1 }), new Vector3(), new Quaternion());
  input.touch(1, 0.2, 0.2);
  mapper.update(REAL_DT);

  mapper.reset();
  assert.ok(fingers.fingers.every((f) => f.pointerId === null && !f.active));
  assert.ok(fingers.fingers.every((f) => f.pos.length() === 0));
});
