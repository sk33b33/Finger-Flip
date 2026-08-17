/**
 * Daily challenges.
 *
 * Every challenge is a pure function over an event object, returning how much
 * progress that event is worth. Nothing here reaches into the game: it is fed
 * the same breakdowns `ScoreSystem` already produces, which is why the whole
 * file is testable in Node with no DOM and no renderer.
 *
 *   ev = { type: 'trick', breakdown, mapId }   one landed or bailed trick
 *   ev = { type: 'run',   banked, mapId }      one banked line
 *
 * The day's set is chosen deterministically from the date, so it is the same
 * all day, changes at midnight, and needs no server to say so.
 */

/** @type {Array<{id, name, blurb, goal, unit, track: (ev) => number}>} */
export const CHALLENGES = [
  {
    id: 'kickflip-3',
    name: 'Flip Practice',
    blurb: 'Land three kickflips.',
    goal: 3,
    unit: 'landed',
    track: (ev) => (ev.type === 'trick' && named(ev, 'Kickflip') ? 1 : 0),
  },
  {
    id: 'heelflip-3',
    name: 'Other Foot',
    blurb: 'Land three heelflips.',
    goal: 3,
    unit: 'landed',
    track: (ev) => (ev.type === 'trick' && named(ev, 'Heelflip') ? 1 : 0),
  },
  {
    id: 'tre-1',
    name: 'The Tre',
    blurb: 'Land a 360 flip.',
    goal: 1,
    unit: 'landed',
    track: (ev) => (ev.type === 'trick' && named(ev, '360 Flip') ? 1 : 0),
  },
  {
    id: 'grab-2s',
    name: 'Hold It',
    blurb: 'Hold a grab for two seconds.',
    goal: 1,
    unit: 'held',
    track: (ev) => (ev.type === 'trick' && landed(ev) && ev.breakdown.grabHold >= 2 ? 1 : 0),
  },
  {
    id: 'perfect-5',
    name: 'Bolts',
    blurb: 'Land five tricks perfectly.',
    goal: 5,
    unit: 'landed',
    track: (ev) => (ev.type === 'trick' && ev.breakdown.quality === 'PERFECT' ? 1 : 0),
  },
  {
    id: 'combo-4',
    name: 'Link It',
    blurb: 'Land four tricks in one line.',
    goal: 1,
    unit: 'lines',
    // comboAt is the multiplier the trick scored at, which steps up once per
    // linked trick — so the fourth trick in a line is the first above 1.8.
    track: (ev) => (ev.type === 'trick' && landed(ev) && ev.breakdown.comboAt >= 1.8 ? 1 : 0),
  },
  {
    id: 'score-4000',
    name: 'Big Line',
    blurb: 'Bank 4,000 points in one line.',
    goal: 1,
    unit: 'lines',
    track: (ev) => (ev.type === 'run' && ev.banked >= 4000 ? 1 : 0),
  },
  {
    id: 'vert-2500',
    name: 'Bowl Session',
    blurb: 'Bank 2,500 points on Vert.',
    goal: 1,
    unit: 'lines',
    track: (ev) => (ev.type === 'run' && ev.mapId === 'vert' && ev.banked >= 2500 ? 1 : 0),
  },
  {
    id: 'slope-2500',
    name: 'Downhill',
    blurb: 'Bank 2,500 points on Slope.',
    goal: 1,
    unit: 'lines',
    track: (ev) => (ev.type === 'run' && ev.mapId === 'slope' && ev.banked >= 2500 ? 1 : 0),
  },
  {
    id: 'late-catch-3',
    name: 'Nerve',
    blurb: 'Catch the board late three times.',
    goal: 3,
    unit: 'catches',
    track: (ev) => (ev.type === 'trick' && landed(ev) && ev.breakdown.lateCatch ? 1 : 0),
  },
  {
    id: 'shove-3',
    name: 'Scoop',
    blurb: 'Land three shove-its.',
    goal: 3,
    unit: 'landed',
    track: (ev) => (ev.type === 'trick' && named(ev, 'Shove-it') ? 1 : 0),
  },
  {
    id: 'spin-180',
    name: 'Turn Around',
    blurb: 'Land a trick with a 180 or better.',
    goal: 1,
    unit: 'landed',
    track: (ev) =>
      ev.type === 'trick' && landed(ev) && Math.abs(ev.breakdown.bodyTurns) >= 0.45 ? 1 : 0,
  },
];

function landed(ev) {
  return ev.breakdown.quality !== 'BAIL';
}

/**
 * Matches a trick by name, allowing for the prefixes the recogniser adds —
 * "Fakie Kickflip" and "Nollie Kickflip" are kickflips, and a "Kickflip Indy"
 * still counts as one.
 */
function named(ev, name) {
  return landed(ev) && String(ev.breakdown.trick).includes(name);
}

export const DAILY_COUNT = 3;

/** Days since the epoch, in local time. The set turns over at local midnight. */
export function dayIndex(now = new Date()) {
  return Math.floor(
    (now.getTime() - now.getTimezoneOffset() * 60000) / 86400000,
  );
}

/**
 * The challenges for a given day. Deterministic and non-repeating within a day:
 * the offset walks the list by a stride coprime with its length, so consecutive
 * days get different sets rather than a rotation by one.
 */
export function dailyChallenges(day = dayIndex()) {
  const n = CHALLENGES.length;
  const stride = 5; // coprime with 12
  const out = [];
  for (let i = 0; i < DAILY_COUNT; i++) {
    out.push(CHALLENGES[(day * stride + i * 4) % n]);
  }
  return out;
}

/**
 * Score one event against a set of challenges.
 * @returns {Array<{id, amount}>} only the ones that moved
 */
export function scoreEvent(ev, challenges = dailyChallenges()) {
  const moved = [];
  for (const c of challenges) {
    const amount = c.track(ev) || 0;
    if (amount > 0) moved.push({ id: c.id, amount, goal: c.goal });
  }
  return moved;
}
