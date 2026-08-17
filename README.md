# Finger Flip

A 3D skateboarding game where you flip the board with **a finger from each hand**.

You roll in. You pop off a lip. Then the world drops into slow motion,
the camera slams in until the deck fills the screen, and the trick is entirely
in your hands: two fingers on the board, working the deck until it comes round
the way you want it, and a catch to stop it flat before you land.

Runs in the browser. Real multi-touch on a phone or tablet, keyboard on a
desktop, no install. Every texture, sound and piece of geometry *in the game* is
generated at runtime; the only files it downloads are the two crops of the title
card, and it fetches whichever one matches the shape of your screen.

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
| **Carve** as you pop | Body spin — 180, 360 |

The catch is the skill. A flick starts the board spinning; it keeps spinning
until something stops it. Put a finger back on the deck as it comes round flat
and you keep exactly the rotation you had at that moment. Catch late and you
score more.

**Body spin** comes from the carve you are already doing. Whatever you are
steering at the instant you pop is carried into the air as rider rotation, so a
committed turn into a kicker gives you a 180 and a hard one gives you a 360.
The fingers never have to leave the deck to do it.

**Landing takes itself.** There is no button and nothing to commit: the trick
ends the instant the wheels touch. Get the deck straightened out before then and
you ride away. Slow motion eases back toward normal over the last stretch of the
fall on its own, so the landing is never a crawl.

**Keyboard fingers.** `W A S D` drives one finger, the arrow keys the other —
a direct stand-in for the two touch points, so tricks are identical on both.
`Q` and `/` plant a finger without moving it, which is how you catch.

`Esc` menu · `H` controls · `R` restart the run · `M` mute · `P` cycle render quality

**The menu** is the hub: pick a park, pick a rider, see today's three challenges
and everything you have landed. **Drop In** is the only thing that starts you
skating — closing the menu resumes the run you already have, and nothing at all
simulates while the menu is open or while the title card is up.

The HUD is deliberately sparse: the trick readout is a translucent strip across
the top that only appears while you are in the air, speed sits bottom-right, and
the Nail meter bottom-left. Your score for a landed trick appears in the result
banner.

## Parks, riders, and what the game remembers

Three parks, picked from the menu. They are data — `sim/Layouts.js` — and every
one is graded by the same tests:

| | |
| --- | --- |
| **Fun Run** | A mixed street plaza on a long shallow hill. Everything the game has, once each. |
| **Slope** | A hill run: nine metres down over a hundred and back over the rest. Speed is free, so the features are low and come fast. |
| **Vert** | Bowls to pump and the tallest transitions in the game. |

What bounds a layout is not taste, it is arithmetic, and each of these has a
test: the terrain must return to zero at the seam or the lap steps; a feature
taller than `v² / 2g` is a wall rather than a ramp; a grade steeper than the
rider's push accel is a hill they slide back down.

**Vert is not vertical, and cannot be.** The rider follows a height function and
always travels +Z, so there is no dropping in, no turning around, and no wall
steeper than the climb budget allows. Vert here means the biggest transitions
this model supports. A real halfpipe needs a different movement model.

Four riders, from `view/Characters.js`, all built on one rig — the skeleton, the
stance and every pose are shared, and a character is a palette, a head,
something on the back and a build. Cosmetic only: handling that varied per
character would be a second variable pulling on a feel already fitted to the
viewport.

`game/Profile.js` keeps stats and challenge progress in localStorage, fed
entirely by the two things `ScoreSystem` already returns — the per-trick
breakdown and the banked line. It never throws (Safari's private mode throws on
write; Node has no localStorage at all) and never trusts what it reads back.
Three daily challenges, chosen deterministically from the date, graded by pure
functions over those same breakdowns.

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

The window is flat — one time scale throughout — and it winds back toward normal
over the last **`Config.nail.releaseWithin` world seconds before touchdown**.
Seconds to the floor, not a fraction of the flight: a fraction stretches with how
high you got, so the same trick felt different off the big kicker than off a flat
pop. `sim/Landing.js#predictTouchdown` supplies the number by marching the arc
against the height field, and `core/GameTime.js#nailScale` is the pure function
that shapes it, so the property can be tested rather than eyeballed.

### Everything else

- **Fixed-timestep simulation** at 240Hz of world time with interpolated
  rendering, so motion stays smooth at any refresh rate.
