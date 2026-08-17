/**
 * Every tunable value in the game lives here. Nothing gameplay-affecting should
 * be a magic number anywhere else in the codebase.
 *
 * Angular values are radians unless the name says Deg.
 * Simulated-time values are in "world seconds", which run slower than real
 * seconds while Nail-the-Trick is active. Real-time values say Real.
 */
export const Config = {
  sim: {
    fixedStep: 1 / 240, // world seconds per physics tick
    maxStepsPerFrame: 40,
    gravity: -15.5, // m/s^2. Tuned for hangtime, not realism: the trick window is the game.
    airDrag: 0.06, // linear damping per world second while airborne
    angularDrag: 0.12, // free-spin damping. Low: a flicked board keeps spinning.
  },

  board: {
    length: 0.82, // m, nose tip to tail tip
    width: 0.205,
    // Distance from board centre to the point a finger works at each end.
    contactReach: 0.33,
    // Inverse inertia per local axis (x = pitch/lateral, y = yaw, z = roll/long).
    // A deck spins far more easily around its long axis than across it, which is
    // why flips are quicker than pitch rotations. These are shaped, not derived.
    invInertia: { x: 5.0, y: 7.0, z: 30.0 },
    mass: 3.1,
  },

  skater: {
    // 40 km/h. The forces that act on the speed are scaled with it, so
    // acceleration and braking still take the same time to do their job rather
    // than becoming twitchy at a different top end.
    maxSpeed: 11.11,
    accel: 5.26,
    brake: 7.43,
    rollFriction: 0.3,
    // Ceiling on gravity-assisted speed, as a multiple of maxSpeed. The lap now
    // has a real descent, and gravity along it outruns rolling friction by five
    // to one — so this is not a rare overshoot off a drop any more, it is what
    // the speedo reads for a third of every lap. Kept tight so the number the
    // player mostly sees is the cruise the game is tuned around, with the hill
    // worth a push rather than a different game.
    overspeed: 1.1,
    // Deliberately NOT scaled with the speed: holding the yaw rate fixed means
    // the turning circle grows as the game gets faster, which is what going
    // faster should feel like.
    steerRate: 1.5, // rad/s at full lock
    steerSpeedFalloff: 0.55, // steering authority lost at top speed
    height: 1.78, // read only by view/RiderMesh.js; the sim never uses it
  },

  pop: {
    // Ollie impulse applied at takeoff.
    minUp: 5.4,
    maxUp: 8.9,
    chargeTime: 0.45, // real seconds to reach maxUp
    // Automatic pitch the board picks up off the pop (nose rises first).
    pitchKick: -0.35,
    forwardBoost: 1.1,
    // Steepest slope a lip is allowed to convert into lift. A quarterpipe's
    // transition approaches vertical, and without this it launches absurdly.
    maxLiftSlope: 1.0,
    // Body spin. Whatever you are steering at the instant you pop is carried
    // into the air as rider rotation, the same way a skater winds up before an
    // ollie. It is deliberately not a finger control: the fingers have a job.
    bodySpinRate: 5.6, // rad/s at full lock
    bodySpinDeadzone: 0.22,
  },

  fingers: {
    // Screen-drag to angular-impulse conversion. Applied in REAL time so input
    // stays responsive while the world is slowed.
    forceScale: 9.0,
    // How much of a finger's push translates the board rather than spinning it.
    linearInfluence: 0.16,
    // A finger only grips while its projected position is over the deck plus
    // this margin. Past that it has "flicked off the edge" and contact breaks.
    gripMargin: 0.1,
    // Sideways offset a finger needs from the deck centreline before a vertical
    // flick starts producing roll. Zero would make every flick a pure pitch.
    edgeBias: 0.055,
    // While a finger rests on the board it bleeds off spin: this is the catch.
    catchDamping: 10.0,
    // A catch that stops the board dead also kills residual drift.
    catchLinearDamping: 3.5,
    // Max impulse a single frame of dragging can impart. Stops fling exploits.
    maxImpulsePerFrame: 12.0,
    // Virtual finger speed for keyboard control, in metres per real second.
    // Matched to a comfortable touch drag so tricks feel the same on both.
    keyboardSpeed: 2.7,
    // Keys ramp up to full speed instead of snapping, which keeps a tap gentle
    // and a hold decisive.
    keyboardRamp: 14.0,
    // With no key held a virtual finger drifts back to its home spot on the
    // deck (not touching), so the next tap is another clean flick.
    keyboardReturn: 2.2,
  },

  nail: {
    // One time scale for the whole window. There used to be two — a deep one
    // while a finger was working the deck and a faster one when both were off
    // it — and the flip between them was a visible surge every time a finger
    // left the board. A trick window you can feel changing speed underneath you
    // is not a window, it is a moving target.
    timeScale: 0.12,
    // Long ramps. These are what make it read as the world easing down rather
    // than a switch being thrown, and they cost nothing but patience.
    enterDuration: 0.28, // real seconds to ramp into slow motion
    exitDuration: 0.34, // real seconds to ramp back out
    // Slow motion relaxes on its own as the ground comes up, so the landing is
    // never a crawl.
    //
    // Measured in WORLD SECONDS UNTIL TOUCHDOWN, not as a fraction of the
    // flight. That is the whole difference: a fraction stretches with how high
    // you got, so the same trick felt different off the big kicker than off a
    // flat pop. Seconds-to-the-floor is a physical quantity and is identical
    // off both. sim/Landing.js#predictTouchdown supplies it.
    //
    // It has to fit inside the SHORTEST flight in the game or the smallest pop
    // spends its whole airtime winding out and never gets a flat window at all
    // — which would be the same height dependence back in a new costume. A
    // minimum pop (pop.minUp 5.4 m/s) flies 2v/g = 0.70 world seconds, so this
    // leaves even that one half its window at full depth.
    releaseWithin: 0.35,
    releaseTimeScale: 0.55,
    meterMax: 1.0,
    // Halved along with the time scale. The window used to average around 0.25
    // once the idle speed-up is counted; flat at 0.12 it takes roughly twice as
    // long in real seconds, and on the old drain a single trick off a decent
    // launch emptied the meter before the wheels touched.
    meterDrainPerSecondReal: 0.06,
    meterGainPerTrick: 0.42,
    meterGainPerSecondRolling: 0.085,
    meterMinToActivate: 0.18,
  },

  camera: {
    followDistance: 3.4,
    // Chest height on the rider, looking down at the deck. From dead behind,
    // the rider stands between the camera and the board, so the shot needs some
    // elevation or the thing you are about to flip spends the whole roll-in
    // hidden behind a pair of legs. The side offset used to solve this; a
    // centred camera has to solve it by looking down instead.
    followHeight: 1.5,
    followLag: 6.5, // higher = snappier
    fov: 64,
    // Close-up used during the trick, in spherical terms around the board. The
    // range is fitted to the viewport at takeoff rather than fixed, because the
    // flick window is measured in real screen pixels: see fitToViewport().
    trickFitLongAxis: 0.55, // fraction of the frame the deck's length fills
    // The deck's WIDTH is the flick window, so it has a floor: below about a
    // sixth of the frame a rail flick stops being a gesture and starts being a
    // pixel-hunt.
    trickFitShortAxis: 0.17,
    trickMinDistance: 0.62,
    trickMaxDistance: 2.1,
    // Looking down at the deck, not along it: the player has to see the surface
    // they are putting their fingers on.
    trickElevationDeg: 41,
    // Where the camera sits relative to the direction of travel. Just past
    // side-on, so the board's length runs across the screen (which is what
    // makes a flip legible) while the landing still sits ahead in frame.
    trickAzimuthTurns: 0.31,
    trickFov: 46,
    trickLerp: 8.5, // real-time rate into the trick shot
    trickExitLerp: 5.0, // and back out, a touch softer
    // The trick camera drifts slowly so the board reads in three dimensions.
    // Turns per real second: a whole revolution would take half a minute.
    trickOrbitRate: 0.03,
    trickOrbitStart: 0,
    // And the same idea for the chase shot, but only while the world is
    // stopped. Turns per real second: a whole lap of the rider takes a minute,
    // which is enough to read as alive without being a fairground ride.
    idleOrbitRate: 0.017,
    // Landing area must stay on screen: the camera pulls back as the board
    // falls. Proportional to the fitted range, not a fixed distance, or the
    // pullback dwarfs the shot on a viewport that framed in close.
    landingPullback: 0.85, // multiple of the fitted range
    landingRise: 0.35,
  },

  landing: {
    // Angle between board up and surface normal.
    perfectTiltDeg: 11,
    cleanTiltDeg: 24,
    roughTiltDeg: 42,
    // Yaw error against travel direction (0 = forward, PI = fakie, both legal).
    perfectYawDeg: 13,
    cleanYawDeg: 28,
    roughYawDeg: 50,
    // Residual spin at touchdown.
    //
    // The bail thresholds here and below are deliberately generous. Landing
    // resolves on its own the instant the wheels touch, so the deal with the
    // player is simply: straighten the deck before then and you ride away. A
    // board that has come round flat but is still turning THROUGH flat has been
    // straightened out, and slamming it made the deal a lie. The tiers below
    // bail are untouched — a scruffy landing still rides away for 0.15x, this
    // only moves where "badly" becomes "not at all".
    perfectSpin: 1.6,
    cleanSpin: 3.4,
    roughSpin: 6.2,
    bailSpin: 13.5,
    // How far the board may drift out from under the rider.
    perfectDrift: 0.16,
    cleanDrift: 0.32,
    roughDrift: 0.55,
    bailDrift: 1.15,
    // Wheels-down check: board up must not be inverted. This one stays tight —
    // a deck landing upside down is the one thing that is definitively NOT
    // straightened out, so it is the only unconditional bail left.
    invertedBailDeg: 74,
  },

  score: {
    landingMultiplier: { PERFECT: 1.6, CLEAN: 1.0, ROUGH: 0.45, SLAM: 0.15, BAIL: 0 },
    rotationPer360: 220, // per full turn of yaw
    flipPer360: 180, // per full roll
    pitchPer360: 260, // per full pitch (impossibles are hard)
    airTimeBonusPerSecond: 90,
    heightBonusPerMetre: 70,
    speedBonusPerMps: 24,
    // Landing without ever catching the board is luck, not skill.
    catchBonus: 260,
    lateCatchBonus: 340, // caught in the last third of the flight
    comboStep: 0.28, // each linked trick adds this to the combo multiplier
    comboMax: 6.0,
    repeatPenalty: 0.55, // same trick twice in a row scores this fraction
    styleSmoothness: 400, // awarded for a clean, single decisive flick
  },

  park: {
    runLength: 220,
    laneHalfWidth: 9,
  },

  fx: {
    bloomStrength: 0.55,
    bloomThreshold: 0.88,
    bloomRadius: 0.85,
    grain: 0.028,
    vignette: 0.42,
    chromaBase: 0.0006,
    chromaSlowmo: 0.0019,
    radialBlurSlowmo: 0.44,
    maxPixelRatio: 2,
    // Adaptive quality. The renderer gives ground rather than dropping frames:
    // see view/Quality.js for the order it gives it up in.
    adaptive: {
      budgetSeconds: 1 / 45, // slower than this and we are losing frames
      comfortableSeconds: 1 / 58, // faster than this and there is headroom
      dropAfterSeconds: 1.1, // sustained overrun before stepping down
      raiseAfterSeconds: 6.0, // far longer before stepping back up
    },
  },
};

export default Config;
