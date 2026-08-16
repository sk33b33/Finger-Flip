import {
  Group,
  Mesh,
  MeshStandardMaterial,
  MeshBasicMaterial,
  CapsuleGeometry,
  BoxGeometry,
  SphereGeometry,
  ConeGeometry,
  CylinderGeometry,
  PointLight,
  AdditiveBlending,
  MathUtils,
} from 'three';
import Config from '../core/Config.js';

/**
 * The rider: a small orange lizard with a burning tail.
 *
 * Built procedurally from primitives like everything else in this project. The
 * proportions are the point — big head, short snout, stocky body, cream belly,
 * stubby limbs, and a thick tapering tail with a flame on the end that is the
 * only light source on the board besides the sun.
 *
 * The class name and its whole API are unchanged from the previous rider,
 * because `game/Game.js` drives it by that contract: setPose, setFade,
 * setBailPose, and position/quaternion written from outside. Feet stay at local
 * y = 0 so the board still sits under them.
 *
 * Local frame: +Z is the direction of travel, feet at y = 0.
 */
export default class RiderMesh extends Group {
  constructor() {
    super();

    // Every material is transparent from construction. Flipping `transparent`
    // on a live material does not take effect without forcing a recompile, and
    // this rider fades out on every single trick.
    const mat = (color, roughness, extra = {}) =>
      new MeshStandardMaterial({ color, roughness, transparent: true, opacity: 1, ...extra });

    const body = mat(0xf0842c, 0.62);
    const belly = mat(0xfbdfa6, 0.66);
    const claw = mat(0xfff3dc, 0.5);
    const eyeWhite = mat(0xfdfdfd, 0.32);
    const iris = mat(0x1f9d4d, 0.28);
    const pupil = mat(0x14171c, 0.3);
    const mouth = mat(0x8c2f3a, 0.7);

    this.materials = { body, belly, claw, eyeWhite, iris, pupil, mouth };
    this.allMaterials = Object.values(this.materials);
    this.fade = 1;

    const H = Config.skater.height; // ~1.0m: stylised, taller than life

    // ------------------------------------------------------------ legs ---
    // Short and set wide, because the stance has to straddle a board.
    this.legs = [];
    for (const side of [-1, 1]) {
      const hip = new Group();
      hip.position.set(side * 0.115, H * 0.3, side * 0.1);
      this.add(hip);

      const thigh = new Mesh(new CapsuleGeometry(0.072, H * 0.1, 4, 10), body);
      thigh.position.y = -H * 0.07;
      thigh.castShadow = true;
      hip.add(thigh);

      const knee = new Group();
      knee.position.y = -H * 0.14;
      hip.add(knee);

      const shin = new Mesh(new CapsuleGeometry(0.062, H * 0.08, 4, 10), body);
      shin.position.y = -H * 0.06;
      shin.castShadow = true;
      knee.add(shin);

      const ankle = new Group();
      ankle.position.y = -H * 0.13;
      knee.add(ankle);

      const foot = new Mesh(new SphereGeometry(0.078, 12, 10), body);
      foot.scale.set(1, 0.52, 1.35);
      foot.position.set(0, -0.024, 0.022);
      foot.castShadow = true;
      ankle.add(foot);

      // Three toe claws.
      for (const t of [-1, 0, 1]) {
        const toe = new Mesh(new ConeGeometry(0.017, 0.05, 8), claw);
        toe.rotation.x = Math.PI * 0.52;
        toe.position.set(t * 0.037, -0.03, 0.098);
        ankle.add(toe);
      }

      this.legs.push({ hip, knee, ankle, side });
    }

    // ----------------------------------------------------------- torso ---
    this.torso = new Group();
    this.torso.position.y = H * 0.3;
    this.add(this.torso);

    const chest = new Mesh(new CapsuleGeometry(0.15, H * 0.13, 5, 14), body);
    chest.position.y = H * 0.1;
    chest.scale.set(1, 1, 0.88);
    chest.castShadow = true;
    this.torso.add(chest);

    // The cream belly is a slightly smaller shell pushed forward through the
    // chest, which is cheaper and reads better than trying to texture it.
    const bellyMesh = new Mesh(new SphereGeometry(0.132, 16, 14), belly);
    bellyMesh.scale.set(0.94, 1.16, 0.72);
    bellyMesh.position.set(0, H * 0.09, 0.055);
    this.torso.add(bellyMesh);

    // ------------------------------------------------------------ head ---
    // Deliberately oversized: it is most of the silhouette at chase distance.
    this.head = new Group();
    this.head.position.y = H * 0.29;
    this.torso.add(this.head);

    const skull = new Mesh(new SphereGeometry(0.155, 18, 16), body);
    skull.scale.set(1, 0.92, 1.02);
    skull.castShadow = true;
    this.head.add(skull);

    const snout = new Mesh(new SphereGeometry(0.105, 14, 12), body);
    snout.scale.set(0.82, 0.66, 1.0);
    snout.position.set(0, -0.042, 0.115);
    this.head.add(snout);

    const jaw = new Mesh(new SphereGeometry(0.088, 14, 12), belly);
    jaw.scale.set(0.8, 0.5, 0.92);
    jaw.position.set(0, -0.075, 0.108);
    this.head.add(jaw);

    const mouthLine = new Mesh(new BoxGeometry(0.115, 0.012, 0.09), mouth);
    mouthLine.position.set(0, -0.058, 0.155);
    this.head.add(mouthLine);

    for (const side of [-1, 1]) {
      const nostril = new Mesh(new SphereGeometry(0.011, 8, 6), mouth);
      nostril.position.set(side * 0.035, -0.006, 0.198);
      this.head.add(nostril);

      const white = new Mesh(new SphereGeometry(0.05, 14, 12), eyeWhite);
      white.scale.set(0.78, 1, 0.62);
      white.position.set(side * 0.088, 0.038, 0.108);
      this.head.add(white);

      const green = new Mesh(new SphereGeometry(0.032, 12, 10), iris);
      green.scale.set(0.85, 1, 0.6);
      green.position.set(side * 0.098, 0.034, 0.138);
      this.head.add(green);

      const black = new Mesh(new SphereGeometry(0.016, 10, 8), pupil);
      black.scale.set(0.85, 1, 0.6);
      black.position.set(side * 0.103, 0.036, 0.158);
      this.head.add(black);
    }

    // ------------------------------------------------------------ arms ---
    this.arms = [];
    for (const side of [-1, 1]) {
      const shoulder = new Group();
      shoulder.position.set(side * 0.145, H * 0.16, 0);
      this.torso.add(shoulder);

      const upper = new Mesh(new CapsuleGeometry(0.045, H * 0.07, 4, 10), body);
      upper.position.y = -H * 0.05;
      upper.castShadow = true;
      shoulder.add(upper);

      const elbow = new Group();
      elbow.position.y = -H * 0.1;
      shoulder.add(elbow);

      const fore = new Mesh(new CapsuleGeometry(0.04, H * 0.06, 4, 10), body);
      fore.position.y = -H * 0.045;
      fore.castShadow = true;
      elbow.add(fore);

      // Three finger claws on each hand, which is the detail that makes the
      // silhouette read as a lizard rather than a soft toy.
      const hand = new Group();
      hand.position.y = -H * 0.085;
      elbow.add(hand);
      for (const t of [-1, 0, 1]) {
        const finger = new Mesh(new ConeGeometry(0.014, 0.048, 8), claw);
        finger.rotation.z = t * 0.4;
        finger.rotation.x = Math.PI;
        finger.position.set(t * 0.026, -0.026, 0.006);
        hand.add(finger);
      }

      this.arms.push({ shoulder, elbow, hand, side });
    }

    // ------------------------------------------------------------ tail ---
    // A chain of shrinking segments, so it can be given a curve and a sway.
    // Parented to the TORSO, not the root. A tail hung off the root points
    // straight back down the chase camera's line of sight and puts a burning
    // torch over the character in every frame; carried on the torso it swings
    // with his stance and clears the shot by itself.
    this.tail = new Group();
    this.tail.position.set(0, H * 0.02, -0.12);
    this.torso.add(this.tail);

    // The tail's resting shape: it drops away from the body first, then sweeps
    // back up so the flame sits high and clear. It has to get out of the chase
    // camera's line of sight — a tail held straight back points at the lens and
    // puts a burning torch over everything behind it.
    // Shallow angles on purpose: these compound down the chain, and steeper
    // ones curl the tail into a J that swings forward under his own belly.
    this.tailRest = [-0.18, -0.12, 0.0, 0.16, 0.28, 0.32];

    this.tailSegments = [];
    let parent = this.tail;
    const SEGMENTS = 6;
    for (let i = 0; i < SEGMENTS; i++) {
      const t = i / (SEGMENTS - 1);
      const seg = new Group();
      seg.position.y = i === 0 ? 0 : -0.001;
      seg.position.z = i === 0 ? 0 : -0.082;
      parent.add(seg);

      const r0 = MathUtils.lerp(0.082, 0.03, t);
      const r1 = MathUtils.lerp(0.072, 0.022, t);
      // Each piece is longer than the spacing so consecutive segments overlap;
      // butted end to end they read as a caterpillar rather than a tail.
      const piece = new Mesh(new CylinderGeometry(r1, r0, 0.115, 14), body);
      piece.rotation.x = Math.PI / 2;
      piece.position.z = -0.045;
      piece.castShadow = true;
      seg.add(piece);

      // A ball at each joint fills the gap when the tail is curved.
      const joint = new Mesh(new SphereGeometry(r0 * 0.99, 12, 10), body);
      seg.add(joint);

      this.tailSegments.push(seg);
      parent = seg;
    }

    // ----------------------------------------------------------- flame ---
    this.flame = new Group();
    this.flame.position.z = -0.075;
    parent.add(this.flame);

    const flameMat = (color, opacity) =>
      new MeshBasicMaterial({
        color,
        transparent: true,
        opacity,
        blending: AdditiveBlending,
        depthWrite: false,
      });

    // Kept modest on purpose: these are additive and sit above the bloom
    // threshold, so a bright flame this close to the camera turns the whole
    // character into a smear.
    this.flameOuter = new Mesh(new ConeGeometry(0.055, 0.15, 12), flameMat(0xff5a12, 0.34));
    this.flameInner = new Mesh(new ConeGeometry(0.03, 0.092, 10), flameMat(0xffb02a, 0.4));
    this.flameCore = new Mesh(new ConeGeometry(0.014, 0.048, 8), flameMat(0xffe9b0, 0.5));
    for (const m of [this.flameOuter, this.flameInner, this.flameCore]) {
      m.position.y = 0.06;
      this.flame.add(m);
    }
    this.flameMaterials = [
      this.flameOuter.material,
      this.flameInner.material,
      this.flameCore.material,
    ];
    this.flameBaseOpacity = this.flameMaterials.map((m) => m.opacity);

    // One small light so the flame actually throws warmth onto the deck and the
    // ground beneath it, rather than being a sticker that glows at nothing.
    this.flameLight = new PointLight(0xff8a3a, 0.55, 1.9, 2);
    this.flameLight.position.y = 0.09;
    this.flame.add(this.flameLight);

    this.flicker = 0;

    this.setPose(0, 0, 0);
    this.setFade(0);
  }

