/**
 * The roster, as data.
 *
 * view/RiderMesh.js builds every one of these from the same rig — the same
 * skeleton, the same stance, the same poses — so a character is a palette, a
 * head, something on the back, and a build. That is deliberate: the rider is
 * animated entirely through setPose / setBailPose, and every new sculpt would
 * be another thing to re-check at trick-camera range.
 *
 * Characters are cosmetic. None of them touches handling, because the trick
 * window is already fitted to the viewport and a second variable pulling on the
 * same feel would make both impossible to tune.
 *
 *   palette  suit / suitDark / trim / leather / accent / metal / lens
 *   head     'mask' | 'helmet' | 'hood' | 'cap'
 *   back     'katanas' | 'pack' | 'deck' | 'none'
 *   bulk     multiplies the limb and torso radii
 */

export const CHARACTERS = [
  {
    id: 'merc',
    name: 'The Merc',
    blurb: 'Red suit, two swords, no fear. Skates like he heals.',
    head: 'mask',
    back: 'katanas',
    bulk: 1.0,
    palette: {
      suit: 0x9c1c22,
      suitDark: 0x6b1216,
      trim: 0x1b1c20,
      leather: 0x7c5432,
      accent: 0xb02028,
      metal: 0xc9ced8,
      lens: 0xf4f4f2,
    },
  },
  {
    id: 'volt',
    name: 'Volt',
    blurb: 'Acid green and a full-face lid. Sends everything, lands most of it.',
    head: 'helmet',
    back: 'pack',
    bulk: 0.95,
    palette: {
      suit: 0xd7f23a,
      suitDark: 0x8fa61f,
      trim: 0x23262c,
      leather: 0x2f333a,
      accent: 0x1b1d22,
      metal: 0xb9c0cc,
      lens: 0x2ad1ff,
    },
  },
  {
    id: 'hollow',
    name: 'Hollow',
    blurb: 'Hood up, hands down. Never rushes a catch.',
    head: 'hood',
    back: 'none',
    bulk: 1.06,
    palette: {
      suit: 0x2c3038,
      suitDark: 0x1b1e24,
      trim: 0x0f1114,
      leather: 0x3a3f48,
      accent: 0x6d4bd6,
      metal: 0x8a8f9a,
      lens: 0x6d4bd6,
    },
  },
  {
    id: 'kite',
    name: 'Kite',
    blurb: 'Cap backwards, board on her back until the second she needs it.',
    head: 'cap',
    back: 'deck',
    bulk: 0.9,
    palette: {
      suit: 0xe0508f,
      suitDark: 0x9c2f60,
      trim: 0x1d1a22,
      leather: 0x4a3f52,
      accent: 0xffd23f,
      metal: 0xcfd4de,
      lens: 0x2a2030,
    },
  },
];

export const DEFAULT_CHARACTER = 'merc';

export function findCharacter(id) {
  return CHARACTERS.find((c) => c.id === id) || null;
}

/** Just the parts the roster UI needs, without the geometry hints. */
export function listCharacters() {
  return CHARACTERS.map(({ id, name, blurb, palette }) => ({
    id,
    name,
    blurb,
    swatch: palette,
  }));
}
