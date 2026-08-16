import {
  Group,
  Mesh,
  BufferGeometry,
  BufferAttribute,
  MeshStandardMaterial,
  MeshPhysicalMaterial,
  CylinderGeometry,
  BoxGeometry,
  Vector3,
  DoubleSide,
} from 'three';
import Config from '../core/Config.js';
import {
  gripTexture,
  gripRoughness,
  plyTexture,
  deckGraphic,
  truckRoughness,
} from './textures.js';

/**
 * The skateboard, built from maths rather than a model file.
 *
 * The deck is a parametric surface: a popsicle outline, kicked nose and tail,
 * and lengthwise concave. It is generated as a closed shell (top face, bottom
 * face, rim) so the cut plies show along the edge, which is the detail that
 * sells the board when the camera is 1.4 metres away in slow motion.
 *
 * Local frame matches the simulation: +X toe side, +Y deck up, +Z nose.
 */

const DECK = {
  segsU: 96, // along the length
  segsV: 16, // across the width
  thickness: 0.0125,
  kick: 0.052, // vertical rise at the tips
  kickStart: 0.52, // |u| where the kick begins
  concave: 0.0092,
  tipWidthRatio: 0.42,
  taperStart: 0.56,
};

export default class BoardMesh extends Group {
  constructor() {
    super();
    this.length = Config.board.length;
    this.width = Config.board.width;

    const grip = gripTexture();
    const gripRough = gripRoughness();
    const ply = plyTexture();
    const graphic = deckGraphic();
    const metalRough = truckRoughness();

    this.materials = {
      grip: new MeshStandardMaterial({
        map: grip,
        roughnessMap: gripRough,
        color: 0xffffff,
        roughness: 0.94,
        metalness: 0.0,
      }),
      // A printed, lacquered underside. The clearcoat is the layer that sells
      // the flip: it catches the sky as a moving highlight across the graphic
      // while the deck rotates, which a plain roughness value cannot do.
      graphic: new MeshPhysicalMaterial({
        map: graphic,
        roughness: 0.42,
        metalness: 0.0,
        clearcoat: 0.85,
        clearcoatRoughness: 0.12,
      }),
      ply: new MeshStandardMaterial({
        map: ply,
        roughness: 0.72,
        metalness: 0.0,
        side: DoubleSide,
      }),
      metal: new MeshStandardMaterial({
        color: 0xcdd2da,
        roughness: 0.34,
        roughnessMap: metalRough,
        metalness: 1.0,
      }),
      darkMetal: new MeshStandardMaterial({
        color: 0x3c414b,
        roughness: 0.45,
        metalness: 0.9,
      }),
      urethane: new MeshStandardMaterial({
        // Off-white, not white: at full key light a pure white wheel clips and
        // the bloom turns it into a flare.
        color: 0xb9b3a6,
        roughness: 0.64,
        metalness: 0.0,
      }),
      bushing: new MeshStandardMaterial({ color: 0xffb43a, roughness: 0.6, metalness: 0 }),
    };

    this.buildDeck();
    this.buildTrucks();

    // Sub-group holding just the wheels, so they can spin with road speed.
    this.wheelSpin = 0;
  }

  // ---------------------------------------------------------------- deck ---

  /** Half-width of the outline at u in [-1, 1]. */
  outline(u) {
    const a = Math.abs(u);
    if (a <= DECK.taperStart) return 1;
    const t = (a - DECK.taperStart) / (1 - DECK.taperStart);
    // Elliptical taper gives the rounded popsicle nose.
    return DECK.tipWidthRatio + (1 - DECK.tipWidthRatio) * Math.sqrt(Math.max(0, 1 - t * t));
  }

  /** Vertical rise of the nose/tail kick at u. */
  kickHeight(u) {
    const a = Math.abs(u);
    if (a <= DECK.kickStart) return 0;
    const t = (a - DECK.kickStart) / (1 - DECK.kickStart);
    return DECK.kick * t * t;
  }

  /** Cross-sectional concave at v in [-1, 1], flattening out over the kicks. */
  concaveAt(u, v) {
    const flatten = 1 - Math.min(1, Math.max(0, (Math.abs(u) - DECK.kickStart) / 0.4));
    return DECK.concave * v * v * flatten;
  }

