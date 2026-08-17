/**
 * What the game remembers about you between visits.
 *
 * One JSON blob in localStorage. Everything it records is already produced by
 * something else — `ScoreSystem.award()` returns a full breakdown for every
 * trick and `bank()` returns the banked line — so this file invents no numbers
 * of its own, it only keeps them.
 *
 * Two rules it has to obey:
 *
 *   - **Never throw.** localStorage is absent in Node, absent in some embedded
 *     webviews, and throws outright in Safari's private mode. A profile that
 *     cannot be saved is a shame; a profile that takes the game down with it is
 *     a bug.
 *   - **Never trust what it reads back.** The blob is user-editable and may
 *     have been written by an older version, so every field is merged onto a
 *     fresh default rather than used as-is.
 */

const KEY = 'fingerflip.profile.v1';
const VERSION = 1;

function emptyStats() {
  return {
    runs: 0,
    bails: 0,
    tricksLanded: 0,
    totalScore: 0,
    bestScore: 0,
    bestPerMap: {},
    bestCombo: 0,
    bestTrick: null, // { name, points, map }
    airTime: 0,
    trickCounts: {},
    grabCounts: {},
  };
}

function emptyProfile() {
  return {
    version: VERSION,
    characterId: null, // null = whatever the game defaults to
    mapId: null,
    stats: emptyStats(),
    events: {},
  };
}

/** localStorage, or null if there isn't one we can use. */
function storage() {
  try {
    if (typeof localStorage === 'undefined') return null;
    // Safari private mode has the object but throws on write, so prove it.
    const probe = '__ff__';
    localStorage.setItem(probe, '1');
    localStorage.removeItem(probe);
    return localStorage;
  } catch {
    return null;
  }
}

export default class Profile {
  /** @param {Storage|null} store injectable so the tests can run without a DOM */
  constructor(store = storage()) {
    this.store = store;
    this.data = this.read();
  }

  read() {
    const base = emptyProfile();
    if (!this.store) return base;
    try {
      const raw = this.store.getItem(KEY);
      if (!raw) return base;
      const saved = JSON.parse(raw);
      // Merge onto the defaults one level at a time: a blob written by an older
      // version is missing keys, and a hand-edited one may be missing anything.
      return {
        ...base,
        ...saved,
        version: VERSION,
        stats: { ...base.stats, ...(saved.stats || {}) },
        events: { ...(saved.events || {}) },
      };
    } catch {
      return base;
    }
  }

  save() {
    if (!this.store) return false;
    try {
      this.store.setItem(KEY, JSON.stringify(this.data));
      return true;
    } catch {
      return false;
    }
  }

  get stats() {
    return this.data.stats;
  }

  get events() {
    return this.data.events;
  }

  // ------------------------------------------------------------ choices ---

  select({ characterId, mapId }) {
    if (characterId !== undefined) this.data.characterId = characterId;
    if (mapId !== undefined) this.data.mapId = mapId;
    this.save();
  }

  // ------------------------------------------------------------ recording ---

  /**
   * One landed (or bailed) trick.
   * @param {object} breakdown the return value of ScoreSystem.award()
   * @param {string} mapId
   */
  recordTrick(breakdown, mapId) {
    const s = this.data.stats;
    if (breakdown.quality === 'BAIL') {
      s.bails++;
      this.save();
      return;
    }

    s.tricksLanded++;
    s.trickCounts[breakdown.trick] = (s.trickCounts[breakdown.trick] || 0) + 1;
    if (breakdown.grab) {
      s.grabCounts[breakdown.grab] = (s.grabCounts[breakdown.grab] || 0) + 1;
    }
    if (breakdown.comboAt > s.bestCombo) s.bestCombo = round2(breakdown.comboAt);
    if (!s.bestTrick || breakdown.points > s.bestTrick.points) {
      s.bestTrick = { name: breakdown.trick, points: breakdown.points, map: mapId };
    }
    this.save();
  }

  /**
   * A banked line. Called where ScoreSystem.bank() is consumed, so "run" here
   * means one linked line cashed in, which is the unit the game actually plays
   * in — not a lap of the park.
   */
  recordRun({ banked, mapId, airTime = 0 }) {
    const s = this.data.stats;
    s.runs++;
    s.totalScore += banked;
    s.airTime += airTime;
    if (banked > s.bestScore) s.bestScore = banked;
    if (mapId && banked > (s.bestPerMap[mapId] || 0)) s.bestPerMap[mapId] = banked;
    this.save();
  }

  bestOn(mapId) {
    return this.data.stats.bestPerMap[mapId] || 0;
  }

  // -------------------------------------------------------------- events ---

  /** Progress on one challenge, clamped at its goal so it cannot overshoot. */
  advanceEvent(id, amount, goal) {
    if (!amount) return this.data.events[id] || { progress: 0, done: false };
    const cur = this.data.events[id] || { progress: 0, done: false };
    const next = {
      progress: Math.min(goal, cur.progress + amount),
      done: cur.done || cur.progress + amount >= goal,
    };
    this.data.events[id] = next;
    this.save();
    return next;
  }

  eventProgress(id) {
    return this.data.events[id] || { progress: 0, done: false };
  }

  /** Wipe everything. The stats screen offers this and it should be honest. */
  reset() {
    this.data = emptyProfile();
    this.save();
  }
}

function round2(v) {
  return Math.round(v * 100) / 100;
}
