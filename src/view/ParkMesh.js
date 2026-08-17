import {
  Group,
  Mesh,
  BufferGeometry,
  BufferAttribute,
  MeshStandardMaterial,
  MeshBasicMaterial,
  BoxGeometry,
  InstancedMesh,
  Object3D,
  Color,
  Vector2,
} from 'three';
import Config from '../core/Config.js';
import { groundHeight, featureHeightAt, terrainHeight, isLip, runLength } from '../sim/Park.js';
import {
  concreteTexture,
  concreteRoughness,
  concreteNormal,
  woodTexture,
  woodRoughness,
} from './textures.js';

/**
 * Visual skatepark, tessellated straight out of the same height function the
 * physics uses, so what you see is exactly what you land on.
 *
 * One run-length of park is built once as a self-contained tile (ground, lip
 * trim, fence, skyline) and three copies are cycled around the rider, giving an
 * endless run with no teleport and no rebuild.
 */

const SEG_Z = 0.35;
const SEG_X = 0.55;
// Metres of flat deck either side of the rideable lane. Kept tight: a wide
// empty plaza reads as slow, and the fence line is the main speed cue.
const MARGIN = 6;

export default class ParkMesh extends Group {
  constructor() {
    super();
    this.run = runLength();
    this.halfX = Config.park.laneHalfWidth + MARGIN;

    this.material = this.buildGroundMaterial();

    this.shared = {
      ground: this.buildGroundGeometry(),
      lipTrim: this.buildLipTrimGeometry(),
      post: new BoxGeometry(0.09, 2.2, 0.09),
      box: new BoxGeometry(1, 1, 1),
      trimMat: new MeshStandardMaterial({
        color: 0xff5d3a,
        emissive: 0xff3d18,
        emissiveIntensity: 0.32,
        roughness: 0.6,
        metalness: 0,
      }),
      postMat: new MeshStandardMaterial({ color: 0x4b5058, roughness: 0.85, metalness: 0.2 }),
      buildingMat: new MeshStandardMaterial({ color: 0xffffff, roughness: 0.92, metalness: 0.05 }),
    };

    this.tiles = [];
    for (let i = -1; i <= 1; i++) {
      const tile = this.buildTile();
      tile.position.z = i * this.run;
      tile.userData.index = i;
      this.add(tile);
      this.tiles.push(tile);
    }

    this.apron = this.buildApron();
    this.add(this.apron);
  }

  // --------------------------------------------------------------- apron ---

  /**
   * Far ground, so the concrete never just stops in mid-air.
   *
   * This has to be a sheet that FOLLOWS THE TERRAIN, and the reason is worth
   * writing down because two simpler versions of it have already shipped and
   * both were wrong.
   *
   * A flat plane just under y = 0 cuts straight through the ground wherever the
   * lap descends below it. Sinking it into a thick slab instead only moved the
   * problem: a box from -12.1 to -0.1 still has its lid three metres ABOVE a
   * park that drops to -3, and while rolling you never saw it — the chase
   * camera sits inside the box, and a BoxGeometry's back faces are culled, so
   * you look straight through. The moment a trick lifted the camera out through
   * the lid, the lid occluded the entire park and the floor vanished.
   *
   * Tracking terrainHeight() fixes it at the root. The sheet is 6cm under the
   * ground everywhere and features only ever rise, so nothing it could occlude
   * is ever behind it, from any camera height. The 6cm is also what keeps it off
   * the park's own surface out at x = +/-halfX, where no feature reaches and the
   * two would otherwise z-fight.
   */
  buildApron() {
    const REACH = 450; // out to the fog, which closes at 420m
    const STEP = 4;
    const xs = [-REACH, -this.halfX, this.halfX, REACH];
    const z0 = -this.run * 1.5;
    const z1 = this.run * 1.5;
    const nz = Math.ceil((z1 - z0) / STEP);

    const positions = new Float32Array(xs.length * (nz + 1) * 3);
    const indices = [];
    let p = 0;
    for (let j = 0; j <= nz; j++) {
      const z = z0 + (j / nz) * (z1 - z0);
      const y = terrainHeight(z) - 0.06;
      for (const x of xs) {
        positions[p++] = x;
        positions[p++] = y;
        positions[p++] = z;
      }
    }
    for (let j = 0; j < nz; j++) {
      for (let i = 0; i < xs.length - 1; i++) {
        const a = j * xs.length + i;
        const c = a + xs.length;
        indices.push(a, c, a + 1, a + 1, c, c + 1);
      }
    }

    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(positions, 3));
    g.setIndex(indices);
    g.computeVertexNormals();