  /**
   * @param {number} crouch 0..1 — loading up for a pop
   * @param {number} lean   -1..1 — carving
   * @param {number} air    0..1 — how airborne, tucks the legs up
   */
  setPose(crouch, lean, air) {
    const H = Config.skater.height;
    const bend = crouch * 0.85 + air * 0.9;

    for (const { hip, knee, ankle, side } of this.legs) {
      hip.rotation.x = -bend * 0.62;
      knee.rotation.x = bend * 1.24;
      ankle.rotation.x = -bend * 0.6;
      // Riding stance: feet turned across the board.
      hip.rotation.y = side * 0.22;
      hip.position.y = H * 0.3 - bend * H * 0.05;
    }

    this.torso.position.y = H * 0.3 - bend * H * 0.1;
    this.torso.rotation.x = bend * 0.3;
    this.torso.rotation.z = -lean * 0.2;
    // Turned well across the board, the way a skater actually stands. From a
    // chase camera it is the difference between a character and an orange blob:
    // side-on you get the belly, the snout and the tail all at once.
    this.torso.rotation.y = MathUtils.lerp(0.82, 0.55, air);

    // The head counter-rotates so he keeps looking along the board however
    // much the body is turned across it.
    this.head.rotation.y = MathUtils.lerp(-0.6, -0.4, air); // counter-turn to look ahead
    this.head.rotation.x = -bend * 0.18;

    // Short arms held out and forward for balance, wider when airborne.
    const swing = lean * 0.45;
    this.arms[0].shoulder.rotation.set(-0.5 - air * 0.5 + swing, 0.18, 0.72 + air * 0.5);
    this.arms[1].shoulder.rotation.set(-0.46 - air * 0.42 - swing, -0.18, -0.72 - air * 0.5);
    this.arms[0].elbow.rotation.x = -0.5 - air * 0.3;
    this.arms[1].elbow.rotation.x = -0.46 - air * 0.26;

    // The tail lifts as a counterweight when he crouches, and streams out
    // behind him in the air.
    this.setTailCurve(0.34 - bend * 0.5 - air * 0.2, lean * 0.3);
  }

