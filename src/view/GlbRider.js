import {
  AnimationClip,
  AnimationMixer,
  Box3,
  Group,
  MathUtils,
  Matrix4,
  Vector3,
} from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import Config from '../core/Config.js';

/**
 * A rigged rider, driven by the same pose system as the procedural one.
 *
 * view/RiderMesh.js builds a skater out of primitives and poses it by setting
 * joint rotations. This takes a Mixamo export and does the same thing to a
 * skeleton someone else authored, so the two are interchangeable: same
 * constructor shape, same setPose / setBailPose / setFade, same promise that
 * the feet sit at local y = 0 with the board underneath them.
 *
 * ## What is different, and why it matters
 *
 * The procedural rider's limb lengths come from Config. This one's come from
 * the model, measured off the bind pose when it loads. They are not the same
 * numbers, and using Config's would put the ankles through the deck.
 *
 * The rig also arrives in a T-pose with its arms straight out, which no skater
 * has ever stood in, so the rest pose here is a pose rather than the identity.
 *
 * ## The stance comes from a clip, not from me
 *
 * The model arrives in a T-pose, which no skater has ever stood in, so every
 * pose used to be one this file invented from it — and it looked like it. The
 * rest pose is now a real Mixamo skating clip, played on a mixer, and what
 * this file computes is layered ON TOP as deltas: the crouch, the tuck, the
 * carve and the slam.
 *
 * That split is worth keeping. The clip knows what a skater's shoulders and
 * spine do, which is authored human work and not something to derive. The
 * game knows how far the pop is charged and whether the wheels are down,
 * which no clip can know. Each supplies the half it has.
 *
 * ## Loading
 *
 * The file is a megabyte and a half and the game starts in well under that, so
 * this is asynchronous and the game must not wait on it. `ready` resolves when
 * the rider can be posed; until then the group is empty and every method is a
 * no-op, which is deliberate — a rider that has not arrived should cost
 * nothing, not throw.
 */

/**
 * How far the body is turned from the direction of travel.
 *
 * ZERO, where view/RiderMesh.js uses 0.22 turns — and that difference is the
 * point. The procedural rider is built facing down the board and has to be
 * yawed into a stance. This one's stance comes from a skating clip that
 * already contains it, so yawing it again rotates a correct pose off true.
 *
 * Measured rather than argued about: sweeping this through a full turn and
 * checking the line between the feet against the board's long axis gives 99%
 * alignment at 0 and at 180, and a worst case of 12% at the quarter turns.
 * 180 is the same stance riding fakie, so 0 it is.
 */
const STANCE_YAW = 0;
const REST_BEND = 0.2;

/** Bones this needs by name, after three has stripped the `mixamorig:` colon. */
const B = {
  hips: 'mixamorigHips',
  spine: 'mixamorigSpine',
  spine1: 'mixamorigSpine1',
  spine2: 'mixamorigSpine2',
  neck: 'mixamorigNeck',
  head: 'mixamorigHead',
  legs: [
    { up: 'mixamorigLeftUpLeg', low: 'mixamorigLeftLeg', foot: 'mixamorigLeftFoot' },
    { up: 'mixamorigRightUpLeg', low: 'mixamorigRightLeg', foot: 'mixamorigRightFoot' },
  ],
  arms: [
    { shoulder: 'mixamorigLeftArm', elbow: 'mixamorigLeftForeArm' },
    { shoulder: 'mixamorigRightArm', elbow: 'mixamorigRightForeArm' },
  ],
};

const _a = new Vector3();
const _b = new Vector3();
const _m = new Matrix4();
const UP = new Vector3(0, 1, 0);