    // Unlit and fogged: it exists to meet the sky, not to be looked at.
    return new Mesh(g, new MeshBasicMaterial({ color: 0x252a32 }));
  }

  // ----------------------------------------------------------- material ---

  /**
   * One material for the whole park surface, blending concrete on the flat into
   * wood on everything raised.
   *
   * The blend comes from a per-vertex attribute rather than a second mesh, so
   * it stays a single draw call and there is no seam to hide — the transition
   * happens over the first few centimetres at the base of each feature.
   *
   * Only colour and roughness are blended. The wood deliberately reuses the
   * concrete normal map: at the scale it is applied, fine tooth reads as grain
   * just as well, and overriding three's normal chunk is far more fragile than
   * overriding the two below for a difference nobody will see.
   */
  buildGroundMaterial() {
    const material = new MeshStandardMaterial({
      map: concreteTexture(),
      roughnessMap: concreteRoughness(),
      normalMap: concreteNormal(),
      normalScale: new Vector2(0.32, 0.32),
      color: 0xffffff,
      roughness: 1.0,
      metalness: 0.0,
    });

    const uniforms = {
      uWoodMap: { value: woodTexture() },
      uWoodRoughness: { value: woodRoughness() },
      uConcreteTint: { value: new Color(0xa9adb6) },
      uWoodTint: { value: new Color(0xb28a5f) },
    };
    material.userData.uniforms = uniforms;

    material.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, uniforms);

      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          `#include <common>
           attribute float featureBlend;
           varying float vFeatureBlend;`,
        )
        .replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>
           vFeatureBlend = featureBlend;`,
        );

      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>
           uniform sampler2D uWoodMap;
           uniform sampler2D uWoodRoughness;
           uniform vec3 uConcreteTint;
           uniform vec3 uWoodTint;
           varying float vFeatureBlend;`,
        )
        .replace(
          '#include <map_fragment>',
          `#include <map_fragment>
           {
             vec4 woodTexel = texture2D(uWoodMap, vMapUv * WOOD_UV_SCALE);
             vec3 concreteCol = diffuseColor.rgb * uConcreteTint;
             vec3 woodCol = woodTexel.rgb * uWoodTint;
             diffuseColor.rgb = mix(concreteCol, woodCol, vFeatureBlend);
           }`,
        )
        .replace(
          '#include <roughnessmap_fragment>',
          `#include <roughnessmap_fragment>
           {
             float woodRough = texture2D(uWoodRoughness, vMapUv * WOOD_UV_SCALE).g;
             roughnessFactor = mix(roughnessFactor, woodRough, vFeatureBlend);
           }`,
        );
    };

    // The wood tiles at its own rate; the concrete's repeat lives on its
    // texture, but a second sampler sharing vMapUv has to scale in the shader.
    material.defines = { WOOD_UV_SCALE: '1.0' };
    return material;
  }

  // ------------------------------------------------------------ geometry ---

  buildGroundGeometry() {
    const halfX = this.halfX;
    const nx = Math.ceil((halfX * 2) / SEG_X);
    const nz = Math.ceil(this.run / SEG_Z);

    const positions = new Float32Array((nx + 1) * (nz + 1) * 3);
    const uvs = new Float32Array((nx + 1) * (nz + 1) * 2);
    const blend = new Float32Array((nx + 1) * (nz + 1));
    const indices = [];

    let p = 0;
    let q = 0;
    let b = 0;
    for (let j = 0; j <= nz; j++) {
      const z = (j / nz) * this.run;
      for (let i = 0; i <= nx; i++) {
        const x = -halfX + (i / nx) * halfX * 2;
        const h = groundHeight(x, z);
        positions[p++] = x;
        positions[p++] = h;
        positions[p++] = z;
        uvs[q++] = (x + halfX) / (halfX * 2);
        uvs[q++] = z / this.run;
        // Anything raised above the TERRAIN is a built feature, and built
        // features are wood. Keyed off absolute height instead, the whole of
        // the lap's descent would come out below zero and the long climb back
        // would be painted as one enormous wooden ramp.
        blend[b++] = smoothstep(0.02, 0.14, featureHeightAt(x, z));
      }
    }
    for (let j = 0; j < nz; j++) {
      for (let i = 0; i < nx; i++) {
        const a = j * (nx + 1) + i;
        const b = a + 1;
        const c = a + nx + 1;
        indices.push(a, c, b, b, c, c + 1);
      }
    }

    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(positions, 3));
    g.setAttribute('uv', new BufferAttribute(uvs, 2));
    g.setAttribute('featureBlend', new BufferAttribute(blend, 1));
    g.setIndex(indices);
    g.computeVertexNormals();
    return g;
  }

  /** Where the launch lips are, and how wide each one is. */
  findLips() {
    const spots = [];
    for (let z = 0; z < this.run; z += 0.25) {
      if (!isLip(0, z, 0.5)) continue;
      if (isLip(0, z + 0.25, 0.5)) continue; // keep only the trailing edge
      let w = 0.5;
      while (w < this.halfX && groundHeight(w, z) > 0.05) w += 0.25;
      // Inset a little so the strip sits on the lip rather than overhanging it.
      spots.push({ z, width: Math.max(1.6, w * 1.8), y: groundHeight(0, z) });
    }
    return spots;
  }

  buildLipTrimGeometry() {
    return new BoxGeometry(1, 0.035, 0.1);
  }

  // ---------------------------------------------------------------- tile ---

  buildTile() {
    const tile = new Group();
    const dummy = new Object3D();

    const ground = new Mesh(this.shared.ground, this.material);
    ground.receiveShadow = true;
    tile.add(ground);

    // Bright strip on every launch lip. Purely a readability device: the player
    // has to see the takeoff coming from a long way back.
    const lips = this.findLips();
    if (lips.length) {
      const trim = new InstancedMesh(this.shared.lipTrim, this.shared.trimMat, lips.length);
      lips.forEach((l, i) => {
        dummy.position.set(0, l.y + 0.025, l.z + 0.02);
        dummy.scale.set(l.width, 1, 1);
        dummy.rotation.set(0, 0, 0);
        dummy.updateMatrix();
        trim.setMatrixAt(i, dummy.matrix);
      });
      trim.instanceMatrix.needsUpdate = true;
      tile.add(trim);
    }

    // Perimeter fence.
    const perSide = Math.floor(this.run / 6);
    const posts = new InstancedMesh(this.shared.post, this.shared.postMat, perSide * 2);
    let n = 0;
    for (let i = 0; i < perSide; i++) {
      for (const s of [-1, 1]) {
        dummy.position.set(s * this.halfX, 1.1, i * 6 + 1);
        dummy.scale.set(1, 1, 1);
        dummy.rotation.set(0, 0, 0);
        dummy.updateMatrix();
        posts.setMatrixAt(n++, dummy.matrix);
      }
    }
    posts.instanceMatrix.needsUpdate = true;
    tile.add(posts);

    // Skyline. Deterministic, so every tile matches and the loop is invisible.
    const COUNT = 52;
    const buildings = new InstancedMesh(this.shared.box, this.shared.buildingMat, COUNT);
    const rnd = makeRng(20260815);
    const tint = new Color();
    for (let i = 0; i < COUNT; i++) {
      const s = rnd() > 0.5 ? 1 : -1;
      const w = 5 + rnd() * 13;
      const h = 6 + rnd() * 28;
      const d = 5 + rnd() * 13;
      dummy.position.set(s * (this.halfX + 12 + rnd() * 52), h / 2, rnd() * this.run);
      dummy.scale.set(w, h, d);
      dummy.rotation.set(0, rnd() * 0.4 - 0.2, 0);
      dummy.updateMatrix();
      buildings.setMatrixAt(i, dummy.matrix);
      // setColorAt allocates and flags the attribute the way the renderer
      // expects; assigning instanceColor by hand silently does nothing.
      tint.setHSL(0.6 + rnd() * 0.09, 0.16, 0.1 + rnd() * 0.13);
      buildings.setColorAt(i, tint);
    }
    buildings.instanceMatrix.needsUpdate = true;
    buildings.instanceColor.needsUpdate = true;
    tile.add(buildings);

    return tile;
  }

  /** Cycle the tiles so one is always centred on the rider. */
  follow(riderZ) {
    const centre = Math.round(riderZ / this.run) * this.run;
    for (const tile of this.tiles) tile.position.z = centre + tile.userData.index * this.run;
    // Safe to slide the apron by the same amount: `centre` is always a whole
    // number of run lengths and the terrain is periodic over one, so the
    // profile it was baked with still lines up after the shift.
    this.apron.position.z = centre;
  }
}

function smoothstep(a, b, x) {
  if (b <= a) return x >= b ? 1 : 0;
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

function makeRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}
