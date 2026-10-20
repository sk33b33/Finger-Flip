/**
 * The replay ring buffer.
 *
 * It records transforms rather than inputs — the answers, not the question —
 * so what it hands back is what was on screen and cannot drift from it. These
 * tests are mostly about the ring and the clip edges, which is where a buffer
 * like this goes wrong: one frame out at either end and the replay opens after
 * the pop or closes before the landing.
 *
 *   node --test test/replay.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Vector3, Quaternion } from 'three';

import Replay from '../src/game/Replay.js';

const bp = new Vector3();
const bq = new Quaternion();
const rp = new Vector3();
const rq = new Quaternion();

/** Record one frame whose values all encode `n`, so they can be read back. */
function frame(r, t, n = t) {
  bp.set(n, n * 2, n * 3);
  bq.set(0, 0, 0, 1);
  rp.set(-n, n, 0);
  rq.set(0, 0, 0, 1);
  r.record(t, bp, bq, rp, rq, n * 0.01, n * 0.02, 1);
}

const out = () => ({
  board: { position: new Vector3(), quaternion: new Quaternion() },
  rider: { position: new Vector3(), quaternion: new Quaternion() },
  pose: { crouch: 0, lean: 0, air: 0 },
});

// ----------------------------------------------------------------- ring ----

test('it fills up and then keeps the newest, not the oldest', () => {
  const r = new Replay({ seconds: 1, fps: 10 }); // 10 slots
  for (let i = 0; i < 10; i++) frame(r, i);
  assert.equal(r.count, 10);
  assert.equal(r.timeAt(0), 0);
  assert.equal(r.timeAt(9), 9);

  // Five more should push the first five out.
  for (let i = 10; i < 15; i++) frame(r, i);
  assert.equal(r.count, 10, 'it must not grow');
  assert.equal(r.timeAt(0), 5, 'oldest should now be frame 5');
  assert.equal(r.timeAt(9), 14);
});

test('time runs forwards across the wrap', () => {
  // A ring read in the wrong order gives a replay that plays backwards through
  // the seam, which looks like a physics bug rather than an indexing one.
  const r = new Replay({ seconds: 1, fps: 8 });
  for (let i = 0; i < 20; i++) frame(r, i * 0.1);
  for (let n = 1; n < r.count; n++) {
    assert.ok(r.timeAt(n) > r.timeAt(n - 1), `time went backwards at ${n}`);
  }
});

test('the buffer is allocated once and never reallocated', () => {
  const r = new Replay({ seconds: 1, fps: 10 });
  const buf = r.data;
  for (let i = 0; i < 500; i++) frame(r, i);
  assert.equal(r.data, buf, 'the backing array was replaced');
  assert.equal(r.data.length, 10 * 18);
});

test('reset empties it', () => {
  const r = new Replay({ seconds: 1, fps: 10 });
  for (let i = 0; i < 6; i++) frame(r, i);
  r.mark(2);
  r.reset();
  assert.equal(r.count, 0);
  assert.equal(r.markIn, null);
  assert.equal(r.clip(), null);
});

// ----------------------------------------------------------------- clip ----

test('a clip is padded either side of the trick', () => {
  // Starting exactly at the pop and stopping exactly at the wheels touching
  // cuts off the wind-up and the roll-away, which are half of what makes it
  // look like skating.
  const r = new Replay({ seconds: 10, fps: 10 });
  for (let i = 0; i <= 50; i++) frame(r, i * 0.1);
  r.mark(2.0);
  const clip = r.close(3.0);
  assert.ok(clip);
  assert.ok(r.timeAt(clip.from) < 2.0, 'should open before the pop');
  assert.ok(r.timeAt(clip.to) > 3.0, 'should close after the landing');
  assert.ok(clip.duration > 1.0);
});

test('a clip too short to be worth watching is refused', () => {
  const r = new Replay({ seconds: 10, fps: 10 });
  for (let i = 0; i <= 50; i++) frame(r, i * 0.1);
  r.mark(2.0);
  // Padding alone would make this look long enough; the frame count must also
  // be checked, or a two-frame "clip" is offered and plays as a freeze.
  const tiny = new Replay({ seconds: 10, fps: 10 });
  frame(tiny, 0);
  frame(tiny, 0.1);
  tiny.mark(0);
  assert.equal(tiny.close(0.1), null);
});

