import {
  Group,
  Mesh,
  MeshStandardMaterial,
  CapsuleGeometry,
  BoxGeometry,
  SphereGeometry,
  CylinderGeometry,
  TorusGeometry,
  MathUtils,
} from 'three';
import Config from '../core/Config.js';
import { CHARACTERS, findCharacter, DEFAULT_CHARACTER } from './Characters.js';

/**
 * The rider.
 *
 * Built procedurally from primitives like everything else here. One rig serves
 * the whole roster: the skeleton, the stance and every pose are shared, and a
 * character is a palette, a head, something on the back and a build. See
 * view/Characters.js.
 *
 * The class API is fixed, because `game/Game.js` drives it by that contract:
 * setPose, setFade, setBailPose, update, and position/quaternion written from
 * outside. Feet stay at local y = 0 so the board sits under them.
 *
 * ## The stance
 *
 * This is the part that matters, and the part that was wrong before. A skater
 * does not face down the board — they stand ACROSS it:
 *
 *   - the two feet are separated along the board's LENGTH, one over each truck
 *   - the body is turned close to ninety degrees from the direction of travel
 *   - so the hips, being separated across the body, end up separated along the
 *     board too
 *   - and the head turns back to look where they are going
 *
 * The whole body therefore hangs in a frame yawed by STANCE_YAW, with the feet
 * placed along +/-Z inside it and the head counter-rotating. Yawing only the
 * torso and leaving the legs pointing down the board gives you someone standing
 * on a skateboard as though it were a surfboard.
 *
 * Local frame: +Z is the direction of travel, +X the toe side, feet at y = 0.
 */

/**
 * How far the body is turned from the direction of travel.
 *
 * Not the full ninety degrees, even though that is where the feet point. A
 * skater rides with their shoulders open, and squared up dead perpendicular
 * they present nothing but their own profile to a chase camera sitting directly
 * behind them — anatomically correct and completely unreadable.
 *
 * The camera sits dead centre, so this carries the whole job of keeping the
 * stance legible: forty degrees turns enough of the back and chest toward the
 * lens to separate the legs and show the board. The FEET are unaffected either
 * way — they are placed along the deck by FOOT_SPREAD, so the part of the
 * stance that actually matters stays true whatever this is set to.
 */
const STANCE_YAW = Math.PI * 0.22;
/** Distance from board centre to each foot: roughly over the trucks. */
const FOOT_SPREAD = 0.2;
/** Knee bend carried even at rest. */
const REST_BEND = 0.2;