- **The finger sweep is substepped**, so a flick that crosses the whole deck
  inside one frame cannot skip the contact window. The mechanic behaves the same
  at 30fps as at 144 — also tested.
- **The park is one height function.** Collision, surface normals, camera
  clearance and the visual mesh all come from `sim/Park.js`, so what you see is
  exactly what you land on — kickers, a quarterpipe transition, a ledge, a
  plateau with a drop, a bank-to-bank gap, a hip and a roller, all expressed as
  `h(x, z)`. Three copies of the tile cycle around the rider for an endless run.
  The constraint is real: anything that cannot be written as a height cannot
  exist, which is why there are no grind rails.

  Feature heights are bounded by what the rider can actually climb — a rider at
  cruise can only rise `v² / 2g` before stalling, so a taller feature is not a
  ramp, it is a wall you grind to a halt against. There is a test for it, and it
  is the constraint that bit when the rolling speed was halved.
- **Wood on the ramps, concrete on the flat**, blended in one draw call by a
  per-vertex weight taken from the height itself. Raised ground is built
  structure; flat ground is the lot it was built on.
- **The trick shot fits itself to the viewport.** The distance a finger travels
  to flick off a rail is measured in screen pixels, so the camera costs both
  candidate framings against the frame and picks the cheaper, and the deck's
  width sets a floor on the range. `tools/aspects.mjs` measures it.
- **Adaptive quality.** The slow-motion composite is the most expensive thing
  drawn and it switches on exactly when a steady frame rate matters most, so
  the renderer gives ground in a fixed order rather than dropping frames:
  pixel ratio, then radial blur taps, then bloom. `P` cycles it by hand.
- **Post-processing** is a small hand-rolled composer: MSAA HDR target, two-level
  bloom, then a single composite doing radial motion blur, chromatic aberration,
  a slow-motion grade, vignette and grain — all keyed off one `slowmo` uniform
  so the whole look ramps together.
- **Audio** is synthesised from noise and oscillators at runtime. The mix runs
  through one filtered bus that closes down as time slows.

## Layout

```
src/
  core/      Config (every tunable value), GameTime, Input, Haptics
  sim/       Board, Skater, Fingers, Tricks, Landing,
             Park + Layouts (the three parks) — renderer-free
  game/      Game (state machine), FingerMapper, Score, Profile, Events
  view/      Stage, CameraRig, BoardMesh, RiderMesh + Characters,
             ParkMesh, TrickFX, PostFX
  ui/        Hud (in game), Shell (the menu)
  audio/     Audio
test/        headless sim + trick vocabulary + profile/challenges
public/      splash{,-portrait}.{webp,jpg} — the title card, the only assets
tools/       shoot.mjs   (plays a kickflip in a browser, shoots every beat)
             menu.mjs    (every menu tab at four device shapes)
             maps.mjs    (rides each park and shoots the approach to each lip)
             roster.mjs  (every character from the chase camera)
             aspects.mjs (measures the flick window at four device shapes)
             tune.mjs    (measures flick strength across frame rates)
             encode-splash.mjs (re-encodes the title card for the web)
```

The `sim/` layer never imports the renderer, which is why the whole trick
pipeline can be driven and graded from Node.

Every gameplay value lives in `src/core/Config.js` — time scales, transition
durations, finger forces, inertia, landing tolerances, scoring, camera framing.
Nothing gameplay-affecting is a magic number anywhere else.

## Notes

All code, geometry, textures and audio here are original and generated at
runtime. The one exception is the title card in `public/` — two crops of the key
art, landscape and portrait, as WebP with a JPEG fallback each, swapped by a
media query at square so an upright phone gets art composed for one. Re-encode
them from the sources with `tools/encode-splash.mjs`. Nothing the game renders
depends on any of it. The slow-motion
trick-control concept is inspired by the feel of skateboarding games of the
mid-2000s; no code, assets, audio or animation has been taken from any of them.

**One exception, stated plainly:** the default rider, "The Merc", is modelled on
Deadpool, a character owned by Marvel and Disney. The mesh is built from scratch
in `view/RiderMesh.js` rather than copied from anywhere, but the design is
theirs. That is fine for a personal prototype and is not fine for anything
published or sold. The other three riders are original, so the fix is to drop
that one entry from `view/Characters.js` and change `DEFAULT_CHARACTER` —
nothing else in the project depends on who the rider is.
