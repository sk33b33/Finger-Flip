/**
 * Profile persistence and daily challenges.
 *
 * Both are pure enough to run in Node: Profile takes its storage by injection
 * and Events is a table of functions over plain objects.
 *
 *   node --test test/profile.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import Profile from '../src/game/Profile.js';
import { CHALLENGES, dailyChallenges, scoreEvent, dayIndex, DAILY_COUNT } from '../src/game/Events.js';

/** A localStorage stand-in. */
function fakeStore(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    get size() {
      return map.size;
    },
    raw: map,
  };
}

/** A breakdown shaped like the one ScoreSystem.award() returns. */
function trick(over = {}) {
  return {
    trick: 'Kickflip',
    bodyTurns: 0,
    quality: 'CLEAN',
    points: 900,
    comboAt: 1,
    caught: true,
    lateCatch: false,
    ...over,
  };
}

// ------------------------------------------------------------- profile ----

test('a profile with no storage still works', () => {
  // Node has no localStorage, and neither does Safari in private mode — it
  // throws outright. Losing the save is acceptable; taking the game down is not.
  const p = new Profile(null);
  p.recordTrick(trick(), 'funrun');
  p.recordRun({ banked: 1200, mapId: 'funrun' });
  assert.equal(p.stats.tricksLanded, 1);
  assert.equal(p.stats.bestScore, 1200);
  assert.equal(p.save(), false);
});

test('stats survive a reload', () => {
  const store = fakeStore();
  const a = new Profile(store);
  a.recordTrick(trick({ trick: 'Heelflip', points: 1500 }), 'vert');
  a.recordRun({ banked: 3000, mapId: 'vert', airTime: 2.4 });
  a.select({ characterId: 'volt', mapId: 'vert' });

  const b = new Profile(store);
  assert.equal(b.stats.tricksLanded, 1);
  assert.equal(b.stats.trickCounts.Heelflip, 1);
  assert.equal(b.stats.bestScore, 3000);
  assert.equal(b.bestOn('vert'), 3000);
  assert.equal(b.data.characterId, 'volt');
  assert.equal(b.data.mapId, 'vert');
  assert.ok(Math.abs(b.stats.airTime - 2.4) < 1e-9);
});

test('a corrupt or half-written save does not break the game', () => {
  for (const raw of ['not json', '{', 'null', '[]', '{"stats":null}', '{"stats":{"runs":7}}']) {
    const p = new Profile(fakeStore({ 'fingerflip.profile.v1': raw }));
    // Every field has to be present and the right shape whatever was in there.
    assert.equal(typeof p.stats.tricksLanded, 'number');
    assert.equal(typeof p.stats.trickCounts, 'object');
    assert.equal(typeof p.events, 'object');
    p.recordTrick(trick(), 'funrun'); // must not throw
  }
  // And a partial save keeps what it had.
  const kept = new Profile(fakeStore({ 'fingerflip.profile.v1': '{"stats":{"runs":7}}' }));
  assert.equal(kept.stats.runs, 7);
});

test('a bail counts as a bail and nothing else', () => {
  const p = new Profile(fakeStore());
  p.recordTrick(trick({ quality: 'BAIL', points: 0 }), 'funrun');
  assert.equal(p.stats.bails, 1);
  assert.equal(p.stats.tricksLanded, 0);
  assert.equal(p.stats.bestTrick, null);
});

test('the best trick and best combo are the best ones seen', () => {
  const p = new Profile(fakeStore());
  p.recordTrick(trick({ points: 400, comboAt: 1 }), 'funrun');
  p.recordTrick(trick({ trick: '360 Flip', points: 2600, comboAt: 2.4 }), 'vert');
  p.recordTrick(trick({ points: 900, comboAt: 1.6 }), 'funrun');
  assert.equal(p.stats.bestTrick.name, '360 Flip');
  assert.equal(p.stats.bestTrick.points, 2600);
  assert.equal(p.stats.bestTrick.map, 'vert');
  assert.equal(p.stats.bestCombo, 2.4);
});