export default class GlbRider extends Group {
  /**
   * @param {string} url
   * @param {object} character the roster entry, kept so Game can read `.id`
   */
  constructor(url, character) {
    super();
    this.character = character;
    this.loaded = false;
    this.bones = null;
    this.fade = 0;
    this.mixer = null;
    this.clips = {};
    /** Time of each clip's deepest frame, from tools/anim.mjs. */
    this.lowestAt = {};
    /** Latest pose asked for. Applied in update(), after the mixer has run. */
    this.pose = { crouch: 0, lean: 0, air: 0, bail: null };
    /** Same surface RiderMesh exposes, so Game can hold either one. */
    this.allMaterials = [];

    // Everything hangs in a frame yawed away from the direction of travel,
    // because a skater stands ACROSS the board rather than down it. Same
    // reasoning as RiderMesh, and the same angle.
    this.stance = new Group();
    this.add(this.stance);

    this.ready = this.load(url).catch((err) => {
      // A rider that fails to download must not take the game with it. The
      // caller keeps whatever it had.
      console.error('rider failed to load:', err);
      return null;
    });
  }

  async load(url) {
    // The clips are fetched alongside the model rather than after it: they are
    // 184KB against the model's 1.5MB, and a rider that pops in already
    // standing properly is better than one that arrives in a T-pose and
    // corrects itself a moment later.
    const animUrl = url.replace(/\.glb$/, '.anim.json');
    const [gltf, anim] = await Promise.all([
      new GLTFLoader().loadAsync(url),
      fetch(animUrl)
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null),
    ]);
    const root = gltf.scene;

    const find = (name) => root.getObjectByName(name) || null;
    const bones = {
      hips: find(B.hips),
      spine: find(B.spine),
      spine1: find(B.spine1),
      spine2: find(B.spine2),
      neck: find(B.neck),
      head: find(B.head),
      legs: B.legs.map((l) => ({ up: find(l.up), low: find(l.low), foot: find(l.foot) })),
      arms: B.arms.map((a) => ({ shoulder: find(a.shoulder), elbow: find(a.elbow) })),
    };
    if (!bones.hips || bones.legs.some((l) => !l.up || !l.low || !l.foot)) {
      throw new Error('rig is missing the bones this poses');
    }

    // The model stands 1.83m; the game's rider is 1.78m and the board is sized
    // around that. Scaled BEFORE measuring, so every length below is already
    // in the metres the rest of the game works in.
    root.scale.multiplyScalar(Config.skater.height / 1.827);
    root.updateMatrixWorld(true);

    // Measure the skeleton rather than assume it. These are this model's limb
    // lengths, not Config's, and using Config's would put the ankles through
    // the deck.
    const hipY = bones.hips.getWorldPosition(_a).y;
    const kneeY = bones.legs[0].low.getWorldPosition(_b).y;
    const ankleY = bones.legs[0].foot.getWorldPosition(_a).y;
    const thigh = Math.abs(hipY - kneeY);
    const shin = Math.abs(kneeY - ankleY);
    this.limb = { thigh, shin, ankleY };

    // Where the sole is, relative to the toe bone. The bone is inside the
    // foot; the thing that has to touch the deck is the bottom of the shoe,
    // and the difference is a centimetre or two that reads as floating.
    const box = new Box3().setFromObject(root);
    const toe = bones.legs[0].foot.parent ? bones.legs[0].foot : null;
    const toeBone =
      root.getObjectByName('mixamorigLeftToeBase') || bones.legs[0].foot;
    this.soleDrop = toeBone.getWorldPosition(_a).y - box.min.y;
    this.toeBones = [
      root.getObjectByName('mixamorigLeftToeBase') || bones.legs[0].foot,
      root.getObjectByName('mixamorigRightToeBase') || bones.legs[1].foot,
    ];

    // Which way is DOWN, in the space the Hips bone's own position lives in?
    //
    // Not negative Y. Two things are in the way, and they cancel out to
    // something that has to be measured rather than reasoned about:
    //
    //   - Mixamo authors in centimetres and puts the conversion on the
    //     Armature node, so a metre here is about a hundred local units;
    //   - Blender exports Z-up with a -90 degree rotation on that same node,
    //     so the bone's local +Y is not world up at all.
    //
    // Setting hips.position.y therefore slid the rider sideways while the legs
    // straightened underneath, which is precisely the floating-feet the IK
    // existed to prevent. Taking world up back through the parent's matrix
    // gives the right axis and the right magnitude in one go.
    bones.hips.parent.updateWorldMatrix(true, false);
    _m.copy(bones.hips.parent.matrixWorld).invert();
    this.hipDownUnit = UP.clone().transformDirection(_m).normalize().negate();
    bones.hips.parent.getWorldScale(_a);
    this.hipDown = this.hipDownUnit.clone().multiplyScalar(_a.y > 1e-9 ? 1 / _a.y : 1);


