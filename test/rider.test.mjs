/**
 * The rider's stance.
 *
 * view/RiderMesh.js builds from three's primitives and a plain data table, with
 * no canvas anywhere, so the whole rig imports and poses in Node. That makes the
 * thing that actually matters about a skateboarding stance — that the feet are
 * on the board — an assertion rather than a screenshot.
 *
 *   node --test test/rider.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Vector3 } from 'three';

import RiderMesh from '../src/view/RiderMesh.js';
import { CHARACTERS } from '../src/view/Characters.js';

/** World Y of one foot, after the pose has been applied. */
function footHeights(rider) {
  rider.updateMatrixWorld(true);
  return rider.legs.map((leg) => leg.ankle.getWorldPosition(new Vector3()).y);
}

test('the feet stay planted through the whole crouch', () => {
  // Loading up for an ollie must not lift the rider off their own board. The
  // joints used to simply rotate, which folded the legs and swung the feet up
  // and back off the deck — the deeper the charge, the further off they got.
  const rider = new RiderMesh();

  rider.setPose(0, 0, 0);
  const [restLeft, restRight] = footHeights(rider);
  assert.ok(Math.abs(restLeft - restRight) < 1e-9, 'both feet should rest level');

  for (let crouch = 0; crouch <= 1.0001; crouch += 0.05) {
    rider.setPose(crouch, 0, 0);
    for (const y of footHeights(rider)) {
      assert.ok(
        Math.abs(y - restLeft) < 1e-6,
        `at crouch ${crouch.toFixed(2)} a foot moved to ${y.toFixed(4)}, from ${restLeft.toFixed(4)}`,
      );
    }
  }
});

test('crouching actually lowers the rider', () => {
  // The feet holding still must not be achieved by nothing moving at all.
  const rider = new RiderMesh();
  rider.setPose(0, 0, 0);
  rider.updateMatrixWorld(true);
  const tall = rider.head.getWorldPosition(new Vector3()).y;

  rider.setPose(1, 0, 0);
  rider.updateMatrixWorld(true);
  const low = rider.head.getWorldPosition(new Vector3()).y;

  assert.ok(low < tall - 0.3, `a full charge should sink the rider, ${tall.toFixed(2)} -> ${low.toFixed(2)}`);
});

test('the knees are never locked straight', () => {
  // A skater rides with soft knees; locked out reads as a mannequin on a plank.
  const rider = new RiderMesh();
  rider.setPose(0, 0, 0);
  for (const leg of rider.legs) {
    assert.ok(leg.knee.rotation.x > 0.15, `resting knee is ${leg.knee.rotation.x.toFixed(3)} rad`);
  }
});

test('the feet come up only in the air', () => {
  // Which is the other half of the deal: planted while charging, off the board
  // once the pop has actually happened.
  const rider = new RiderMesh();
  rider.setPose(1, 0, 0);
  const grounded = footHeights(rider)[0];
  rider.setPose(0.2, 0, 1);
  const airborne = footHeights(rider)[0];
  assert.ok(airborne > grounded + 0.1, `feet should tuck up in the air: ${grounded.toFixed(3)} -> ${airborne.toFixed(3)}`);
});

test('the sole stays flat on the deck, not just at the right height', () => {
  // The ankle counter-rotates by the whole leg chain, so the foot keeps its
  // orientation. A foot at the right height but pointing at the sky is not
  // standing on anything.
  const rider = new RiderMesh();
  const soleTilt = () => {
    rider.updateMatrixWorld(true);
    const up = new Vector3(0, 1, 0).applyQuaternion(
      rider.legs[0].ankle.getWorldQuaternion(rider.legs[0].ankle.quaternion.clone()),
    );
    return Math.acos(Math.min(1, Math.abs(up.y))) * (180 / Math.PI);
  };
  for (const crouch of [0, 0.25, 0.5, 0.75, 1]) {
    rider.setPose(crouch, 0, 0);
    assert.ok(soleTilt() < 1e-4, `at crouch ${crouch} the sole tilted ${soleTilt().toFixed(2)}°`);
  }
});

test('every character in the roster stands on the board', () => {
  // Build varies per character, and the IK is solved from the bone lengths, so
  // a different build must not put anyone's feet through the deck.
  for (const spec of CHARACTERS) {
    const rider = new RiderMesh(spec);
    rider.setPose(0, 0, 0);
    const rest = footHeights(rider)[0];
    for (const crouch of [0.3, 0.7, 1]) {
      rider.setPose(crouch, 0, 0);
      for (const y of footHeights(rider)) {
        assert.ok(
          Math.abs(y - rest) < 1e-6,
          `${spec.id} lifted a foot at crouch ${crouch}: ${y.toFixed(4)} vs ${rest.toFixed(4)}`,
        );
      }
    }
  }
});