test('per-map bests are kept apart', () => {
  const p = new Profile(fakeStore());
  p.recordRun({ banked: 5000, mapId: 'funrun' });
  p.recordRun({ banked: 1200, mapId: 'vert' });
  assert.equal(p.bestOn('funrun'), 5000);
  assert.equal(p.bestOn('vert'), 1200);
  assert.equal(p.bestOn('slope'), 0);
  assert.equal(p.stats.totalScore, 6200);
  assert.equal(p.stats.runs, 2);
});

test('event progress clamps at the goal', () => {
  const p = new Profile(fakeStore());
  p.advanceEvent('kickflip-3', 1, 3);
  p.advanceEvent('kickflip-3', 1, 3);
  assert.equal(p.eventProgress('kickflip-3').done, false);
  p.advanceEvent('kickflip-3', 1, 3);
  assert.equal(p.eventProgress('kickflip-3').progress, 3);
  assert.equal(p.eventProgress('kickflip-3').done, true);
  p.advanceEvent('kickflip-3', 5, 3);
  assert.equal(p.eventProgress('kickflip-3').progress, 3, 'should not overshoot');
});

// -------------------------------------------------------------- events ----

test('every challenge is well formed', () => {
  const ids = new Set();
  for (const c of CHALLENGES) {
    assert.ok(c.id && !ids.has(c.id), `duplicate or missing id: ${c.id}`);
    ids.add(c.id);
    assert.ok(c.name && c.blurb, `${c.id} needs a name and a blurb`);
    assert.ok(c.goal >= 1, `${c.id} has no goal`);
    assert.equal(typeof c.track, 'function');
  }
});

test('a challenge never scores a bail', () => {
  // Every one of these is "land something", so a slam must not count toward any
  // of them — including the ones that only look at a number on the breakdown.
  const bail = { type: 'trick', mapId: 'funrun', breakdown: trick({ quality: 'BAIL', comboAt: 6, lateCatch: true, bodyTurns: 1 }) };
  for (const c of CHALLENGES) {
    assert.equal(c.track(bail), 0, `${c.id} scored a bail`);
  }
});

test('challenges match the tricks they name', () => {
  const flip = { type: 'trick', mapId: 'funrun', breakdown: trick({ trick: 'Kickflip' }) };
  const moved = scoreEvent(flip, CHALLENGES);
  assert.ok(moved.some((m) => m.id === 'kickflip-3'), 'a kickflip should move the kickflip goal');
  assert.ok(!moved.some((m) => m.id === 'heelflip-3'), 'and not the heelflip one');

  // The recogniser prefixes stance, so those have to count too.
  const fakie = { type: 'trick', mapId: 'funrun', breakdown: trick({ trick: 'Fakie Kickflip' }) };
  assert.ok(scoreEvent(fakie, CHALLENGES).some((m) => m.id === 'kickflip-3'));
});

test('map-specific challenges only count on their map', () => {
  const on = { type: 'run', mapId: 'vert', banked: 3000 };
  const off = { type: 'run', mapId: 'funrun', banked: 3000 };
  assert.ok(scoreEvent(on, CHALLENGES).some((m) => m.id === 'vert-2500'));
  assert.ok(!scoreEvent(off, CHALLENGES).some((m) => m.id === 'vert-2500'));
});

test('the daily set is stable within a day and turns over between them', () => {
  const today = dayIndex();
  const a = dailyChallenges(today).map((c) => c.id);
  const b = dailyChallenges(today).map((c) => c.id);
  assert.deepEqual(a, b, 'the same day must give the same set');
  assert.equal(a.length, DAILY_COUNT);
  assert.equal(new Set(a).size, DAILY_COUNT, 'a day must not repeat a challenge');

  const tomorrow = dailyChallenges(today + 1).map((c) => c.id);
  assert.notDeepEqual(a, tomorrow, 'consecutive days should differ');
});

test('every challenge comes up eventually', () => {
  // A challenge nobody is ever given is dead content.
  const seen = new Set();
  for (let d = 0; d < 400; d++) for (const c of dailyChallenges(d)) seen.add(c.id);
  for (const c of CHALLENGES) {
    assert.ok(seen.has(c.id), `${c.id} is never selected`);
  }
});