    this.bindHipPos = bones.hips.position.clone();
    // Every frame starts from here. The mixer overwrites the bones it
    // animates, but the deltas below are relative rotations — without a reset
    // they accumulate, and a few seconds of that folds the rider into a heap
    // on the floor. Which is exactly what it did.
    this.bind = new Map();
    root.traverse((o) => {
      if (o.isBone) this.bind.set(o, o.quaternion.clone());
    });

    this.allMaterials = [];
    root.traverse((o) => {
      if (!o.isMesh && !o.isSkinnedMesh) return;
      o.castShadow = true;
      o.frustumCulled = false; // skinned bounds go stale during a trick
      for (const m of [].concat(o.material)) {
        if (!this.allMaterials.includes(m)) this.allMaterials.push(m);
      }
    });

    this.stance.add(root);
    this.root = root;
    this.bones = bones;

    // The animation tracks address bones by name, and the mixer has to be
    // rooted where those names resolve.
    if (anim) {
      this.mixer = new AnimationMixer(root);
      for (const [name, json] of Object.entries(anim)) {
        try {
          this.clips[name] = AnimationClip.parse(json);
          // AnimationClip.parse keeps only what it understands, and the time
          // of the clip's deepest frame is not part of that.
          this.lowestAt[name] = json.lowestAt ?? 0;
        } catch (err) {
          console.warn(`clip ${name} would not parse:`, err);
        }
      }
      // The crouch is a POSE, not a performance: the game's charge is a
      // continuous 0..1 from how long the pop has been held, so the jump clip
      // is frozen at its lowest frame and simply weighted in. Nothing about
      // it plays — the mixer blends toward it as the charge builds, and that
      // is both a better crouch than anything derived and less code than the
      // IK it replaces.
      if (this.clips.jump) {
        this.crouchAction = this.mixer.clipAction(this.clips.jump);
        this.crouchAction.play();
        this.crouchAction.paused = true;
        this.crouchAction.time = this.lowestAt.jump || 0;
        this.crouchAction.weight = 0;
      }

      const base = this.clips.stance || Object.values(this.clips)[0];
      if (base) {
        this.action = this.mixer.clipAction(base);
        this.action.play();
        this.baseName = this.clips.stance ? 'stance' : Object.keys(this.clips)[0];
        // One frame so the rest pose is the clip's, not the T-pose, before
        // anything is drawn.
        this.mixer.update(0);
      }
    }

