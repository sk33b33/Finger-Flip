import {
  Group,
  Mesh,
  MeshBasicMaterial,
  RingGeometry,
  CircleGeometry,
  AdditiveBlending,
} from 'three';

/**
 * The path the tutorial asks the player to trace, drawn on the deck.
 *
 * It lives in the world rather than as an overlay on the glass, because the
 * whole point is WHERE on the board the finger goes. A screen-space arrow would
 * have to be re-derived every time the trick camera orbits, and would stop
 * meaning anything the moment the deck turned over. Put it on the hand plane
 * and it is simply true: the camera can do what it likes.
 *
 * The hand plane is the horizontal plane through the board's centre in the
 * yaw-locked stance frame — the exact surface game/FingerMapper.js maps a touch
 * onto, so a dot drawn at (across, along) is at the place a fingertip reported
 * as (across, along) would be.
 *
 * Drawn without depth testing. The deck is opaque and spends half a flip
 * between the camera and the path, and a guide that disappears behind the thing
 * it is a guide to is worse than no guide.
 */

const TRAIL_DOTS = 9;

function basic(color, opacity) {
  return new MeshBasicMaterial({
    color,
    transparent: true,
    opacity,
    depthTest: false,
    depthWrite: false,
    blending: AdditiveBlending,
  });
}

/** One finger's worth: a target ring, a dotted trail, and a travelling pip. */
class Strand extends Group {
  constructor(color) {
    super();
    this.renderOrder = 999;

    // Where the finger starts. A ring rather than a disc, so the deck art is
    // still readable through the place you are being told to put your finger.
    this.start = new Mesh(new RingGeometry(0.022, 0.032, 24), basic(color, 0.95));
    this.start.rotation.x = -Math.PI / 2;
    this.add(this.start);

    this.dots = [];
    for (let i = 0; i < TRAIL_DOTS; i++) {
      const dot = new Mesh(new CircleGeometry(0.011, 12), basic(color, 0.3));
      dot.rotation.x = -Math.PI / 2;
      this.add(dot);
      this.dots.push(dot);
    }

    // The one that moves. Without it a dotted line is ambiguous about which
    // end is the start, and on a flick that is the entire instruction.
    this.pip = new Mesh(new CircleGeometry(0.02, 16), basic(color, 1));
    this.pip.rotation.x = -Math.PI / 2;
    this.add(this.pip);

    this.end = new Mesh(new RingGeometry(0.03, 0.038, 24), basic(color, 0.5));
    this.end.rotation.x = -Math.PI / 2;
    this.add(this.end);
  }

  /**
   * @param {{from:number[], to:number[], plant?:boolean}} path hand-plane metres
   * @param {number} phase 0..1, loops
   */
  layout(path, phase) {
    const [ax, az] = path.from;
    const [bx, bz] = path.to;
    const still = path.plant || (Math.abs(bx - ax) < 1e-4 && Math.abs(bz - az) < 1e-4);

    this.start.position.set(ax, 0, az);
    this.end.visible = !still;
    this.end.position.set(bx, 0, bz);

    for (let i = 0; i < this.dots.length; i++) {
      const dot = this.dots[i];
      dot.visible = !still;
      if (still) continue;
      const t = (i + 1) / (this.dots.length + 1);
      dot.position.set(ax + (bx - ax) * t, 0, az + (bz - az) * t);
      // Fade along the path, so it reads as travelling rather than as a wall.
      dot.material.opacity = 0.16 + 0.3 * (1 - t);
    }

    if (still) {
      // A plant has nowhere to travel, so the pip pulses in place instead.
      this.pip.position.set(ax, 0, az);
      const pulse = 0.65 + 0.35 * Math.sin(phase * Math.PI * 2);
      this.pip.scale.setScalar(pulse);
      this.pip.material.opacity = pulse;
      this.start.scale.setScalar(1 + 0.12 * Math.sin(phase * Math.PI * 2));
    } else {
      this.pip.position.set(ax + (bx - ax) * phase, 0, az + (bz - az) * phase);
      this.pip.scale.setScalar(1);
      // Fades out at the far end so the loop does not snap back.
      this.pip.material.opacity = Math.min(1, 2.2 * (1 - phase));
      this.start.scale.setScalar(1);
    }
  }
}

export default class GhostHand extends Group {
  constructor() {
    super();
    this.visible = false;
    this.phase = 0;
    // Two, because that is how many fingers there are. Built once and hidden
    // rather than created per lesson: a tutorial is not the place to be
    // allocating geometry on a frame the player is waiting on.
    this.strands = [new Strand(0xd7f23a), new Strand(0x7fd4ff)];
    for (const s of this.strands) this.add(s);
  }

  /**
   * @param {object[]|null} ghost  paths from the current lesson, or null
   * @param {Vector3} boardPos  the INTERPOLATED board position, not the stepped
   *        one — this sits on the deck and has to agree with where it is drawn
   * @param {Quaternion} stanceQuat  yaw-locked stance frame
   * @param {number} realDt
   */
  update(ghost, boardPos, stanceQuat, realDt) {
    if (!ghost || !ghost.length) {
      this.visible = false;
      return;
    }
    this.visible = true;
    this.phase = (this.phase + realDt * 0.75) % 1;

    this.position.copy(boardPos);
    this.quaternion.copy(stanceQuat);

    for (let i = 0; i < this.strands.length; i++) {
      const path = ghost[i];
      this.strands[i].visible = !!path;
      if (path) this.strands[i].layout(path, this.phase);
    }
  }

  dispose() {
    this.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) o.material.dispose();
    });
  }
}