export default class RiderMesh extends Group {
  /** @param {object|string} character a spec from Characters.js, or its id */
  constructor(character = DEFAULT_CHARACTER) {
    super();

    const spec =
      (typeof character === 'string' ? findCharacter(character) : character) || CHARACTERS[0];
    this.character = spec;
    const P = spec.palette;
    // Everything on the rig is sized in radii, so one number changes the build.
    const B = spec.bulk ?? 1;
    const r = (v) => v * B;

    // Every material is transparent from construction. Flipping `transparent`
    // on a live material does not take effect without forcing a recompile, and
    // this rider fades out on every single trick.
    const mat = (color, roughness, extra = {}) =>
      new MeshStandardMaterial({ color, roughness, transparent: true, opacity: 1, ...extra });

    const suit = mat(P.suit, 0.58);
    const suitDark = mat(P.suitDark, 0.6);
    const black = mat(P.trim, 0.62);
    const leather = mat(P.leather, 0.72);
    const buckle = mat(P.accent, 0.4, { metalness: 0.3 });
    const steel = mat(P.metal, 0.24, { metalness: 0.95 });
    const lens = mat(P.lens, 0.34);

    this.materials = { suit, suitDark, black, leather, buckle, steel, lens };
    this.allMaterials = Object.values(this.materials);
    this.fade = 1;

    const H = Config.skater.height;

    // Carving rolls the whole body about the board's long axis, so it wraps
    // everything rather than being applied part by part.
    this.leanGroup = new Group();
    this.add(this.leanGroup);

    // ------------------------------------------------------------ legs ---
    // Placed along the board, not across it: back foot over the tail truck,
    // front foot over the nose truck.
    this.legs = [];
    for (const side of [-1, 1]) {
      const hip = new Group();
      hip.position.set(0, H * 0.5, side * FOOT_SPREAD);
      hip.rotation.y = STANCE_YAW;
      this.leanGroup.add(hip);

      const thigh = new Mesh(new CapsuleGeometry(r(0.075), H * 0.19, 4, 10), suit);
      thigh.position.y = -H * 0.12;
      thigh.castShadow = true;
      hip.add(thigh);

      // Black panel down the outside of the thigh.
      const panel = new Mesh(new CapsuleGeometry(r(0.052), H * 0.15, 3, 8), black);
      panel.position.set(side * 0.045, -H * 0.12, 0.008);
      hip.add(panel);

      // Thigh strap.
      const strap = new Mesh(new TorusGeometry(r(0.078), 0.011, 6, 16), black);
      strap.rotation.x = Math.PI / 2;
      strap.position.y = -H * 0.2;
      hip.add(strap);

      const knee = new Group();
      knee.position.y = -H * 0.25;
      hip.add(knee);

      const shin = new Mesh(new CapsuleGeometry(r(0.06), H * 0.17, 4, 10), suit);
      shin.position.y = -H * 0.11;
      shin.castShadow = true;
      knee.add(shin);

      const ankle = new Group();
      ankle.position.y = -H * 0.23;
      knee.add(ankle);

      const boot = new Mesh(new CapsuleGeometry(r(0.065), H * 0.06, 4, 10), black);
      boot.position.y = 0.03;
      ankle.add(boot);

      const foot = new Mesh(new BoxGeometry(0.105, 0.055, 0.25), black);
      foot.position.set(0, -0.028, 0.025);
      foot.castShadow = true;
      ankle.add(foot);

      const sole = new Mesh(new BoxGeometry(0.11, 0.018, 0.255), suitDark);
      sole.position.set(0, -0.055, 0.025);
      ankle.add(sole);

      this.legs.push({ hip, knee, ankle, side });
    }

    // ----------------------------------------------------------- torso ---
    this.torso = new Group();
    this.torso.position.y = H * 0.5;
    this.torso.rotation.y = STANCE_YAW;
    this.leanGroup.add(this.torso);

    const chest = new Mesh(new CapsuleGeometry(r(0.16), H * 0.21, 5, 14), suit);
    chest.position.y = H * 0.12;
    chest.scale.set(1, 1, 0.82);
    chest.castShadow = true;
    this.torso.add(chest);

    // Black side panels: after the mask, the suit's most recognisable shape.
    for (const side of [-1, 1]) {
      const flank = new Mesh(new CapsuleGeometry(r(0.066), H * 0.17, 4, 10), black);
      flank.position.set(side * r(0.122), H * 0.13, -0.01);
      flank.scale.set(1, 1, 0.8);
      this.torso.add(flank);
    }

    // ------------------------------------------------------------ belt ---
    const belt = new Mesh(new CylinderGeometry(r(0.158), r(0.162), 0.062, 18), leather);
    belt.scale.set(1, 1, 0.84);
    belt.position.y = H * 0.015;
    this.torso.add(belt);

    const plate = new Mesh(new CylinderGeometry(0.042, 0.042, 0.016, 16), buckle);
    plate.rotation.x = Math.PI / 2;
    plate.position.set(0, H * 0.015, 0.132);
    this.torso.add(plate);

    for (const a of [-1.1, -0.5, 0.5, 1.1, 2.4, 3.2]) {
      const pouch = new Mesh(new BoxGeometry(0.062, 0.075, 0.045), leather);
      pouch.position.set(Math.sin(a) * 0.15, H * 0.005, Math.cos(a) * 0.125);
      pouch.rotation.y = a;
      this.torso.add(pouch);
    }

    // ------------------------------------------------------------ head ---
    this.head = new Group();
    this.head.position.y = H * 0.36;
    this.torso.add(this.head);

    this.buildHead(spec.head);

    // ------------------------------------------------------------ arms ---
    this.arms = [];
    for (const side of [-1, 1]) {
      const shoulder = new Group();
      shoulder.position.set(side * r(0.185), H * 0.25, 0);
      this.torso.add(shoulder);

      const cap = new Mesh(new SphereGeometry(r(0.068), 12, 10), black);
      shoulder.add(cap);

      const upper = new Mesh(new CapsuleGeometry(r(0.052), H * 0.13, 4, 10), black);
      upper.position.y = -H * 0.085;
      upper.castShadow = true;
      shoulder.add(upper);

      const elbow = new Group();
      elbow.position.y = -H * 0.17;
      shoulder.add(elbow);

      const fore = new Mesh(new CapsuleGeometry(r(0.045), H * 0.12, 4, 10), suit);
      fore.position.y = -H * 0.075;
      fore.castShadow = true;
      elbow.add(fore);

      const glove = new Mesh(new CapsuleGeometry(r(0.05), 0.05, 4, 10), black);
      glove.position.y = -H * 0.155;
      elbow.add(glove);

      this.arms.push({ shoulder, elbow, side });
    }

    // ------------------------------------------------ carried on the back ---
    // The chase camera looks straight at the rider's back, so whatever is on it
    // is the detail that does the most work for the least geometry — and the
    // fastest way to tell one character from another at a distance.
    this.rig = new Group();
    this.rig.position.set(0, H * 0.17, -0.105);
    this.torso.add(this.rig);
    this.buildBack(spec.back);

    this.setPose(0, 0, 0);
    this.setFade(0);
  }