    this.loaded = true;
    this.update(0);
    return this;
  }

  /**
   * Same contract as RiderMesh#setPose. Stores; update() applies it.
   *
   * Stored rather than applied here because the mixer writes every bone it
   * animates each frame, so a delta laid on before it runs is simply
   * overwritten. update() does both, in the one order that works.
   *
   * @param {number} crouch 0..1 @param {number} lean -1..1 @param {number} air 0..1
   */
  setPose(crouch, lean, air) {
    this.pose.crouch = crouch;
    this.pose.lean = lean;
    this.pose.air = air;
    this.pose.bail = null;
  }

  /** Same contract as RiderMesh#setBailPose: t is real seconds since the slam. */
  setBailPose(t) {
    this.pose.bail = t;
  }

  /**
   * Advance the clip, then lay this frame's pose over the top.
   *
   * @param {number} rd real seconds
   */
  update(rd = 0) {
    if (!this.loaded) return;
    this.restoreBind();
    this.weightCrouch();
    // The clip is a rolling stance; it has nothing to say about a slam, so it
    // stops while one is happening rather than bobbing along underneath it.
    if (this.mixer && this.pose.bail === null) this.mixer.update(rd);
    this.apply();
  }

  /**
   * Blend between riding and the bottom of a load-up, by how far the pop is
   * charged. Both are authored clips; the mixer does the interpolation.
   */
  weightCrouch() {
    if (!this.crouchAction || !this.action) return;
    // Not while airborne: the legs tuck up there instead, and a crouch held
    // into the air reads as someone sitting down mid-trick.
    const c =
      this.pose.bail !== null
        ? 0
        : MathUtils.clamp(this.pose.crouch * (1 - this.pose.air), 0, 1);
    this.crouchAction.weight = c;
    this.crouchAction.time = this.lowestAt.jump || 0;
    this.action.weight = 1 - c;
  }

  /** Back to the authored pose, before the clip and the deltas go on. */
  restoreBind() {
    for (const [bone, q] of this.bind) bone.quaternion.copy(q);
    this.bones.hips.position.copy(this.bindHipPos);
  }

  /**
   * Swap which clip is the base pose, crossfaded.
   *
   * "stance" is riding; "move" is the push. The game switches on whether the
   * rider is actually pushing, and a cut between them would be a visible jolt
   * at exactly the moment the player is looking at the board.
   */
  playBase(name, fade = 0.25) {
    const clip = this.clips[name];
    if (!clip || !this.mixer || this.baseName === name) return;
    const next = this.mixer.clipAction(clip);
    next.reset().play();
    if (this.action && this.action !== next) this.action.crossFadeTo(next, fade, false);
    this.action = next;
    this.baseName = name;
  }

  /** Lay the game's pose over whatever the clip just wrote. */
  apply() {
    if (!this.loaded) return;
    if (this.pose.bail !== null) this.applyBail(this.pose.bail);
    else this.applyRide(this.pose.crouch, this.pose.lean, this.pose.air);
    this.placeFeet();
  }

  /**
   * Put the feet ON the board, by measuring where they actually ended up.
   *
   * Two things are being corrected, and both for the same reason: there are
   * two sources of leg position — the clip's own stance and the crouch
   * layered over it — so no solve of either in isolation lands the feet
   * anywhere in particular. Rather than predict, look.
   *
   *   height   find the lower sole and lift the body until it is on the deck.
   *            Predicting it had the rest pose floating two centimetres up
   *            and a full crouch seventeen through the board.
   *   along    the clip stands with its weight somewhere of its own choosing,
   *            which put both feet back by the tail with the nose empty in
   *            front of him. Centring the midpoint of the feet on the board's
   *            origin puts one over each truck, which is where they go.
   *
   * Skipped in the air and during a slam, which are precisely the times the
   * feet are meant to leave.
   */
  placeFeet() {
    this.stance.position.set(0, 0, 0);
    if (this.pose.bail !== null || this.pose.air > 0.5) return;

    this.updateMatrixWorld(true);
    let lowest = Infinity;
    _b.set(0, 0, 0);
    for (const toe of this.toeBones) {
      toe.getWorldPosition(_a);
      this.worldToLocal(_a);
      lowest = Math.min(lowest, _a.y - this.soleDrop);
      _b.add(_a);
    }
    _b.divideScalar(this.toeBones.length);

    if (Number.isFinite(lowest)) this.stance.position.y = -lowest;
    // Centred along the deck and across it, so he is standing on the board
    // rather than beside it or hanging off the tail.
    this.stance.position.x = -_b.x;
    this.stance.position.z = -_b.z;
  }

  applyRide(crouch, lean, air) {
    const bones = this.bones;

    // No crouch solve here any more. It used to drop the hips and bend the
    // legs with two-bone IK, and every part of that had to be rediscovered by
    // experiment on this rig — which axis, which sign, measured against a leg
    // the clip had already bent. The jump clip's lowest frame is a better
    // crouch than any of it, and weightCrouch blends to it above.
    //
    // What is left is the one thing no clip here covers: the tuck. In the air
    // the legs stop supporting and come up, which is the only time the feet
    // are meant to leave the board.
    if (air > 0.001) {
      for (const leg of bones.legs) {
        leg.up.rotateX(0.55 * air);
        leg.low.rotateX(-1.15 * air);
        leg.foot.rotateX(0.4 * air);
      }
    }

    // The upper body folds forward over the hips, spread across the spine so
    // it curves instead of hinging at the waist.
    const fold = REST_BEND + crouch * 0.8 + air * 0.9;
    // 0.055 a bone, not 0.1. Measured: 0.3 radians of total spine bend takes
    // the head from 0.59m above the hips to 0.38m — bent double, which on top
    // of the leg crouch reads as searching for a dropped key rather than
    // loading an ollie. The direction was right; the amount was not.
    for (const bone of [bones.spine, bones.spine1, bones.spine2]) {
      if (bone) bone.rotateX(fold * 0.055);
    }
    if (bones.neck) bones.neck.rotateX(-fold * 0.1);
    if (bones.head) bones.head.rotateX(-fold * 0.12);

    // Arms. The axes are the measured ones, not the obvious ones:
    //
    //   local X   drops the arm from horizontal, the SAME sign on both sides
    //   local Z   swings it forward and back, MIRRORED between the sides
    //   local Y   is twist along the bone and moves the hand barely at all
    //
    // Guessing these gave a rider who skated the whole game still holding a
    // T-pose, because the axis being driven hardest was the one doing nothing.
    const swing = lean * 0.5;
    const mirror = [1, -1];
    bones.arms.forEach((arm, i) => {
      const s = mirror[i];
      // Out and up in the air, where they are balancing rather than resting.
      if (arm.shoulder) arm.shoulder.rotateX(-air * 0.5).rotateZ(s * air * 0.3 + swing * 0.3);
      if (arm.elbow) arm.elbow.rotateX(air * 0.3);
    });

    this.stance.rotation.y = STANCE_YAW - fold * 0.16;
    this.stance.rotation.z = -lean * 0.2;
  }

  applyBail(t) {
    const k = Math.min(1, t * 3);
    const bones = this.bones;
    bones.hips.position.addScaledVector(this.hipDown, 0.35 * k * this.limb.thigh);
    for (const leg of bones.legs) {
      leg.up.rotateX(-1.3 * k);
      leg.low.rotateX(2.0 * k);
      leg.foot.rotateX(-0.5 * k);
    }
    for (const bone of [bones.spine, bones.spine1, bones.spine2]) {
      if (bone) bone.rotateX(0.35 * k);
    }
    bones.arms.forEach((arm, i) => {
      const s = i === 0 ? 1 : -1;
      // Arms up and forward as he goes down, the way anyone falls.
      if (arm.shoulder) arm.shoulder.rotateX(0.4 * k).rotateZ(s * 1.1 * k);
      if (arm.elbow) arm.elbow.rotateX(1.2 * k);
    });
    this.stance.rotation.y = STANCE_YAW;
    this.stance.rotation.z = 0;
  }

  /**
   * Fade the rider out so it never sits between the camera and the deck.
   * @param {number} amount 0 = solid, 1 = gone
   */
  setFade(amount) {
    if (!this.loaded) return;
    if (Math.abs(amount - this.fade) < 0.004) return;
    this.fade = amount;
    const opacity = 1 - amount;
    this.visible = opacity > 0.02;
    for (const m of this.allMaterials) {
      m.transparent = opacity < 0.999 || m.alphaTest > 0 || m.__wasTransparent;
      if (m.__wasTransparent === undefined) m.__wasTransparent = !!m.transparent;
      m.opacity = opacity;
      m.depthWrite = opacity > 0.65;
    }
  }

  dispose() {
    this.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      for (const m of [].concat(o.material || [])) {
        for (const k of ['map', 'normalMap', 'roughnessMap', 'metalnessMap']) m[k]?.dispose?.();
        m.dispose?.();
      }
    });
  }
}
