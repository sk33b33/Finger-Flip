/**
 * Unlocks.
 *
 * The design decision worth testing is that nothing is stored: whether a thing
 * is unlocked is computed from the stats every time it is asked. That rules out
 * the whole class of bug where the two disagree — so most of what follows is
 * checking that the derivation really is a derivation.
 *
 *   node --test test/unlocks.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  UNLOCKS,
  deckStates,
  earnedSet,
  isUnlocked,
  newlyEarned,
  requirementFor,
  riderStates,
  statusOf,
  titleOf,
} from '../src/game/Unlocks.js';
import { CHARACTERS, DEFAULT_CHARACTER } from '../src/view/Characters.js';
import { DECKS, STOCK } from '../src/view/Decks.js';

const fresh = () => ({
  bestScore: 0,
  totalScore: 0,
  tricksLanded: 0,
  bails: 0,
  bestCombo: 1,
  airTime: 0,
  trickCounts: {},
  skateGames: 0,
  skateLanded: 0,
  skateBest: 0,
});
const noProfile = { events: {} };

// ---------------------------------------------------------------- shape ----

test('every unlock points at something that exists', () => {
  // A table entry naming a rider or deck that was renamed would be a
  // requirement nobody could ever satisfy into anything.
  for (const u of UNLOCKS) {
    const pool = u.kind === 'rider' ? CHARACTERS : DECKS;
    assert.ok(pool.some((x) => x.id === u.ref), `${u.id} points at missing ${u.ref}`);
    assert.ok(u.label && u.label.length > 4, `${u.id} has no readable requirement`);
    assert.ok(u.goal > 0, `${u.id} has no goal`);
    assert.equal(typeof u.at, 'function');
    assert.ok(titleOf(u), `${u.id} has no title`);
  }
  // And ids are unique, or earnedSet silently collapses two into one.
  assert.equal(new Set(UNLOCKS.map((u) => u.id)).size, UNLOCKS.length);
});

test('the defaults are free, whatever the stats say', () => {
  // A wiped profile has to have somebody to skate as and something to skate on.
  const s = fresh();
  assert.equal(riderStates(s, noProfile).find((r) => r.id === DEFAULT_CHARACTER).unlocked, true);
  assert.equal(deckStates(s, noProfile).find((d) => d.id === STOCK).unlocked, true);
  assert.equal(requirementFor('rider', DEFAULT_CHARACTER), null);
  assert.equal(requirementFor('deck', STOCK), null);
});

test('and everything else starts locked', () => {
  const s = fresh();
  const locked = [
    ...riderStates(s, noProfile).filter((r) => !r.unlocked),
    ...deckStates(s, noProfile).filter((d) => !d.unlocked),
  ];
  assert.equal(locked.length, UNLOCKS.length, 'a new profile should have exactly the table locked');
  for (const l of locked) assert.ok(l.label, 'a locked thing must say what it needs');
});

// ----------------------------------------------------------- derivation ----

test('nothing is stored: the same stats always give the same answer', () => {
  const s = fresh();
  s.tricksLanded = 25;
  assert.equal(isUnlocked('deck', 'acid', s, noProfile), true);
  // Take it away again and it goes. That is the deal: Erase means erase.
  s.tricksLanded = 0;
  assert.equal(isUnlocked('deck', 'acid', s, noProfile), false);
});

test('progress is reported, and clamped at the goal', () => {
  const s = fresh();
  s.tricksLanded = 10;
  let st = statusOf('deck', 'acid', s, noProfile);
  assert.equal(st.progress, 10);
  assert.equal(st.goal, 25);
  assert.equal(st.unlocked, false);

  s.tricksLanded = 400;
  st = statusOf('deck', 'acid', s, noProfile);
  assert.equal(st.unlocked, true);
  assert.equal(st.progress, 25, 'a bar cannot be more than full');
});

test('each requirement is driven by the stat it names', () => {
  const drives = [
    ['deck', 'acid', (s) => (s.tricksLanded = 25)],
    ['deck', 'grid', (s) => (s.totalScore = 10000)],
    ['deck', 'flare', (s) => (s.trickCounts = Object.fromEntries('abcdefgh'.split('').map((k) => [k, 1])))],
    ['deck', 'mono', (s) => (s.skateBest = 5)],
    ['rider', 'hollow', (s) => (s.bestScore = 5000)],
    ['rider', 'kite', (s) => (s.bestCombo = 3)],
  ];
  for (const [kind, ref, apply] of drives) {
    const s = fresh();
    assert.equal(isUnlocked(kind, ref, s, noProfile), false, `${ref} started unlocked`);
    apply(s);
    assert.equal(isUnlocked(kind, ref, s, noProfile), true, `${ref} did not respond to its stat`);
    // And ONLY to its own: nothing else should have come with it.
    const others = UNLOCKS.filter((u) => u.ref !== ref && u.at(s, noProfile) >= u.goal);
    assert.deepEqual(others.map((u) => u.id), [], `${ref} also unlocked ${others.map((u) => u.id)}`);
  }
});

test('the challenge count comes off the events, not the stats', () => {
  const s = fresh();
  assert.equal(isUnlocked('rider', 'volt', s, { events: {} }), false);
  assert.equal(
    isUnlocked('rider', 'volt', s, { events: { a: { done: true }, b: { done: true } } }),
    false,
    'two is not three',
  );
  assert.equal(
    isUnlocked('rider', 'volt', s, {
      events: { a: { done: true }, b: { done: true }, c: { done: true }, d: { done: false } },
    }),
    true,
  );
  // A missing profile must not throw: the menu renders before a run starts.
  assert.equal(isUnlocked('rider', 'volt', s, undefined), false);
  assert.equal(isUnlocked('rider', 'volt', s, {}), false);
});

test('landing eight of the SAME trick is not landing eight tricks', () => {
  // The requirement is range, and counting entries rather than totals is what
  // makes it range instead of a grind.
  const s = fresh();
  s.trickCounts = { Kickflip: 400 };
  assert.equal(isUnlocked('deck', 'flare', s, noProfile), false);
});

// -------------------------------------------------------------- the diff ---

test('newly earned is the difference, and only fires once', () => {
  const s = fresh();
  const before = earnedSet(s, noProfile);
  assert.equal(before.size, 0);

  s.tricksLanded = 25;
  const after = earnedSet(s, noProfile);
  const fired = newlyEarned(before, after);
  assert.deepEqual(fired.map((u) => u.id), ['deck-acid']);

  // Checked again against the new baseline, nothing is new.
  s.tricksLanded = 30;
  assert.deepEqual(newlyEarned(after, earnedSet(s, noProfile)), []);
});

test('two earned at once both come back', () => {
  const s = fresh();
  const before = earnedSet(s, noProfile);
  s.tricksLanded = 25;
  s.bestScore = 5000;
  const fired = newlyEarned(before, earnedSet(s, noProfile));
  assert.equal(fired.length, 2);
  assert.deepEqual(new Set(fired.map((u) => u.id)), new Set(['deck-acid', 'rider-hollow']));
});

test('an unknown thing is treated as free rather than as broken', () => {
  // Nothing should ask, but a menu rendering against a stale state should not
  // lock the player out of their own board over it.
  const st = statusOf('deck', 'no-such-deck', fresh(), noProfile);
  assert.equal(st.unlocked, true);
});

// --------------------------------------------------------------- decks -----

test('every deck draws something, except the stock one', () => {
  for (const d of DECKS) {
    assert.ok(d.name && d.blurb, `${d.id} is unlabelled`);
    if (d.id === STOCK) {
      assert.equal(d.draw, null, 'the stock deck keeps the imported artwork');
    } else {
      assert.equal(typeof d.draw, 'function', `${d.id} has nothing to draw`);
    }
  }
  assert.equal(new Set(DECKS.map((d) => d.id)).size, DECKS.length);
});
