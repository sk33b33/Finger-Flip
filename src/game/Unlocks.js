/**
 * What the stats are for.
 *
 * The profile has been recording a great deal — tricks landed, points banked,
 * best combo, air time, which tricks and how often — and none of it did
 * anything. The stats screen was a wall of numbers with nothing on the other
 * side of it. This is the other side.
 *
 * ## Derived, never stored
 *
 * There is no `unlocked: []` array in the profile. Whether something is
 * unlocked is computed from the stats every time it is asked. That rules out
 * the entire class of bug where the two disagree — a stat recorded but the
 * unlock missed, an unlock granted against a stat that was later wiped, a
 * saved list from an older build naming things that no longer exist. Erase
 * your stats and you genuinely start again, which is what Erase says it does.
 *
 * The cost is that a requirement can never be made *harder* without taking
 * something off a player who had it. That is a fine trade and worth knowing.
 *
 * ## Shaped around the first hour
 *
 * Everything here is reachable by somebody who is still learning. The point is
 * to give the numbers a direction, not to build a second game on top of the
 * first one.
 */

import { CHARACTERS, DEFAULT_CHARACTER } from '../view/Characters.js';
import { DECKS, STOCK } from '../view/Decks.js';

/**
 * @typedef {{id:string, kind:'rider'|'deck', ref:string, label:string,
 *            goal:number, at:(stats:object, profile:object)=>number}} Unlock
 */

/** How many of the day's challenges have ever been cleared. */
function challengesDone(_stats, profile) {
  return Object.values(profile?.events || {}).filter((e) => e.done).length;
}

/** How many DIFFERENT tricks have been landed, which rewards range not grinding. */
function distinctTricks(stats) {
  return Object.keys(stats.trickCounts || {}).length;
}

/** @type {Unlock[]} */
export const UNLOCKS = [
  // --- riders -------------------------------------------------------------
  {
    id: 'rider-volt',
    kind: 'rider',
    ref: 'volt',
    label: 'Clear 3 daily challenges',
    goal: 3,
    at: challengesDone,
  },
  {
    id: 'rider-hollow',
    kind: 'rider',
    ref: 'hollow',
    label: 'Bank a 5,000 line',
    goal: 5000,
    at: (s) => s.bestScore,
  },
  {
    id: 'rider-kite',
    kind: 'rider',
    ref: 'kite',
    label: 'Reach a 3x combo',
    goal: 3,
    at: (s) => s.bestCombo || 1,
  },

  // --- decks --------------------------------------------------------------
  {
    id: 'deck-acid',
    kind: 'deck',
    ref: 'acid',
    label: 'Land 25 tricks',
    goal: 25,
    at: (s) => s.tricksLanded,
  },
  {
    id: 'deck-grid',
    kind: 'deck',
    ref: 'grid',
    label: 'Score 10,000 in total',
    goal: 10000,
    at: (s) => s.totalScore,
  },
  {
    id: 'deck-flare',
    kind: 'deck',
    ref: 'flare',
    label: 'Land 8 different tricks',
    goal: 8,
    at: distinctTricks,
  },
  {
    id: 'deck-mono',
    kind: 'deck',
    ref: 'mono',
    label: 'Land 5 calls in one game of S.K.A.T.E.',
    goal: 5,
    at: (s) => s.skateBest || 0,
  },
];

const BY_REF = new Map(UNLOCKS.map((u) => [`${u.kind}:${u.ref}`, u]));

/**
 * The requirement for a thing, or null if it is free.
 * @param {'rider'|'deck'} kind
 */
export function requirementFor(kind, ref) {
  return BY_REF.get(`${kind}:${ref}`) || null;
}

/**
 * How far along a requirement is.
 * @returns {{unlocked:boolean, progress:number, goal:number, label:string}}
 */
export function statusOf(kind, ref, stats, profile) {
  const req = requirementFor(kind, ref);
  if (!req) return { unlocked: true, progress: 1, goal: 1, label: '' };
  const at = req.at(stats, profile) || 0;
  return {
    unlocked: at >= req.goal,
    progress: Math.min(at, req.goal),
    goal: req.goal,
    label: req.label,
  };
}

export function isUnlocked(kind, ref, stats, profile) {
  return statusOf(kind, ref, stats, profile).unlocked;
}

/** Every unlock id currently earned, for spotting what is new. */
export function earnedSet(stats, profile) {
  const out = new Set();
  for (const u of UNLOCKS) {
    if (u.at(stats, profile) >= u.goal) out.add(u.id);
  }
  return out;
}

/**
 * What has been earned since a previous snapshot. Used to say so at the moment
 * it happens, rather than leaving it to be noticed in a menu.
 */
export function newlyEarned(before, after) {
  return UNLOCKS.filter((u) => after.has(u.id) && !before.has(u.id));
}

/** Riders, each with whether it can be picked and what it would take. */
export function riderStates(stats, profile) {
  return CHARACTERS.map((c) => ({
    id: c.id,
    ...statusOf('rider', c.id, stats, profile),
    // The default has to stay pickable whatever the stats say, or a wiped
    // profile has nobody to skate as.
    ...(c.id === DEFAULT_CHARACTER ? { unlocked: true } : {}),
  }));
}

/** Decks, same. */
export function deckStates(stats, profile) {
  return DECKS.map((d) => ({
    id: d.id,
    ...statusOf('deck', d.id, stats, profile),
    ...(d.id === STOCK ? { unlocked: true } : {}),
  }));
}

/** A readable name for an unlock, for the moment it lands. */
export function titleOf(unlock) {
  const source = unlock.kind === 'rider' ? CHARACTERS : DECKS;
  return source.find((x) => x.id === unlock.ref)?.name || unlock.ref;
}