  /**
   * Bend the tail chain away from its resting shape. `lift` raises the whole
   * sweep, `sway` swings it sideways.
   */
  setTailCurve(lift, sway) {
    for (let i = 0; i < this.tailSegments.length; i++) {
      const t = i / (this.tailSegments.length - 1);
      // Bend concentrated toward the base, so the tip stays straight and the
      // flame keeps a readable direction.
      const w = 1 - t * 0.55;
      this.tailSegments[i].rotation.x = this.tailRest[i] + lift * w * 0.34;
      this.tailSegments[i].rotation.y = sway * w * 0.3;
    }
  }

  /** Animate the flame. Called every real frame from the game loop. */
  update(realDelta) {
    this.flicker += realDelta;
    const a = Math.sin(this.flicker * 17.3) * 0.5 + Math.sin(this.flicker * 29.7) * 0.3;
    const b = Math.sin(this.flicker * 11.1 + 1.3);

    const scale = 1 + a * 0.11;
    this.flameOuter.scale.set(1 + b * 0.07, scale, 1 + b * 0.07);
    this.flameInner.scale.set(1 - b * 0.05, scale * 1.04, 1 - b * 0.05);
    this.flameCore.scale.setScalar(1 + a * 0.14);
    this.flame.rotation.z = b * 0.08;

    // The light breathes with the flame, but never all the way down.
    this.flameLight.intensity = (1 - this.fade) * (0.5 + a * 0.18);
  }

