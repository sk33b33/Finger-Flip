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
 * One of them carries a `model` instead of a build. That one is a rigged glTF
 * posed by view/GlbRider.js rather than primitives posed by RiderMesh; both
 * answer to the same setPose, so Game holds either without knowing which.
 *
 *   palette  suit / suitDark / trim / leather / accent / metal / lens
 *   head     'mask' | 'helmet' | 'hood' | 'cap'
 *   back     'katanas' | 'pack' | 'deck' | 'none'
 *   bulk     multiplies the limb and torso radii
 */

export const CHARACTERS = [
  {
    // The one rider that is not built out of primitives. `model` is what makes
    // the difference: Game hands an entry with one to view/GlbRider.js, which
    // drives a rigged skeleton through the same setPose the others use.
    //
    // He replaced The Merc, who was modelled on Deadpool — fine for a
    // prototype and not fine for anything published. That was the one thing in
    // this project taken from somewhere else; this is a properly licensed
    // model, so it is no longer true of anything here.
    id: 'james',
    name: 'James',
    blurb: 'Black on black, cap down, headphones on. Rides like he has nowhere to be.',
    model: 'rider-james.glb',
    // Read by the roster UI for the swatch, since there is no palette to show.
    palette: {
      suit: 0x14161c,
      suitDark: 0x0a0b0f,
      trim: 0x2b2f38,
      leather: 0xb8402f,
      accent: 0xd8d2cc,
      metal: 0xc9ced8,
      lens: 0x1a1d24,
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

export const DEFAULT_CHARACTER = 'james';

export function findCharacter(id) {
  return CHARACTERS.find((c) => c.id === id) || null;
}

/**
 * Resolve a saved id to one that still exists.
 *
 * Profiles are kept across versions and The Merc was removed, so a returning
 * player has `characterId: 'merc'` in localStorage pointing at nobody. Falling
 * back is the whole job — the alternative is a rider that silently fails to
 * build on someone else's machine and nowhere else.
 */
export function resolveCharacter(id) {
  return findCharacter(id) || findCharacter(DEFAULT_CHARACTER) || CHARACTERS[0];
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

/** Where a rider's model lives, or null for the ones built from primitives. */
export function modelFor(id) {
  return findCharacter(id)?.model || null;
}
