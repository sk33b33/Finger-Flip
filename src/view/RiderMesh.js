import {
  Group,
  Mesh,
  MeshStandardMaterial,
  CapsuleGeometry,
  BoxGeometry,
  SphereGeometry,
  MathUtils,
} from 'three';
import Config from '../core/Config.js';

/**
 * The rider. Deliberately stylised and simple: during the trick the camera is
 * on the board and the rider is mostly out of frame, so the budget goes into
 * legible silhouette and a pose that reads at a glance — crouched and loading,
 * or tucked and airborne.
 *
 * Local frame: +Z is the direction of travel, feet at y = 0.
 */
export default class RiderMesh extends Group {
  constructor() {
    super();

    // Declared transparent from the start. Flipping `transparent` on a live
    // material does not take effect without forcing a recompile, and the rider
    // has to fade every single trick — so it simply always goes through the
    // transparent path and only its opacity animates.
    const mat = (color, roughness) =>
      new MeshStandardMaterial({ color, roughness, transparent: true, opacity: 1 });

    const skin = mat(0xc98b62, 0.78);
    const hoodie = mat(0xe8512f, 0.86);
    const jeans = mat(0x3a4a63, 0.9);
    const shoe = mat(0xf1efe8, 0.72);
    const sole = mat(0x24262c, 0.9);
    const cap = mat(0x1d2029, 0.85);
    this.materials = { skin, hoodie, jeans, shoe, sole, cap };
    this.allMaterials = Object.values(this.materials);
    this.fade = 1;

    const H = Config.skater.height;

    // Legs, built as hip -> knee -> ankle groups so a crouch bends them.
    this.legs = [];
    for (const side of [-1, 1]) {
      const hip = new Group();
      hip.position.set(side * 0.085, H * 0.5, side * 0.11);
      this.add(hip);

      const thigh = new Mesh(new CapsuleGeometry(0.062, H * 0.21, 4, 10), jeans);
      thigh.position.y = -H * 0.13;
      thigh.castShadow = true;
      hip.add(thigh);

      const knee = new Group();
      knee.position.y = -H * 0.26;
      hip.add(knee);

      const shin = new Mesh(new CapsuleGeometry(0.052, H * 0.19, 4, 10), jeans);
      shin.position.y = -H * 0.12;
      shin.castShadow = true;
      knee.add(shin);

      const ankle = new Group();
      ankle.position.y = -H * 0.24;
      knee.add(ankle);

      const foot = new Mesh(new BoxGeometry(0.1, 0.055, 0.24), shoe);
      foot.position.set(0, -0.028, 0.02);
      foot.castShadow = true;
      ankle.add(foot);

      const footSole = new Mesh(new BoxGeometry(0.105, 0.018, 0.245), sole);
      footSole.position.set(0, -0.055, 0.02);
      ankle.add(footSole);

      this.legs.push({ hip, knee, ankle, side });
    }

    // Torso.
    this.torso = new Group();
    this.torso.position.y = H * 0.5;
    this.add(this.torso);

    const chest = new Mesh(new CapsuleGeometry(0.145, H * 0.2, 4, 12), hoodie);
    chest.position.y = H * 0.14;
    chest.castShadow = true;
    this.torso.add(chest);

    const hood = new Mesh(new SphereGeometry(0.13, 12, 10), hoodie);
    hood.position.set(0, H * 0.26, -0.06);
    hood.scale.set(1, 0.8, 1.1);
    this.torso.add(hood);

    const head = new Mesh(new SphereGeometry(0.098, 14, 12), skin);
    head.position.y = H * 0.31;
    head.castShadow = true;
    this.torso.add(head);
    this.head = head;

    const capMesh = new Mesh(new SphereGeometry(0.104, 14, 10, 0, Math.PI * 2, 0, Math.PI * 0.55), cap);
    capMesh.position.y = H * 0.325;
    this.torso.add(capMesh);
    const brim = new Mesh(new BoxGeometry(0.17, 0.016, 0.1), cap);
    brim.position.set(0, H * 0.315, 0.11);
    this.torso.add(brim);

    // Arms: shoulder groups so they can swing for balance.
    this.arms = [];
    for (const side of [-1, 1]) {
      const shoulder = new Group();
      shoulder.position.set(side * 0.16, H * 0.22, 0);
      this.torso.add(shoulder);

      const upper = new Mesh(new CapsuleGeometry(0.05, H * 0.15, 4, 10), hoodie);
      upper.position.y = -H * 0.095;
      upper.castShadow = true;
      shoulder.add(upper);

      const elbow = new Group();
      elbow.position.y = -H * 0.19;
      shoulder.add(elbow);

      const fore = new Mesh(new CapsuleGeometry(0.042, H * 0.13, 4, 10), skin);
      fore.position.y = -H * 0.08;
      fore.castShadow = true;
      elbow.add(fore);

      this.arms.push({ shoulder, elbow, side });
    }

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
    const bend = crouch * 0.85 + air * 0.95;

    for (const { hip, knee, ankle, side } of this.legs) {
      hip.rotation.x = -bend * 0.72;
      knee.rotation.x = bend * 1.42;
      ankle.rotation.x = -bend * 0.7;
      // Riding stance: feet turned across the board.
      hip.rotation.y = side * 0.18;
      hip.position.y = H * 0.5 - bend * H * 0.055;
    }

    this.torso.position.y = H * 0.5 - bend * H * 0.13;
    this.torso.rotation.x = bend * 0.34;
    this.torso.rotation.z = -lean * 0.22;
    this.torso.rotation.y = MathUtils.lerp(0.32, 0.12, air); // shoulders open to travel

    const swing = lean * 0.6;
    this.arms[0].shoulder.rotation.set(-0.35 - air * 0.9 + swing, 0, 0.75 + air * 0.5);
    this.arms[1].shoulder.rotation.set(-0.35 - air * 0.7 - swing, 0, -0.75 - air * 0.5);
    this.arms[0].elbow.rotation.x = -0.5 - air * 0.5;
    this.arms[1].elbow.rotation.x = -0.5 - air * 0.4;

    this.head.rotation.y = -0.2;
  }

  /**
   * Ghost the rider out as the trick camera closes in. At 1.5 metres the
   * rider's legs sit right across the deck, and the deck is the thing the
   * player has to read.
   * @param {number} amount 0 = solid, 1 = fully faded
   */
  setFade(amount) {
    if (Math.abs(amount - this.fade) < 0.004) return;
    this.fade = amount;
    const opacity = 1 - amount;
    for (const m of this.allMaterials) {
      m.opacity = opacity;
      // Keep writing depth while solid so the limbs sort against each other;
      // once ghosted the ordering no longer reads and depth writes would punch
      // holes in the board behind.
      m.depthWrite = opacity > 0.6;
    }
    this.visible = opacity > 0.02;
  }

  /** Fold up on a bail so the slam reads instantly. */
  setBailPose(t) {
    const k = Math.min(1, t * 3);
    for (const { hip, knee } of this.legs) {
      hip.rotation.x = -1.4 * k;
      knee.rotation.x = 2.1 * k;
    }
    this.torso.rotation.x = 0.9 * k;
    this.arms[0].shoulder.rotation.set(-2.2 * k, 0, 0.9);
    this.arms[1].shoulder.rotation.set(-2.0 * k, 0, -0.9);
  }
}