  /**
   * Ghost him out as the trick camera closes in. At close range he would sit
   * right across the deck, and the deck is what the player has to read.
   * @param {number} amount 0 = solid, 1 = fully faded
   */
  setFade(amount) {
    if (Math.abs(amount - this.fade) < 0.004) return;
    this.fade = amount;
    const opacity = 1 - amount;
    for (const m of this.allMaterials) {
      m.opacity = opacity;
      // Depth writing stays ON even when ghosted. He is built from a dozen
      // overlapping shells, and without it every one of them blends over the
      // last — ten layers at 6% opacity compound to nearly half, so a "faded"
      // character sits solidly over the deck. Writing depth means the nearest
      // surface wins and 6% really is 6%.
      m.depthWrite = true;
    }
    // The flame is additive, so it does not fade with alpha the way the body
    // does — it has to be scaled down explicitly or it stays as a bright smear
    // hanging over the deck.
    for (let i = 0; i < this.flameMaterials.length; i++) {
      this.flameMaterials[i].opacity = this.flameBaseOpacity[i] * opacity;
    }
    this.flameLight.intensity = opacity * 0.5;

    // He is fifty-odd overlapping shells in bright orange, and even at a few
    // percent each that is a visible haze over the deck once they stack. So he
    // fades part of the way and is then cut outright. The camera is mid-slam
    // into the close-up when it happens, which reads as a shot change rather
    // than a pop — and it drops fifty draw calls at the exact moment the
    // slow-motion composite is costing the most.
    this.visible = opacity > 0.34;
  }

  /** Fold up on a bail so the slam reads instantly. */
  setBailPose(t) {
    const k = Math.min(1, t * 3);
    for (const { hip, knee } of this.legs) {
      hip.rotation.x = -1.2 * k;
      knee.rotation.x = 1.9 * k;
    }
    this.torso.rotation.x = 0.8 * k;
    this.head.rotation.x = 0.4 * k;
    this.arms[0].shoulder.rotation.set(-2.0 * k, 0, 0.9);
    this.arms[1].shoulder.rotation.set(-1.8 * k, 0, -0.9);
    // Tail thrown up and out as he goes down.
    this.setTailCurve(0.9 * k, Math.sin(t * 9) * 0.5 * k);
  }
}