  buildDeck() {
    const { segsU, segsV, thickness } = DECK;
    const hl = this.length * 0.5;
    const hw = this.width * 0.5;

    const positions = [];
    const uvs = [];
    const indices = [];

    // Two surfaces: 0 = top (grip), 1 = bottom (graphic).
    const surfaceStart = [];
    for (let s = 0; s < 2; s++) {
      surfaceStart.push(positions.length / 3);
      for (let i = 0; i <= segsU; i++) {
        const u = (i / segsU) * 2 - 1;
        const w = this.outline(u) * hw;
        const k = this.kickHeight(u);
        for (let j = 0; j <= segsV; j++) {
          const v = (j / segsV) * 2 - 1;
          const y = k + this.concaveAt(u, v) + (s === 0 ? thickness * 0.5 : -thickness * 0.5);
          positions.push(v * w, y, u * hl);
          uvs.push(s === 0 ? j / segsV : 1 - j / segsV, i / segsU);
        }
      }
      const base = surfaceStart[s];
      for (let i = 0; i < segsU; i++) {
        for (let j = 0; j < segsV; j++) {
          const a = base + i * (segsV + 1) + j;
          const b = a + 1;
          const c = a + segsV + 1;
          const d = c + 1;
          if (s === 0) indices.push(a, c, b, b, c, d);
          else indices.push(a, b, c, b, d, c); // flipped winding for the underside
        }
      }
    }

    const top = surfaceStart[0];
    const bot = surfaceStart[1];
    const row = segsV + 1;

    // Rim: stitch the two surfaces along both long edges and both tips. This is
    // a separate geometry so it can carry the ply texture.
    const rimPos = [];
    const rimUv = [];
    const rimIdx = [];
    const pushRimQuad = (p0, p1, p2, p3, uv0, uv1) => {
      const start = rimPos.length / 3;
      for (const p of [p0, p1, p2, p3]) rimPos.push(p[0], p[1], p[2]);
      rimUv.push(uv0, 0, uv1, 0, uv0, 1, uv1, 1);
      rimIdx.push(start, start + 2, start + 1, start + 1, start + 2, start + 3);
    };
    const at = (base, i, j) => {
      const idx = (base + i * row + j) * 3;
      return [positions[idx], positions[idx + 1], positions[idx + 2]];
    };

    for (let i = 0; i < segsU; i++) {
      const uv0 = i / segsU;
      const uv1 = (i + 1) / segsU;
      // Toe rail (j = segsV) and heel rail (j = 0).
      pushRimQuad(at(top, i, segsV), at(top, i + 1, segsV), at(bot, i, segsV), at(bot, i + 1, segsV), uv0, uv1);
      pushRimQuad(at(top, i + 1, 0), at(top, i, 0), at(bot, i + 1, 0), at(bot, i, 0), uv0, uv1);
    }
    for (let j = 0; j < segsV; j++) {
      const uv0 = j / segsV;
      const uv1 = (j + 1) / segsV;
      // Nose tip and tail tip.
      pushRimQuad(at(top, segsU, j), at(top, segsU, j + 1), at(bot, segsU, j), at(bot, segsU, j + 1), uv0, uv1);
      pushRimQuad(at(top, 0, j + 1), at(top, 0, j), at(bot, 0, j + 1), at(bot, 0, j), uv0, uv1);
    }

    const deckGeo = new BufferGeometry();
    deckGeo.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
    deckGeo.setAttribute('uv', new BufferAttribute(new Float32Array(uvs), 2));
    deckGeo.setIndex(indices);
    deckGeo.computeVertexNormals();

    // Split into two draw ranges so grip and graphic get their own material.
    const topCount = segsU * segsV * 6;
    deckGeo.addGroup(0, topCount, 0);
    deckGeo.addGroup(topCount, topCount, 1);

    this.deck = new Mesh(deckGeo, [this.materials.grip, this.materials.graphic]);
    this.deck.castShadow = true;
    this.deck.receiveShadow = true;
    this.add(this.deck);

    const rimGeo = new BufferGeometry();
    rimGeo.setAttribute('position', new BufferAttribute(new Float32Array(rimPos), 3));
    rimGeo.setAttribute('uv', new BufferAttribute(new Float32Array(rimUv), 2));
    rimGeo.setIndex(rimIdx);
    rimGeo.computeVertexNormals();
    this.rim = new Mesh(rimGeo, this.materials.ply);
    this.rim.castShadow = true;
    this.add(this.rim);
  }

  // -------------------------------------------------------------- trucks ---