  // --------------------------------------------------------------- head ---

  /**
   * Heads share a skull and differ above it, because the head is small on
   * screen for all but the bail — silhouette is the only thing that reads.
   */
  buildHead(kind) {
    const { suit, suitDark, black, leather, buckle, steel, lens } = this.materials;

    const skull = new Mesh(new SphereGeometry(0.118, 18, 16), kind === 'mask' ? suit : suitDark);
    skull.scale.set(0.94, 1.1, 1);
    skull.castShadow = true;
    this.head.add(skull);

    const jaw = new Mesh(new SphereGeometry(0.098, 14, 12), kind === 'mask' ? suit : suitDark);
    jaw.scale.set(0.88, 0.72, 0.94);
    jaw.position.set(0, -0.058, 0.012);
    this.head.add(jaw);

    if (kind === 'mask') {
      // Black patches with pale lenses set into them.
      for (const side of [-1, 1]) {
        const patch = new Mesh(new SphereGeometry(0.055, 14, 12), black);
        patch.scale.set(0.86, 0.78, 0.42);
        patch.position.set(side * 0.052, 0.016, 0.094);
        this.head.add(patch);

        const eye = new Mesh(new SphereGeometry(0.036, 12, 10), lens);
        eye.scale.set(0.9, 0.72, 0.32);
        eye.position.set(side * 0.052, 0.018, 0.114);
        this.head.add(eye);
      }
      return;
    }

    if (kind === 'helmet') {
      // A full-face lid: shell over the skull, one wide visor across the front.
      const shell = new Mesh(new SphereGeometry(0.132, 18, 16), suit);
      shell.scale.set(1, 1.02, 1.04);
      shell.position.y = 0.012;
      shell.castShadow = true;
      this.head.add(shell);

      const visor = new Mesh(new SphereGeometry(0.118, 18, 14), lens);
      visor.scale.set(0.94, 0.5, 0.62);
      visor.position.set(0, 0.006, 0.062);
      this.head.add(visor);

      const chin = new Mesh(new BoxGeometry(0.15, 0.05, 0.1), black);
      chin.position.set(0, -0.082, 0.052);
      this.head.add(chin);
      return;
    }

    if (kind === 'hood') {
      // Hood up: a cowl swallowing the skull, with the face left in shadow.
      const cowl = new Mesh(new SphereGeometry(0.145, 16, 14), suit);
      cowl.scale.set(1, 1.02, 1.06);
      cowl.position.set(0, 0.014, -0.016);
      cowl.castShadow = true;
      this.head.add(cowl);

      // The opening: a dark disc set into the front of the cowl.
      const opening = new Mesh(new SphereGeometry(0.088, 14, 12), black);
      opening.scale.set(0.94, 1.0, 0.36);
      opening.position.set(0, -0.004, 0.098);
      this.head.add(opening);

      for (const side of [-1, 1]) {
        const glint = new Mesh(new SphereGeometry(0.019, 10, 8), lens);
        glint.scale.set(1, 0.62, 0.5);
        glint.position.set(side * 0.038, 0.006, 0.118);
        this.head.add(glint);
      }

      // The bunched fabric where it gathers at the shoulders.
      const drape = new Mesh(new SphereGeometry(0.13, 12, 10), suitDark);
      drape.scale.set(1.1, 0.5, 0.86);
      drape.position.set(0, -0.108, -0.03);
      this.head.add(drape);
      return;
    }

    // cap — backwards, which is the whole point of a cap on a skateboard.
    const crown = new Mesh(new SphereGeometry(0.124, 16, 14), suit);
    crown.scale.set(1, 0.82, 1);
    crown.position.y = 0.026;
    crown.castShadow = true;
    this.head.add(crown);

    const peak = new Mesh(new BoxGeometry(0.14, 0.018, 0.11), suit);
    peak.position.set(0, 0.012, -0.14);
    peak.rotation.x = -0.16;
    this.head.add(peak);

    const band = new Mesh(new CylinderGeometry(0.125, 0.125, 0.026, 16), buckle);
    band.position.y = -0.012;
    this.head.add(band);

    for (const side of [-1, 1]) {
      const eye = new Mesh(new SphereGeometry(0.022, 10, 8), lens);
      eye.scale.set(1, 0.68, 0.5);
      eye.position.set(side * 0.042, -0.024, 0.096);
      this.head.add(eye);
    }
  }

