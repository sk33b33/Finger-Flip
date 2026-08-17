/**
 * The parks, as data.
 *
 * A layout is a lap: a terrain profile the ground follows, and a list of
 * features built on top of it. Everything else — collision, surface normals,
 * launch detection, the visual mesh — is derived from those two by sim/Park.js,
 * so adding a park means adding an entry here and nothing else.
 *
 * ## What bounds a layout
 *
 * These are not style notes. Each one has a test.
 *
 * - **The seam.** The terrain profile must start and end at y = 0, or the
 *   endless loop steps every lap.
 * - **The climb budget.** A rider at cruise can rise `v^2 / 2g` before
 *   stalling — 3.05m at 9.72 m/s. A feature taller than that is not a ramp, it
 *   is a wall you grind to a halt against.
 * - **The push budget.** Terrain is different: a long grade is pedalled up, not
 *   coasted, so what bounds it is the rider's acceleration (4.6 m/s^2) against
 *   gravity along the slope (15.5 * grade). Past a grade of about 0.28 the hill
 *   wins and the rider slides to a halt.
 * - **Looks.** The rider is glued to the height field, so a grade steep enough
 *   to outrun gravity reads as someone skating down a cliff face. Keep terrain
 *   under about 0.25.
 *
 * ## What this model cannot do
 *
 * Vertical. The rider follows a height function `h(x, z)` and always travels
 * +Z, so there is no dropping in, no turning around, and no wall steeper than
 * the climb budget allows. "Vert" here means the biggest transitions the model
 * supports — deep bowls to pump through and tall mellow quarterpipes to launch
 * off — not a halfpipe. Building a real one means a different movement model,
 * not a different layout.
 */

/** Shared feature vocabulary, for reference: see featureHeight() in Park.js.
 *
 *   kicker   z0,z1,height,halfWidth,curve      shallow entry, steep lip
 *   ledge    z0,z1,height,halfWidth,blend      raised slab, sharp far end
 *   quarter  z0,radius,height,halfWidth,facing true concave transition
 *   plateau  z0,z1,z2,z3,height,halfWidth      bank up, flat, drop off
 *   bank     z0,z1,height,halfWidth,facing     flat-faced ramp
 *   roller   z0,z1,height,halfWidth            a hump, ridden over
 *
 * All take an optional `offsetX` to sit off the centreline.
 */

