# Finger Flip

A 3D skateboarding game where you flip the board with **a finger from each hand**.

You roll in at speed. You pop off a lip. Then the world drops into slow motion,
the camera slams in until the deck fills the screen, and the trick is entirely
in your hands: two fingers on the board, working the deck until it comes round
the way you want it, and a catch to stop it flat before you land.

Runs in the browser. Real multi-touch on a phone or tablet, keyboard on a
desktop, no install and no asset downloads — every texture, sound and piece of
geometry in the game is generated at runtime.

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # headless simulation + trick-vocabulary tests
npm run build      # static bundle in dist/
```

## How it plays

**Rolling.** Steer with `A`/`D` or by dragging left and right. Hold `Space`
(or hold anywhere on screen) to load up your pop, release to ollie. The marked
lips launch you whether you popped or not — popping just gets you higher.

**In the air.** Put a finger on each end of the board. Every finger that is
touching is *pressing down on the deck*, and everything follows from where it
presses:

| What you do | What the board does |
| --- | --- |
| Slide a finger off the **toe rail** (orange) | Kickflip |
| Slide a finger off the **heel rail** (cyan) | Heelflip |
| Short scoop **across the tail** | Shove-it |
| Rail flick + an **opposing** scoop | Varial / hardflip / 360 flip |
| Slow, deliberate drag out to a **tip** | Impossible |
| Two flicks in one flight | Doubles |
| **Plant** a finger back on the spinning deck | Catch — stops the rotation dead |

The catch is the skill. A flick starts the board spinning; it keeps spinning
until something stops it. Put a finger back on the deck as it comes round flat
and you keep exactly the rotation you had at that moment. Catch late and you
score more.

Press `Space` (or the **LAND IT** button) to drop out of slow motion and take
the landing whenever you are ready.

**Keyboard fingers.** `W A S D` drives one finger, the arrow keys the other —
a direct stand-in for the two touch points, so tricks are identical on both.
`Q` and `/` plant a finger without moving it, which is how you catch.

`H` controls · `R` restart the run · `M` mute · `P` toggle post-processing

## How it works

The interesting part is that **nothing in the physics knows what a kickflip
is**. There is no trick list driving the simulation and no canned animation. A
contacting finger applies a press and a scrape at a point on the deck, and the
board integrates one cross product:

```
tau = r x F
```

- press at the tail (`r.z < 0`) → pitch: the pop, the impossible
- press on the toe rail (`r.x > 0`) → negative roll: a kickflip
- press on the heel rail (`r.x < 0`) → positive roll: a heelflip
- scrape sideways across an end → yaw: a shove-it
- do two at once → a 360 flip, with nothing special-cased

The board accumulates its body-rate integrals, and `sim/Tricks.js` reads them
*afterwards* and works out what you just did. Adding a trick means adding a row
to a table; it never means touching the controller.

Two refinements keep the moves separable rather than smearing into each other,
and both are things a real deck does:

- **Grip dies toward the rail.** A finger sliding over the edge is rolling off
  it, not pushing along it. That is what makes a rail flick a clean flip while a
  scoop across the middle still shoves.
- **A fast finger skims, a slow one levers.** A deliberate press on the tail
  pitches the board end over end; a quick flick past the same point barely does.
  Without this, every flip turns into an accidental nosedive.

### Slow motion

`core/GameTime.js` owns the split between real time and world time. The
renderer, camera, input sampling and UI all run on real time; only the physics
consumes world time. Finger impulses are computed against *real* elapsed time,
so an identical flick delivers an identical spin rate whatever the time scale
is — what slow motion buys you is real seconds to act in, not extra force.
There is a test for exactly that.

The time scale is also responsive: it sits deepest while a finger is working the
deck and runs on when both are off it, so waiting for the board to come round
never becomes dead time. Set `Config.nail.idleTimeScale` equal to
`Config.nail.timeScale` for a flat, old-school slow-motion window.

### Everything else

- **Fixed-timestep simulation** at 240Hz of world time with interpolated
  rendering, so motion stays smooth at any refresh rate.
- **The finger sweep is substepped**, so a flick that crosses the whole deck
  inside one frame cannot skip the contact window. The mechanic behaves the same
  at 30fps as at 144 — also tested.
- **The park is one height function.** Collision, surface normals, camera
  clearance and the visual mesh all come from `sim/Park.js`, so what you see is
  exactly what you land on. Three copies of the tile cycle around the rider for
  an endless run.
- **Post-processing** is a small hand-rolled composer: MSAA HDR target, two-level
  bloom, then a single composite doing radial motion blur, chromatic aberration,
  a slow-motion grade, vignette and grain — all keyed off one `slowmo` uniform
  so the whole look ramps together.
- **Audio** is synthesised from noise and oscillators at runtime. The mix runs
  through one filtered bus that closes down as time slows.

## Layout

```
src/
  core/      Config (every tunable value), GameTime, Input
  sim/       Board, Skater, Fingers, Tricks, Landing, Park   — renderer-free
  game/      Game (state machine), FingerMapper, Score
  view/      Stage, CameraRig, BoardMesh, RiderMesh, ParkMesh, TrickFX, PostFX
  ui/        Hud
  audio/     Audio
test/        headless sim + trick-vocabulary tests
tools/       shoot.mjs (drives the game in a browser and screenshots it)
             tune.mjs  (measures flick strength across frame rates)
```

The `sim/` layer never imports the renderer, which is why the whole trick
pipeline can be driven and graded from Node.

Every gameplay value lives in `src/core/Config.js` — time scales, transition
durations, finger forces, inertia, landing tolerances, scoring, camera framing.
Nothing gameplay-affecting is a magic number anywhere else.

## Notes

Original code and original assets throughout. The slow-motion trick-control
concept is inspired by the feel of skateboarding games of the mid-2000s; no
code, assets, audio or animation has been taken from any of them.