  // --------------------------------------------------------------- back ---

  buildBack(kind) {
    const { suit, suitDark, black, leather, buckle, steel } = this.materials;

    if (kind === 'katanas') {
      for (const side of [-1, 1]) {
        const sword = new Group();
        sword.rotation.z = side * 0.55; // crossed, each tilted across the spine
        sword.rotation.x = -0.3; // laid back against the shoulder blades
        this.rig.add(sword);

        const scabbard = new Mesh(new CylinderGeometry(0.021, 0.017, 0.62, 10), black);
        scabbard.position.y = -0.04;
        scabbard.castShadow = true;
        sword.add(scabbard);

        const guard = new Mesh(new CylinderGeometry(0.038, 0.038, 0.012, 12), steel);
        guard.position.y = 0.28;
        sword.add(guard);

        const grip = new Mesh(new CylinderGeometry(0.017, 0.019, 0.17, 10), black);
        grip.position.y = 0.37;
        sword.add(grip);

        const pommel = new Mesh(new CylinderGeometry(0.021, 0.021, 0.018, 10), steel);
        pommel.position.y = 0.46;
        sword.add(pommel);

        // The harness strap carrying it, crossing to the opposite shoulder.
        const strap = new Mesh(new BoxGeometry(0.038, 0.5, 0.014), black);
        strap.position.set(side * 0.07, 0.06, 0.02);
        strap.rotation.z = side * 0.5;
        this.rig.add(strap);
      }
      return;
    }

    if (kind === 'pack') {
      const body = new Mesh(new BoxGeometry(0.26, 0.34, 0.13), black);
      body.position.set(0, 0.06, -0.05);
      body.castShadow = true;
      this.rig.add(body);

      const lid = new Mesh(new BoxGeometry(0.27, 0.09, 0.14), suitDark);
      lid.position.set(0, 0.2, -0.052);
      this.rig.add(lid);

      const buckleBox = new Mesh(new BoxGeometry(0.05, 0.035, 0.02), buckle);
      buckleBox.position.set(0, 0.14, -0.118);
      this.rig.add(buckleBox);

      for (const side of [-1, 1]) {
        const strap = new Mesh(new BoxGeometry(0.042, 0.44, 0.016), black);
        strap.position.set(side * 0.085, 0.08, 0.055);
        strap.rotation.z = side * 0.12;
        this.rig.add(strap);
      }
      return;
    }

    if (kind === 'deck') {
      // A spare board slung across the back, which is what half a skatepark
      // looks like from behind at any given moment.
      const deck = new Mesh(new BoxGeometry(0.19, 0.72, 0.022), suitDark);
      deck.rotation.z = 0.42;
      deck.position.set(0, 0.06, -0.055);
      deck.castShadow = true;
      this.rig.add(deck);

      const stripe = new Mesh(new BoxGeometry(0.19, 0.1, 0.024), buckle);
      stripe.rotation.z = 0.42;
      stripe.position.set(0.05, -0.05, -0.056);
      this.rig.add(stripe);

      for (const along of [-0.19, 0.19]) {
        const truck = new Mesh(new CylinderGeometry(0.016, 0.016, 0.13, 8), steel);
        truck.rotation.z = Math.PI / 2 + 0.42;
        truck.position.set(0.06 - Math.sin(0.42) * along, 0.06 + Math.cos(0.42) * along, -0.03);
        this.rig.add(truck);
      }

      const strap = new Mesh(new BoxGeometry(0.04, 0.52, 0.014), leather);
      strap.position.set(-0.02, 0.06, 0.03);
      strap.rotation.z = -0.34;
      this.rig.add(strap);
      return;
    }

    // none — bare back, but not an empty one: a seam and a yoke, so the
    // silhouette does not read as unfinished from the chase camera.
    const yoke = new Mesh(new BoxGeometry(0.3, 0.11, 0.02), suitDark);
    yoke.position.set(0, 0.22, -0.035);
    this.rig.add(yoke);

    const spine = new Mesh(new BoxGeometry(0.035, 0.44, 0.018), suit);
    spine.position.set(0, 0.02, -0.045);
    this.rig.add(spine);
  }

