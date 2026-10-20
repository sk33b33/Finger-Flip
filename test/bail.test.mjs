/**
 * The slam.
 *
 * It is the animation a learning player sees most, and it used to be three
 * Math.random() calls — so the same mistake looked different every time and
 * told you nothing. These tests are really one assertion in several costumes:
 * the board leaves for a reason you could have predicted from the landing.
 *
 *   node --test test/bail.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Vector3, Quaternion } from 'three';

import Board from '../src/sim/Board.js';
import { bailThrow, evaluateLanding } from '../src/sim/Landing.js';

const UP = new Vector3(0, 1, 0);
const TRAVEL = new Vector3(0, 0, 1);

/** A board at `pos` with the given tilt about its long axis and spin. */
function board({ pos = [0, 0, 0], rollDeg = 0, spin = [0, 0, 0] } = {}) {
  const b = new Board();
  b.reset(new Vector3(...pos), 0);
  if (rollDeg) {
    b.quaternion.multiply(
      new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), (rollDeg * Math.PI) / 180),
    );
  }
  b.angularVelocity.set(...spin);
  return b;
}

const throwIt = (b, score, rider = new Vector3(0, 0, 0), speed = 11.11) =>
  bailThrow(b, { score }, TRAVEL, rider, speed);

test('a board that drifted out carries on the way it was going', () => {
  // "Board shot out" is a distinct failure from "never caught it", and it
  // should look distinct: the deck is already leaving, so it keeps leaving.
  const b = board({ pos: [1.2, 0, 0] });
  const t = throwIt(b, 0.1);
  assert.ok(t.velocity.x > 1, `went ${t.velocity.x} across`);
  // Mirrored, not merely "some direction".
  const mirrored = throwIt(board({ pos: [-1.2, 0, 0] }), 0.1);
  assert.ok(mirrored.velocity.x < -1);
  assert.ok(Math.abs(mirrored.velocity.x + t.velocity.x) < 1e-6, 'should be symmetric');
});

test('a board still under the feet shoots off the edge it is leaning on', () => {
  // Weight lands on a deck tipped onto one rail and it squirts out that side.
  // Which side is not a coin toss — it is the side it was tipped onto.
  const toe = throwIt(board({ rollDeg: 50 }), 0.2);
  const heel = throwIt(board({ rollDeg: -50 }), 0.2);
  assert.ok(Math.sign(toe.velocity.x) !== Math.sign(heel.velocity.x), 'leans must differ');
  assert.ok(Math.abs(toe.velocity.x) > 0.5 && Math.abs(heel.velocity.x) > 0.5);
});

test('a flat, centred board skitters forward rather than nowhere', () => {
  // The only way to bail one of these is on spin, and a board that is spinning
  // flat under your feet does go somewhere when you stand on it.
  const t = throwIt(board({ spin: [0, 0, 15] }), 0.2);
  assert.ok(t.velocity.length() > 1, 'it has to go somewhere');
  assert.ok(t.velocity.z > 0, 'and forward is the only direction it was given');
});

test('a spinning board keeps spinning, it does not get a new random spin', () => {
  const spinning = throwIt(board({ spin: [0, 0, 12] }), 0.2);
  assert.ok(spinning.angularVelocity.z > 12, 'the impact adds to it');
  // Same direction it was already turning: landing on it cannot reverse it.
  assert.equal(Math.sign(spinning.angularVelocity.z), 1);
  const other = throwIt(board({ spin: [0, 0, -12] }), 0.2);
  assert.equal(Math.sign(other.angularVelocity.z), -1);
});

test('but a board that was NOT spinning still tumbles when it is kicked', () => {
  // Otherwise a drift bail slides away perfectly flat, like a tray.
  const t = throwIt(board({ pos: [1.2, 0, 0] }), 0.2);
  assert.ok(t.angularVelocity.length() > 2, `only ${t.angularVelocity.length()}`);
});

test('a board that came in spinning absurdly does not leave as a food processor', () => {
  const t = throwIt(board({ spin: [0, 0, 60] }), 0);
  assert.ok(t.angularVelocity.length() <= 16 + 1e-9, `${t.angularVelocity.length()} rad/s`);
});

test('severity scales the whole thing, so a scrape differs from a slam', () => {
  const scrape = throwIt(board({ pos: [1.2, 0, 0] }), 0.95);
  const slam = throwIt(board({ pos: [1.2, 0, 0] }), 0.0);

  assert.ok(slam.severity > scrape.severity);
  assert.ok(slam.velocity.y > scrape.velocity.y, 'a harder hit pops it higher');
  // The rider keeps more of their speed on a scrape. This is the bit that used
  // to be a flat 0.55 whatever happened.
  assert.ok(scrape.riderKeep > slam.riderKeep);
  assert.ok(scrape.riderKeep <= 1 && slam.riderKeep > 0, 'and both stay sane');
  assert.ok(slam.recoverSeconds > scrape.recoverSeconds, 'and you are down longer');
});

test('the board never simply stops in front of a rider still travelling', () => {
  // It would be hit by them. Whatever else happens, it clears out.
  for (const score of [0, 0.25, 0.5, 0.75, 1]) {
    for (const pos of [[0, 0, 0], [1.2, 0, 0], [-0.4, 0, 0.3]]) {
      const t = throwIt(board({ pos }), score);
      assert.ok(t.velocity.z > 0, `score ${score} at ${pos} went backwards`);
      assert.ok(t.velocity.y > 0, 'and it has to come off the ground');
      assert.ok(Number.isFinite(t.velocity.length()), 'and be a number');
    }
  }
});

test('it is a pure function of the landing, so the same slam looks the same twice', () => {
  // The whole point. Run it twice and nothing moves.
  const a = throwIt(board({ pos: [0.9, 0, 0.2], rollDeg: 30, spin: [1, 2, 3] }), 0.3);
  const first = [...a.velocity.toArray(), ...a.angularVelocity.toArray()];
  const b = throwIt(board({ pos: [0.9, 0, 0.2], rollDeg: 30, spin: [1, 2, 3] }), 0.3);
  assert.deepEqual([...b.velocity.toArray(), ...b.angularVelocity.toArray()], first);
});

test('it takes the real evaluateLanding output, not a hand-made score', () => {
  // Guards the seam between the two: bailThrow reads `score`, and that is a
  // continuous 0..1 that evaluateLanding derives from four separate checks.
  const b = board({ pos: [1.6, 0, 0], rollDeg: 120, spin: [0, 0, 18] });
  const landing = evaluateLanding(b, UP, TRAVEL, new Vector3(0, 0, 0));
  assert.equal(landing.quality, 'BAIL');
  const t = bailThrow(b, landing, TRAVEL, new Vector3(0, 0, 0), 11.11);
  assert.ok(t.severity > 0.5, `severity ${t.severity} off a comprehensive bail`);
  assert.ok(t.recoverSeconds > 1.25);
});
