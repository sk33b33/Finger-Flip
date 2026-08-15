/**
 * TrickDefinition table + recogniser.
 *
 * Nothing in the physics knows what a kickflip is. The board simply integrates
 * its body rates; this module reads those integrals afterwards and works out
 * what the player just did. Adding a trick means adding a row here, never
 * touching the controller.
 *
 * Axes, in turns, from Board.spin:
 *   pitch (x)  end-over-end, the impossible axis
 *   yaw   (y)  flat spin, the shove-it axis
 *   roll  (z)  along the deck, the flip axis. Negative = kickflip side.
 */

/** @typedef {{name:string, roll:number, yaw:number, pitch:number, base:number, difficulty:number, tolerance:number}} TrickDefinition */

/** @type {TrickDefinition[]} */
export const TRICKS = [
  { name: 'Ollie', roll: 0, yaw: 0, pitch: 0, base: 100, difficulty: 1.0, tolerance: 0.2 },

  { name: 'Kickflip', roll: -1, yaw: 0, pitch: 0, base: 340, difficulty: 1.4, tolerance: 0.22 },
  { name: 'Heelflip', roll: 1, yaw: 0, pitch: 0, base: 360, difficulty: 1.45, tolerance: 0.22 },
  { name: 'Double Kickflip', roll: -2, yaw: 0, pitch: 0, base: 720, difficulty: 2.1, tolerance: 0.25 },
  { name: 'Double Heelflip', roll: 2, yaw: 0, pitch: 0, base: 760, difficulty: 2.15, tolerance: 0.25 },
  { name: 'Triple Kickflip', roll: -3, yaw: 0, pitch: 0, base: 1250, difficulty: 3.0, tolerance: 0.3 },

  { name: 'Pop Shove-it', roll: 0, yaw: -0.5, pitch: 0, base: 260, difficulty: 1.3, tolerance: 0.2 },
  { name: 'Frontside Shove-it', roll: 0, yaw: 0.5, pitch: 0, base: 270, difficulty: 1.3, tolerance: 0.2 },
  { name: '360 Shove-it', roll: 0, yaw: -1, pitch: 0, base: 520, difficulty: 1.8, tolerance: 0.24 },
  { name: 'Frontside 360 Shove-it', roll: 0, yaw: 1, pitch: 0, base: 540, difficulty: 1.85, tolerance: 0.24 },

  { name: 'Varial Kickflip', roll: -1, yaw: -0.5, pitch: 0, base: 520, difficulty: 1.9, tolerance: 0.24 },
  { name: 'Hardflip', roll: -1, yaw: 0.5, pitch: 0, base: 620, difficulty: 2.2, tolerance: 0.24 },
  { name: 'Varial Heelflip', roll: 1, yaw: 0.5, pitch: 0, base: 540, difficulty: 1.95, tolerance: 0.24 },
  { name: 'Inward Heelflip', roll: 1, yaw: -0.5, pitch: 0, base: 640, difficulty: 2.25, tolerance: 0.24 },

  { name: '360 Flip', roll: -1, yaw: -1, pitch: 0, base: 900, difficulty: 2.6, tolerance: 0.26 },
  { name: 'Laser Flip', roll: 1, yaw: 1, pitch: 0, base: 980, difficulty: 2.8, tolerance: 0.26 },
  { name: 'Nightmare Flip', roll: -2, yaw: -0.5, pitch: 0, base: 1150, difficulty: 3.1, tolerance: 0.28 },
  { name: 'Dragonflip', roll: 2, yaw: 1, pitch: 0, base: 1400, difficulty: 3.4, tolerance: 0.28 },
  { name: '540 Flip', roll: -1, yaw: -1.5, pitch: 0, base: 1300, difficulty: 3.2, tolerance: 0.28 },

  { name: 'Impossible', roll: 0, yaw: 0, pitch: -1, base: 700, difficulty: 2.4, tolerance: 0.26 },
  { name: 'Double Impossible', roll: 0, yaw: 0, pitch: -2, base: 1450, difficulty: 3.5, tolerance: 0.3 },
  { name: 'Anti-Casper Flip', roll: 0, yaw: 0, pitch: 1, base: 720, difficulty: 2.45, tolerance: 0.26 },
  { name: 'Pressure Flip', roll: -1, yaw: 0, pitch: -1, base: 1050, difficulty: 3.0, tolerance: 0.28 },
  { name: 'Ghetto Bird', roll: -1, yaw: -1, pitch: -1, base: 1600, difficulty: 3.8, tolerance: 0.3 },
];