test('closing without a mark gives nothing rather than throwing', () => {
  const r = new Replay({ seconds: 2, fps: 10 });
  for (let i = 0; i < 10; i++) frame(r, i * 0.1);
  assert.equal(r.close(1), null);
  assert.equal(r.clip(), null);
});

test('a second mark replaces the first', () => {
  // Popping again before the replay is watched should give the new trick.
  const r = new Replay({ seconds: 10, fps: 10 });
  for (let i = 0; i <= 60; i++) frame(r, i * 0.1);
  r.mark(1.0);
  r.mark(4.0);
  const clip = r.close(5.0);
  assert.ok(r.timeAt(clip.from) > 3.0, 'still anchored to the first pop');
});

// --------------------------------------------------------------- sample ----

test('sampling walks the clip and then says it is done', () => {
  const r = new Replay({ seconds: 10, fps: 10 });
  for (let i = 0; i <= 40; i++) frame(r, i * 0.1);
  r.mark(1.0);
  const clip = r.close(3.0);
  const o = out();

  assert.equal(r.sample(clip, 0, o.board, o.rider, o.pose), true);
  const first = o.board.position.z;
  assert.equal(r.sample(clip, clip.duration * 0.5, o.board, o.rider, o.pose), true);
  assert.ok(o.board.position.z > first, 'it should have moved along');
  assert.equal(
    r.sample(clip, clip.duration + 1, o.board, o.rider, o.pose),
    false,
    'past the end it has to report that it is finished',
  );
});

test('it interpolates between frames rather than snapping to them', () => {
  // Playback is slower than the recording, so without this a replay is a
  // flipbook of whatever frame rate it happened to be captured at.
  const r = new Replay({ seconds: 10, fps: 10 });
  for (let i = 0; i <= 40; i++) frame(r, i * 0.1);
  r.mark(1.0);
  const clip = r.close(3.0);
  const o = out();

  const seen = new Set();
  for (let i = 0; i <= 20; i++) {
    r.sample(clip, (clip.duration * i) / 20, o.board, o.rider, o.pose);
    seen.add(o.board.position.x.toFixed(4));
  }
  // Twenty samples over a clip recorded at 10fps: snapping would give far
  // fewer distinct values than this.
  assert.ok(seen.size >= 18, `only ${seen.size} distinct positions`);
});

test('rotation is slerped, so it stays a unit quaternion', () => {
  // Lerping quaternions component-wise gives a shorter length and a board that
  // visibly shrinks and swells as it turns.
  const r = new Replay({ seconds: 10, fps: 10 });
  for (let i = 0; i <= 20; i++) {
    bp.set(0, 0, i);
    bq.setFromAxisAngle(new Vector3(0, 0, 1), (i / 20) * Math.PI * 1.5);
    rp.set(0, 0, i);
    rq.set(0, 0, 0, 1);
    r.record(i * 0.1, bp, bq, rp, rq, 0, 0, 1);
  }
  r.mark(0.3);
  const clip = r.close(1.5);
  const o = out();
  for (let i = 0; i <= 30; i++) {
    r.sample(clip, (clip.duration * i) / 30, o.board, o.rider, o.pose);
    assert.ok(Math.abs(o.board.quaternion.length() - 1) < 1e-5, 'not a unit quaternion');
  }
});

test('the pose comes back too, or the rider replays stood bolt upright', () => {
  const r = new Replay({ seconds: 10, fps: 10 });
  for (let i = 0; i <= 30; i++) frame(r, i * 0.1, i);
  r.mark(0.5);
  const clip = r.close(2.0);
  const o = out();
  r.sample(clip, clip.duration * 0.5, o.board, o.rider, o.pose);
  assert.ok(o.pose.crouch > 0, 'crouch was dropped');
  assert.ok(o.pose.lean > 0, 'lean was dropped');
  assert.equal(o.pose.air, 1);
});

test('the rider is recorded separately from the board', () => {
  // They are different objects in flight — that is the whole trick — so one
  // being derived from the other would make every replay an ollie.
  const r = new Replay({ seconds: 10, fps: 10 });
  for (let i = 0; i <= 30; i++) frame(r, i * 0.1, i);
  r.mark(0.5);
  const clip = r.close(2.0);
  const o = out();
  r.sample(clip, clip.duration * 0.5, o.board, o.rider, o.pose);
  assert.notEqual(o.board.position.x, o.rider.position.x);
});