  buildTrucks() {
    this.wheels = [];
    const wheelbase = this.length * 0.42;
    for (const dir of [1, -1]) {
      const truck = new Group();
      truck.position.set(0, -DECK.thickness * 0.5, dir * wheelbase * 0.5);
      truck.rotation.y = dir > 0 ? 0 : Math.PI;
      this.add(truck);

      // Baseplate, sitting flush under the deck.
      const plate = new Mesh(new BoxGeometry(0.058, 0.008, 0.072), this.materials.metal);
      plate.position.y = -0.004;
      plate.castShadow = true;
      truck.add(plate);

      // Kingpin block and hanger. The hanger is a squashed, tapered box: cheap,
      // and at this scale it reads exactly like cast aluminium.
      const kingpin = new Mesh(new CylinderGeometry(0.0045, 0.0045, 0.034, 8), this.materials.darkMetal);
      kingpin.position.set(0, -0.019, 0.012);
      kingpin.rotation.x = 0.62;
      truck.add(kingpin);

      const bushing = new Mesh(new CylinderGeometry(0.011, 0.009, 0.011, 12), this.materials.bushing);
      bushing.position.set(0, -0.014, 0.008);
      bushing.rotation.x = 0.62;
      truck.add(bushing);

      const hanger = new Mesh(taperedHanger(), this.materials.metal);
      hanger.position.set(0, -0.028, -0.004);
      hanger.castShadow = true;
      truck.add(hanger);

      const axle = new Mesh(new CylinderGeometry(0.0042, 0.0042, 0.19, 10), this.materials.darkMetal);
      axle.rotation.z = Math.PI / 2;
      axle.position.set(0, -0.028, -0.004);
      truck.add(axle);

      for (const side of [1, -1]) {
        const wheel = new Mesh(new CylinderGeometry(0.027, 0.027, 0.031, 22), this.materials.urethane);
        wheel.rotation.z = Math.PI / 2;
        wheel.position.set(side * 0.0855, -0.028, -0.004);
        wheel.castShadow = true;
        truck.add(wheel);

        const bearing = new Mesh(new CylinderGeometry(0.0105, 0.0105, 0.033, 14), this.materials.darkMetal);
        bearing.rotation.z = Math.PI / 2;
        bearing.position.copy(wheel.position);
        truck.add(bearing);

        this.wheels.push(wheel);
      }

      // Mounting bolts through the deck.
      for (const sx of [-1, 1]) {
        for (const sz of [-1, 1]) {
          const bolt = new Mesh(new CylinderGeometry(0.0032, 0.0032, 0.006, 6), this.materials.darkMetal);
          bolt.position.set(sx * 0.0206, 0.004, sz * 0.0206);
          truck.add(bolt);
        }
      }
    }
  }

  /**
   * Wheels roll while the board is on the ground.
   *
   * About X, not Y. Each wheel is built with `rotation.z = PI/2` to lay the
   * cylinder's axis along the board's X — the axle. Spinning it about Y then
   * swings that axle around the vertical and the wheels castor like trolley
   * wheels instead of rolling. Rotating about X leaves the axle where it is and
   * turns the wheel on it, which is the whole idea.
   */
  updateWheels(speed, dt) {
    this.wheelSpin += (speed / 0.027) * dt;
    for (const w of this.wheels) w.rotation.x = this.wheelSpin;
  }

  /** World-space position of a point given in deck-local coordinates. */
  localPoint(x, y, z, out = new Vector3()) {
    return out.set(x, y, z).applyMatrix4(this.matrixWorld);
  }
}

/** A tapered hanger body: wide where the axle passes, narrow at the pivot. */
function taperedHanger() {
  const g = new BufferGeometry();
  const w = 0.082; // half length along X
  const verts = [
    // A simple hexagonal prism stretched along X.
    [-w, 0.004, 0.012], [w, 0.004, 0.012], [w, 0.004, -0.012], [-w, 0.004, -0.012],
    [-w * 0.42, -0.014, 0.02], [w * 0.42, -0.014, 0.02], [w * 0.42, -0.014, -0.02], [-w * 0.42, -0.014, -0.02],
  ];
  const faces = [
    [0, 1, 5], [0, 5, 4],
    [1, 2, 6], [1, 6, 5],
    [2, 3, 7], [2, 7, 6],
    [3, 0, 4], [3, 4, 7],
    [4, 5, 6], [4, 6, 7],
    [3, 2, 1], [3, 1, 0],
  ];
  const pos = [];
  for (const f of faces) for (const i of f) pos.push(...verts[i]);
  g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
  g.computeVertexNormals();
  return g;
}