export const LAYOUTS = [
  {
    id: 'funrun',
    name: 'Fun Run',
    blurb: 'A mixed street plaza on a long shallow hill. Everything the game has, once each.',
    runLength: 220,
    // Flat off the seam, a clear descent, a level middle, then a long shallow
    // recovery. The asymmetry is the point: the drop reads, the climb does not.
    terrain: [
      { z: 0, y: 0 },
      { z: 34, y: 0 },
      { z: 85, y: -3 },
      { z: 145, y: -3 },
      { z: 220, y: 0 },
    ],
    features: [
      // A gentle warm-up kicker.
      { type: 'kicker', z0: 26, z1: 32, height: 0.75, halfWidth: 5.0, curve: 2.0 },

      // A ledge to pop off the end of.
      { type: 'ledge', z0: 44, z1: 54, height: 0.4, halfWidth: 2.2, blend: 0.5 },

      // A true concave transition, the shape the park otherwise lacks entirely.
      { type: 'quarter', z0: 66, radius: 2.4, height: 1.1, halfWidth: 6.5 },

      // A bank up onto a plateau, then a drop off the far end.
      { type: 'plateau', z0: 92, z1: 99, z2: 111.4, z3: 112.8, height: 1.05, halfWidth: 7.0 },

      // Bank to bank: clear the gap or come up short.
      { type: 'bank', z0: 124, z1: 129, height: 1.0, halfWidth: 6.0, facing: 1 },
      { type: 'bank', z0: 135, z1: 140, height: 1.0, halfWidth: 6.0, facing: -1 },

      // The big one.
      { type: 'kicker', z0: 152, z1: 160.5, height: 1.25, halfWidth: 6.0, curve: 2.6 },

      // A hip: two kickers side by side, so the natural launch is off to one
      // side and the landing is not straight ahead. They share a lip line —
      // staggering them would leave a notch for a rider crossing the middle.
      { type: 'kicker', z0: 176, z1: 183, height: 1.05, halfWidth: 4.0, curve: 2.2, offsetX: -3.4 },
      { type: 'kicker', z0: 176, z1: 183, height: 1.05, halfWidth: 4.0, curve: 2.2, offsetX: 3.4 },

      // A rolling hump to finish, ridden over rather than off.
      { type: 'roller', z0: 196, z1: 208, height: 0.8, halfWidth: 8.0 },
    ],
  },

  {
    id: 'slope',
    name: 'Slope',
    blurb: 'A long hill run. Speed is free here, so the features are low and come fast.',
    runLength: 260,
    // Nine metres down over a hundred, then the same back over the rest. Peak
    // grade 0.125 either way: fast enough to pin the rider at the overspeed
    // ceiling all the way down, shallow enough to pedal back out.
    terrain: [
      { z: 0, y: 0 },
      { z: 12, y: 0 },
      { z: 120, y: -9 },
      { z: 150, y: -9 },
      { z: 260, y: 0 },
    ],
    features: [
      // Rollers to pump, spaced to come up quickly at hill speed.
      { type: 'roller', z0: 20, z1: 30, height: 0.7, halfWidth: 8.0 },
      { type: 'roller', z0: 36, z1: 45, height: 0.65, halfWidth: 8.0 },

      // A road gap: kick off the top, clear the flat, land on the down ramp.
      { type: 'kicker', z0: 56, z1: 62, height: 1.15, halfWidth: 5.5, curve: 2.4 },
      { type: 'bank', z0: 70, z1: 76, height: 0.9, halfWidth: 6.0, facing: -1 },

      // A low ledge on the fall line — easy to reach, hard to leave flat.
      { type: 'ledge', z0: 86, z1: 98, height: 0.35, halfWidth: 2.0, blend: 0.5 },

      // Twin kickers off to each side: pick a line.
      { type: 'kicker', z0: 108, z1: 114, height: 0.95, halfWidth: 3.6, curve: 2.2, offsetX: -4.2 },
      { type: 'kicker', z0: 108, z1: 114, height: 0.95, halfWidth: 3.6, curve: 2.2, offsetX: 4.2 },

      // The bottom of the valley, where the speed has nowhere to go but up.
      { type: 'kicker', z0: 128, z1: 137, height: 1.45, halfWidth: 6.5, curve: 2.6 },

      // Then the climb out, broken up so it is not just a long push.
      { type: 'roller', z0: 158, z1: 170, height: 0.75, halfWidth: 8.0 },
      { type: 'plateau', z0: 182, z1: 189, z2: 199, z3: 200.4, height: 0.85, halfWidth: 6.5 },
      { type: 'kicker', z0: 214, z1: 221, height: 1.0, halfWidth: 5.5, curve: 2.2 },
      { type: 'roller', z0: 236, z1: 248, height: 0.6, halfWidth: 8.0 },
    ],
  },

  {
    id: 'vert',
    name: 'Vert',
    blurb: 'Bowls to pump and the tallest transitions in the game. Everything here launches.',
    runLength: 200,
    // Two bowls in otherwise flat ground. Each drop is spread over enough
    // distance to stay a transition rather than a cliff, and shallow enough
    // that the far side can be pedalled back out of.
    terrain: [
      { z: 0, y: 0 },
      { z: 30, y: 0 },
      { z: 48, y: -2.2 },
      { z: 62, y: -2.2 },
      { z: 80, y: 0 },
      { z: 118, y: 0 },
      { z: 136, y: -2.4 },
      { z: 150, y: -2.4 },
      { z: 168, y: 0 },
      { z: 200, y: 0 },
    ],
    features: [
      // Roll-in kicker, so the first bowl is entered with speed.
      { type: 'kicker', z0: 18, z1: 24, height: 0.5, halfWidth: 7.0, curve: 2.0 },

      // Out of bowl one and straight up a tall mellow transition. A big radius
      // for the height keeps the face rideable — a tight one approaches
      // vertical at the lip and simply stops the rider dead.
      { type: 'quarter', z0: 82, radius: 6.0, height: 1.7, halfWidth: 8.0 },

      // A hip across the run-out, for spins. Spaced like Fun Run's so it still
      // reads down the centreline rather than only off to one side.
      { type: 'kicker', z0: 98, z1: 105, height: 1.0, halfWidth: 4.0, curve: 2.2, offsetX: -3.4 },
      { type: 'kicker', z0: 98, z1: 105, height: 1.0, halfWidth: 4.0, curve: 2.2, offsetX: 3.4 },

      // A deck over the near lip of bowl two: the drop off its end lands you
      // on the transition, so the whole bowl is entered in the air.
      { type: 'plateau', z0: 110, z1: 113, z2: 117, z3: 118.4, height: 1.0, halfWidth: 6.5 },

      // Bowl two, deeper, with the biggest transition in the game on the way out.
      { type: 'quarter', z0: 170, radius: 6.5, height: 1.9, halfWidth: 8.0 },

      // And a spine to finish: two banks back to back.
      { type: 'bank', z0: 182, z1: 187, height: 1.1, halfWidth: 6.0, facing: 1 },
      { type: 'bank', z0: 187, z1: 192, height: 1.1, halfWidth: 6.0, facing: -1 },
    ],
  },
];

export const DEFAULT_LAYOUT = 'funrun';

export function findLayout(id) {
  return LAYOUTS.find((l) => l.id === id) || null;
}
