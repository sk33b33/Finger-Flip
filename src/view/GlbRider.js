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

const STANCE_YAW = Math.PI * 0.22;
const REST_BEND = 0.2;
const CROUCH_DROP = 0.22;

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

/**
 * Two-bone IK: the knee angle and the thigh's offset from the straight
 * hip-to-ankle line, for a chain of `thigh` and `shin` spanning `d`.
 */
function solveLeg(thigh, shin, d) {
  const knee = Math.acos(
    MathUtils.clamp((d * d - thigh * thigh - shin * shin) / (2 * thigh * shin), -1, 1),
  );
  const psi = Math.atan2(shin * Math.sin(knee), thigh + shin * Math.cos(knee));
  return { knee, psi };
}

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
    // NOT thigh + shin: the bind pose has a slight bend in it, so the straight
    // hip-to-ankle distance is a little shorter than the legs are long. Using
    // the sum as the rest length would try to straighten the leg past where it
    // was authored and lift the foot off the board before the crouch started.
    const bindReach = Math.abs(hipY - ankleY);
    this.limb = { thigh, shin, bindReach, ankleY };

    // The angles the bind pose is already at. Every pose below is applied as a
    // DELTA from these, because the bones are reset to their bind rotations
    // first — so the rest pose has to come out as no change at all.
    this.bindAngles = solveLeg(thigh, shin, bindReach);

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
          const clip = AnimationClip.parse(json);
          this.clips[name] = clip;
        } catch (err) {
          console.warn(`clip ${name} would not parse:`, err);
        }
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
    // The clip is a rolling stance; it has nothing to say about a slam, so it
    // stops while one is happening rather than bobbing along underneath it.
    if (this.mixer && this.pose.bail === null) this.mixer.update(rd);
    this.apply();
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
    this.plantFeet();
  }

  /**
   * Put the soles on the board, by measuring where they actually ended up.
   *
   * The clip is a skating stance, so it comes with its own bend in the legs,
   * and the crouch is layered on top of that rather than replacing it. Two
   * sources of leg angle means no amount of solving one of them in isolation
   * lands the feet in the right place — the rest pose floated two
   * centimetres up and a full crouch pushed them seventeen through the deck.
   *
   * So rather than predict it, look: find the lower sole and lift the whole
   * body until it is on the plane. Cheap, exact, and it cannot be wrong
   * whatever the clip does next. Skipped in the air and during a slam, which
   * are precisely the times the feet are supposed to leave.
   */
  plantFeet() {
    if (this.pose.bail !== null || this.pose.air > 0.5) {
      this.stance.position.y = 0;
      return;
    }
    this.stance.position.y = 0;
    this.updateMatrixWorld(true);
    let lowest = Infinity;
    for (const toe of this.toeBones) {
      toe.getWorldPosition(_a);
      this.worldToLocal(_a);
      lowest = Math.min(lowest, _a.y - this.soleDrop);
    }
    if (Number.isFinite(lowest)) this.stance.position.y = -lowest;
  }

  applyRide(crouch, lean, air) {
    const { thigh, shin, bindReach } = this.limb;
    const bones = this.bones;

    // How far the hips sink. Rotating the joints and leaving the hips put is
    // what lifts the feet off the board, so the hips move and the legs solve.
    const sink = (REST_BEND * 0.055 + crouch * CROUCH_DROP) * Config.skater.height * (1 - air);
    const d = MathUtils.clamp(bindReach - sink, (thigh + shin) * 0.4, (thigh + shin) * 0.999);

    // Two-bone IK, identical in form to the procedural rider's: given how far
    // the hip dropped, find the knee and hip angles that leave the ankle where
    // it was, so the soles stay on the deck however deep the crouch goes.
    //
    // A delta from the angles the straight leg would be at, because these are
    // laid over whatever the clip wrote rather than replacing it.
    const now = solveLeg(thigh, shin, d);
    const bind = this.bindAngles;
    const hipRot = MathUtils.lerp(-(now.psi - bind.psi), -1.0, air);
    const kneeRot = MathUtils.lerp(now.knee - bind.knee, 1.6, air);
    const ankleRot = MathUtils.lerp(now.psi - bind.psi - (now.knee - bind.knee), -0.5, air);

    bones.hips.position.addScaledVector(this.hipDown, sink);

    for (const leg of bones.legs) {
      leg.up.rotateX(hipRot);
      leg.low.rotateX(kneeRot);
      leg.foot.rotateX(ankleRot);
    }

    // The upper body folds forward over the hips, spread across the spine so
    // it curves instead of hinging at the waist.
    const fold = REST_BEND + crouch * 0.8 + air * 0.9;
    for (const bone of [bones.spine, bones.spine1, bones.spine2]) {
      if (bone) bone.rotateX(fold * 0.1);
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
