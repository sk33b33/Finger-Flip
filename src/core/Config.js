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
    // Distance from board centre to the point a finger grabs at each end.
    contactReach: 0.33,
    // Inverse inertia per local axis (x = pitch/lateral, y = yaw, z = roll/long).
    // A deck spins far more easily around its long axis than across it, which is
    // why flips are quicker than pitch rotations. These are shaped, not derived.
    invInertia: { x: 5.0, y: 7.0, z: 30.0 },
    mass: 3.1,
  },

  skater: {
    maxSpeed: 13.5,
    accel: 6.4,
    brake: 9.0,
    rollFriction: 0.35,
    steerRate: 1.5, // rad/s at full lock
    steerSpeedFalloff: 0.55, // steering authority lost at top speed
    height: 1.72,
  },

  pop: {
    // Ollie impulse applied at takeoff.
    minUp: 5.4,
    maxUp: 8.9,
    chargeTime: 0.45, // real seconds to reach maxUp
    // Automatic pitch the board picks up off the pop (nose rises first).
    pitchKick: -0.35,
    forwardBoost: 1.1,
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

  grabs: {
    // A hold only counts as a grab once it has lasted this long in real time.
    // Shorter than this and it is a catch, not a grab.
    minHold: 0.3,
    minContact: 0.45,
    // Zone boundaries in board-local metres.
    railZone: 0.052, // beyond this from the centreline you are on a rail
    tipZone: 0.3, // beyond this from centre you are on the nose or tail
    frontTruckZ: 0.06, // splits the toe rail into mute (forward) and indy
    // Scoring.
    pointsPerSecondHeld: 190,
    maxScoringHold: 3.2,
    // A grabbed board is held against the feet, so it stops drifting away.
    driftDamping: 5.5,
  },

  nail: {
    timeScale: 0.15, // world time scale while a finger is working the board
    // With both fingers off the deck there is nothing to be precise about, so
    // time runs on. This is what stops the trick window turning into a long
    // wait for the board to come back round. Set it equal to timeScale for a
    // flat, old-school slow-motion window.
    idleTimeScale: 0.38,
    idleRamp: 0.22, // real seconds to slide between the two
    enterDuration: 0.16, // real seconds to ramp into slow motion
    exitDuration: 0.2, // real seconds to ramp back out
    // Slow motion relaxes on its own over the last stretch of the flight, so
    // the landing never crawls even if the player never commits. Measured as a
    // fraction of the flight rather than a height, so it behaves the same off a
    // flat pop and off the big kicker.
    releaseFrom: 0.72, // flight fraction where time starts winding back up
    releaseTimeScale: 0.5,
    meterMax: 1.0,
    meterDrainPerSecondReal: 0.12,
    meterGainPerTrick: 0.42,
    meterGainPerSecondRolling: 0.085,
    meterMinToActivate: 0.18,
  },

  camera: {
    followDistance: 3.5,
    followHeight: 1.05,
    followLag: 6.5, // higher = snappier
    fov: 64,
    // Close-up used during the trick, in spherical terms around the board.
    trickDistance: 1.5,
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
    // Landing area must stay on screen: the camera pulls back as the board falls.
    landingPullback: 1.6,
    landingRise: 0.45,
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
    perfectSpin: 1.6,
    cleanSpin: 3.4,
    roughSpin: 6.2,
    bailSpin: 9.5,
    // How far the board may drift out from under the rider.
    perfectDrift: 0.16,
    cleanDrift: 0.32,
    roughDrift: 0.55,
    bailDrift: 0.78,
    // Wheels-down check: board up must not be inverted.
    invertedBailDeg: 74,
  },

  score: {
    landingMultiplier: { PERFECT: 1.6, CLEAN: 1.0, ROUGH: 0.45, SLAM: 0.15, BAIL: 0 },
    rotationPer360: 220, // per full turn of yaw
    flipPer360: 180, // per full roll
    pitchPer360: 260, // per full pitch (impossibles are hard)
    airTimeBonusPerSecond: 90,
    heightBonusPerMetre: 70,
    speedBonusPerMps: 12,
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
  },
};

export default Config;