  /**
   * @param {number} crouch 0..1 — loading up for a pop
   * @param {number} lean   -1..1 — carving
   * @param {number} air    0..1 — how airborne, tucks the legs up
   */
  setPose(crouch, lean, air) {
    const H = Config.skater.height;
    // Never fully straight-legged: a skater rides with the knees soft, and
    // locked-out legs read as a mannequin balanced on a plank.
    const bend = REST_BEND + crouch * 0.8 + air * 0.9;

    for (const { hip, knee, ankle } of this.legs) {
      // Knees bend out over the toes, which after the stance yaw is across the
      // board — the direction a skater actually loads in.
      hip.rotation.x = -bend * 0.7;
      knee.rotation.x = bend * 1.38;
      ankle.rotation.x = -bend * 0.68;
      hip.position.y = H * 0.5 - bend * H * 0.055;
    }

    this.torso.position.y = H * 0.5 - bend * H * 0.13;
    this.torso.rotation.x = bend * 0.3;
    // Shoulders open toward the nose as he loads, the way a skater winds up.
    this.torso.rotation.y = STANCE_YAW - bend * 0.16;

    // Carving rolls the whole body about the board's long axis.
    this.leanGroup.rotation.z = -lean * 0.2;

    // And the head comes back round to look where he is going.
    this.head.rotation.y = -STANCE_YAW * MathUtils.lerp(0.82, 0.62, air);
    this.head.rotation.x = -bend * 0.16;

    // Arms out for balance, wider and higher in the air.
    const swing = lean * 0.5;
    this.arms[0].shoulder.rotation.set(-0.3 - air * 0.7 + swing, 0.16, 0.62 + air * 0.55);
    this.arms[1].shoulder.rotation.set(-0.26 - air * 0.6 - swing, -0.16, -0.62 - air * 0.55);
    this.arms[0].elbow.rotation.x = -0.62 - air * 0.5;
    this.arms[1].elbow.rotation.x = -0.56 - air * 0.44;
  }

  /** Nothing animates per frame, but the game calls it; keep the contract. */
  update() {}

  /**
   * Ghost him out as the trick camera closes in, then cut him.
   * @param {number} amount 0 = solid, 1 = fully faded
   */
  setFade(amount) {
    if (Math.abs(amount - this.fade) < 0.004) return;
    this.fade = amount;
    const opacity = 1 - amount;
    for (const m of this.allMaterials) {
      m.opacity = opacity;
      // Depth writing stays on: he is dozens of overlapping shells, and without
      // it every one blends over the last, so a "faded" rider still sits solidly
      // over the deck.
      m.depthWrite = true;
    }
    // He fades part of the way and is then cut outright, because even a few
    // percent per shell stacks into a visible haze over the board. The camera is
    // mid-slam into the close-up when it happens, so it reads as a shot change.
    this.visible = opacity > 0.34;
  }

  /** Fold up on a bail so the slam reads instantly. */
  setBailPose(t) {
    const k = Math.min(1, t * 3);
    for (const { hip, knee } of this.legs) {
      hip.rotation.x = -1.3 * k;
      knee.rotation.x = 2.0 * k;
    }
    this.torso.rotation.x = 0.85 * k;
    this.head.rotation.x = 0.35 * k;
    this.arms[0].shoulder.rotation.set(-2.1 * k, 0, 0.9);
    this.arms[1].shoulder.rotation.set(-1.9 * k, 0, -0.9);
  }
}
