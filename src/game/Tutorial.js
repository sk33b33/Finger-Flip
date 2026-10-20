/**
 * Teaching the controls.
 *
 * The game's premise is unusual enough that nobody arrives knowing it, and the
 * entire onboarding used to be one prompt shown once — TWO FINGERS ON THE BOARD
 * — after which a new player waggled their fingers and the deck did something
 * arbitrary. This is the fix: a guided first trick, with the flick drawn on the
 * deck as a path to trace.
 *
 * ## No timer and no fail
 *
 * The two lessons that ask for a flick set `hover`, and while a hover step is
 * waiting the simulation stops integrating the board's POSITION but keeps
 * integrating its ROTATION. The deck hangs where it is and spins as it is
 * flicked. Slowing time down instead was the obvious thing to try and it does
 * not work: at the trick scale of 0.14, thirty real seconds of someone reading
 * the instructions is still four world seconds, and the board has long since
 * hit the floor. A lesson you can fail by reading it carefully is not a lesson.
 *
 * ## The paths are real
 *
 * Every `ghost` below was derived by running the move through the actual finger
 * solver in test/harness.mjs and keeping the one that produced the trick — see
 * test/tutorial.test.mjs, which re-runs them. They are not drawings of what a
 * flick ought to look like; they are paths that have been shown to work, and if
 * the physics is ever retuned under them the test fails rather than the ghost
 * quietly starting to teach something wrong.
 *
 * Coordinates are hand-plane metres in the stance frame, the same ones
 * FingerMapper produces: x across the deck (+ is the toe rail), y along it
 * (+ is the nose).
 */

export const Outcome = Object.freeze({
  WAITING: 'WAITING',
  ADVANCED: 'ADVANCED',
  FINISHED: 'FINISHED',
});

/**
 * @typedef {{across:number, along:number}} HandPoint
 * @typedef {{title:string, body:string, hover:boolean, ghost:object[]|null,
 *            block:number, done:(ctx:object)=>boolean}} Lesson
 */

const KICKFLIP_GHOST = [
  // Verified: finger on the nose truck, straight across to the toe rail.
  { finger: 1, from: [0.0, 0.22], to: [0.23, 0.22] },
];

const SHOVE_GHOST = [
  // Verified: short and sharp across the tail. Starting slightly heel-side is
  // what makes the roll arm sweep through zero and cancel, leaving pure yaw —
  // drag it further and it becomes a varial, which is what over-scooping does
  // on a real board too.
  { finger: 0, from: [-0.04, -0.36], to: [0.112, -0.36] },
];

const CATCH_GHOST = [
  { finger: 0, from: [0, -0.2], to: [0, -0.2], plant: true },
  { finger: 1, from: [0, 0.2], to: [0, 0.2], plant: true },
];

/** @type {Lesson[]} */
export const LESSONS = [
  {
    block: 0,
    title: 'Roll in',
    body: 'Hold anywhere on the screen — or Space — to crouch and load up the pop.',
    hover: false,
    ghost: null,
    done: (c) => c.charging,
  },
  {
    block: 0,
    title: 'Let it go',
    body: 'Release. The longer you held, the higher the ollie.',
    hover: false,
    ghost: null,
    done: (c) => c.state === 'AIR',
  },
  {
    block: 0,
    title: 'Now flip it',
    body:
      'The board is waiting. Drag a finger off the <b>toe rail</b> — the far edge — ' +
      'and the deck rolls toward you. Follow the line.',
    hover: true,
    ghost: KICKFLIP_GHOST,
    // Just over half a turn: enough that they have clearly done it on purpose,
    // early enough that they are not left flicking at a board already past it.
    done: (c) => c.spin.z <= -0.55,
  },
  {
    block: 0,
    title: 'Catch it',
    body:
      'Let it come all the way round, then put a finger flat on the deck to ' +
      'stop it. Catch it <b>flat</b> and you ride away; catch it halfway and ' +
      'you land on your side. Catching is the whole skill — the flip is the easy half.',
    hover: true,
    ghost: CATCH_GHOST,
    done: (c) => c.caught,
  },
  {
    block: 0,
    title: 'Ride away',
    body: 'Straighten the deck before the wheels touch and you land it.',
    hover: false,
    ghost: null,
    done: (c) => c.state === 'ROLL',
    celebrate: 'That was a kickflip.',
  },
  {
    block: 1,
    title: 'One more — a shove-it',
    body: 'Pop again. Hold, then release.',
    hover: false,
    ghost: null,
    done: (c) => c.state === 'AIR',
  },
  {
    block: 1,
    title: 'Scoop the tail',
    body:
      'This one is sideways, not off the edge. A short sharp scrape <b>across the tail</b> ' +
      'spins the board flat underneath you.',
    hover: true,
    ghost: SHOVE_GHOST,
    done: (c) => c.spin.y <= -0.28,
  },
  {
    block: 1,
    title: 'Catch and land',
    body: 'Same again. Let it come round, stop it <b>flat</b>, ride away.',
    hover: false,
    ghost: CATCH_GHOST,
    done: (c) => c.state === 'ROLL',
    celebrate: "That is everything. The rest is which edge, how hard, and when you catch it.",
  },
];

export default class Tutorial {
  constructor(lessons = LESSONS) {
    this.lessons = lessons;
    this.index = 0;
    this.finished = false;
    this.celebrated = null;
  }

  get current() {
    return this.finished ? null : this.lessons[this.index];
  }

  /** Should the simulation hold the board in the air while this step waits? */
  get hovering() {
    return !!this.current?.hover;
  }

  get ghost() {
    return this.current?.ghost || null;
  }

  get progress() {
    return { step: this.index + 1, total: this.lessons.length };
  }

  /**
   * Check the current lesson against the world.
   *
   * Called every frame; cheap, and it has to be, because the predicates are
   * how the tutorial notices the player got there.
   *
   * @returns {{outcome:string, lesson:Lesson|null, celebrate:string|null}}
   */
  update(ctx) {
    const lesson = this.current;
    if (!lesson) return { outcome: Outcome.FINISHED, lesson: null, celebrate: null };
    if (!lesson.done(ctx)) return { outcome: Outcome.WAITING, lesson, celebrate: null };

    const celebrate = lesson.celebrate || null;
    this.index++;
    if (this.index >= this.lessons.length) {
      this.finished = true;
      return { outcome: Outcome.FINISHED, lesson: null, celebrate };
    }
    return { outcome: Outcome.ADVANCED, lesson: this.current, celebrate };
  }

  /**
   * Went down. Rewind to the start of the trick being taught rather than the
   * very beginning — losing the kickflip because you fluffed the shove-it
   * would be its own small punishment, and the tutorial does not punish.
   */
  rewind() {
    if (this.finished) return;
    const block = this.current.block;
    while (this.index > 0 && this.lessons[this.index - 1].block === block) this.index--;
  }

  /** For the player who already knows, and for anyone stuck. */
  skip() {
    this.index = this.lessons.length;
    this.finished = true;
  }
}
