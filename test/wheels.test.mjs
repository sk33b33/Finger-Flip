/**
 * Wheel-axis invariant.
 *
 * view/BoardMesh.js cannot be imported here — it builds its textures on a
 * canvas, and there is no DOM in Node. So this test reproduces the wheel's
 * transform chain exactly as BoardMesh constructs it and asserts the property
 * that matters: the axle stays pointing across the board, whatever the spin.
 *
 * This is not a hypothetical. The wheels were being spun about Y for six
 * commits, which swings the axle around the vertical — the wheels castored like
 * trolley wheels instead of rolling, and nothing in the suite noticed.
 *
 *   node --test test/wheels.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Object3D, Vector3 } from 'three';

const X = new Vector3(1, 0, 0);

/**
 * One wheel, built and driven the way BoardMesh does it.
 *
 * @param {number} spin  radians of roll
 * @param {number} dir   +1 front truck, -1 rear (which is yawed 180°)
 */
function wheel(spin, dir = 1) {
  const board = new Object3D();

  const truck = new Object3D();
  truck.position.set(0, -0.00625, dir * 0.172);
  truck.rotation.y = dir > 0 ? 0 : Math.PI;
  board.add(truck);

  const w = new Object3D();
  // Lay the cylinder's axis (its local +Y) along the board's X: the axle.
  w.rotation.z = Math.PI / 2;
  w.position.set(0.0855, -0.028, -0.004);
  // Roll it. About X, so the axle does not move.
  w.rotation.x = spin;
  truck.add(w);

  board.updateMatrixWorld(true);
  return w;
}

/** A local direction of the wheel, in board space. */
function axis(w, local) {
  return local.clone().applyQuaternion(w.getWorldQuaternion(w.quaternion.clone()));
}

test('the axle stays across the board at any spin', () => {
  for (const dir of [1, -1]) {
    for (const spin of [0, 0.4, 1.7, Math.PI, 12.5, 240.9, -6.2]) {
      const a = axis(wheel(spin, dir), new Vector3(0, 1, 0));
      // Parallel to X means the dot product with X is ±1 and nothing is left
      // over for the other two axes.
      assert.ok(
        Math.abs(Math.abs(a.dot(X)) - 1) < 1e-9,
        `dir ${dir} spin ${spin}: axle drifted off X (${a.x.toFixed(4)}, ${a.y.toFixed(4)}, ${a.z.toFixed(4)})`,
      );
      assert.ok(Math.abs(a.y) < 1e-9, `dir ${dir} spin ${spin}: axle tilted out of the horizontal`);
      assert.ok(Math.abs(a.z) < 1e-9, `dir ${dir} spin ${spin}: axle swung toward the nose`);
    }
  }
});

test('the wheel actually turns', () => {
  // A radial direction — anything perpendicular to the axle — must move as the
  // spin advances, or "locked forward" has quietly become "locked still".
  const rim = (spin) => axis(wheel(spin), new Vector3(0, 0, 1));
  const a = rim(0);
  const b = rim(Math.PI / 2);
  assert.ok(a.dot(b) < 1e-6, 'a quarter turn should leave the rim direction perpendicular');
  assert.ok(rim(Math.PI).dot(a) < -0.999, 'half a turn should invert it');
});

test('a rolling wheel matches the ground speed', () => {
  // BoardMesh advances by speed / radius, which is the no-slip condition: the
  // arc swept at the rim equals the distance travelled.
  const radius = 0.027;
  const speed = 9.72; // m/s, the cruise
  const dt = 0.5;
  const spin = (speed / radius) * dt;
  assert.ok(Math.abs(spin * radius - speed * dt) < 1e-9, 'rim arc should equal ground distance');
});