const INDEX = new Map();
for (const t of TRICKS) INDEX.set(key(t.roll, t.yaw, t.pitch), t);

function key(roll, yaw, pitch) {
  return `${roll}|${yaw}|${pitch}`;
}

/** Snap a measured turn count to the nearest value a skater would name. */
function quantise(turns, step) {
  return Math.round(turns / step) * step;
}

/**
 * @param {{x:number,y:number,z:number}} spin body-rate integrals in turns
 * @returns {{name:string, base:number, difficulty:number, roll:number, yaw:number,
 *            pitch:number, error:number, exact:boolean, magnitude:number}}
 */
export function recognise(spin) {
  const roll = quantise(spin.z, 1);
  const yaw = quantise(spin.y, 0.5);
  const pitch = quantise(spin.x, 1);

  // How far off the ideal the player actually was. Feeds the style multiplier.
  const error =
    Math.abs(spin.z - roll) + Math.abs(spin.y - yaw) + Math.abs(spin.x - pitch);

  const magnitude = Math.abs(spin.z) + Math.abs(spin.y) + Math.abs(spin.x);

  const hit = INDEX.get(key(roll, yaw, pitch));
  if (hit) {
    return {
      name: hit.name,
      base: hit.base,
      difficulty: hit.difficulty,
      roll,
      yaw,
      pitch,
      error,
      exact: true,
      magnitude,
    };
  }

  return { ...compose(roll, yaw, pitch), roll, yaw, pitch, error, exact: false, magnitude };
}

/**
 * Anything outside the named table still gets a readable name and a score,
 * so the system never says "unknown trick" at the player.
 */
function compose(roll, yaw, pitch) {
  const parts = [];
  let base = 100;
  let difficulty = 1;

  const rollN = Math.abs(roll);
  if (rollN > 0) {
    const flip = roll < 0 ? 'Kickflip' : 'Heelflip';
    parts.push(rollN === 1 ? flip : `${countWord(rollN)} ${flip}`);
    base += 330 * rollN;
    difficulty += 0.45 * rollN;
  }

  const pitchN = Math.abs(pitch);
  if (pitchN > 0) {
    const p = pitch < 0 ? 'Impossible' : 'Anti-Casper';
    parts.push(pitchN === 1 ? p : `${countWord(pitchN)} ${p}`);
    base += 680 * pitchN;
    difficulty += 0.8 * pitchN;
  }

  const yawN = Math.abs(yaw);
  if (yawN > 0) {
    const deg = Math.round(yawN * 360);
    parts.push(`${deg} ${yaw < 0 ? 'Shove-it' : 'FS Shove-it'}`);
    base += 480 * yawN;
    difficulty += 0.5 * yawN;
  }

  if (parts.length === 0) return { name: 'Ollie', base: 100, difficulty: 1 };
  return { name: parts.join(' '), base: Math.round(base), difficulty: round2(difficulty) };
}

function countWord(n) {
  return ['', '', 'Double', 'Triple', 'Quad', 'Quint'][n] || `${n}x`;
}

function round2(v) {
  return Math.round(v * 100) / 100;
}

/**
 * The full call for a trick: board rotation, then grab, then body spin, in the
 * order a skater would say it. "Kickflip Indy 360".
 *
 * @param {{name:string}} trick   result from recognise()
 * @param {string|null}   grab    a grab name, or null
 * @param {number}        bodyTurns rider rotation in turns, signed
 */
export function fullName(trick, grab, bodyTurns = 0) {
  const parts = [];

  // An ollie with a grab is just the grab: nobody calls it an "Ollie Indy".
  if (trick.name !== 'Ollie' || !grab) parts.push(trick.name);
  if (grab) parts.push(grab);

  const halves = Math.round(Math.abs(bodyTurns) * 2);
  if (halves > 0) parts.push(`${halves * 180}`);

  return parts.join(' ');
}

/** Body spin quantised the way it is scored and named. */
export function quantiseBodySpin(turns) {
  return Math.round(turns * 2) / 2;
}

/** Human-readable rotation readout for the HUD during the trick. */
export function describeSpin(spin) {
  const deg = (t) => Math.round(t * 360);
  return {
    flip: deg(spin.z),
    shuv: deg(spin.y),
    pitch: deg(spin.x),
  };
}
