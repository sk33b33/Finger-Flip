import {
  Group,
  Mesh,
  Points,
  PointsMaterial,
  BufferGeometry,
  BufferAttribute,
  RingGeometry,
  CircleGeometry,
  TorusGeometry,
  MeshBasicMaterial,
  AdditiveBlending,
  Color,
  Vector3,
  Quaternion,
  MathUtils,
} from 'three';
import Config from '../core/Config.js';
import { groundHeight, groundNormal } from '../sim/Park.js';
import { predictTouchdown } from '../sim/Landing.js';
import { radialSprite } from './textures.js';

/**
 * Everything drawn to make the trick readable:
 *
 *   - a marker per fingertip, showing where in space the finger is and how
 *     firmly it has hold of the deck,
 *   - a hand-plane ring, so the player can see the plane their fingers move in,
 *   - a landing reticle projected on the ground, coloured by how good the
 *     landing would be if the board hit right now,
 *   - sparks and a scuff ring on touchdown.
 *
 * All of it fades out with the trick, so normal skating stays clean.
 */

const GOOD = new Color(0x35f0a0);
const OK = new Color(0xffd23f);
const BAD = new Color(0xff4d3a);

// Where the finger-home hints sit along the deck: over the truck bolts, the
// same spot the keyboard fingers rest at.
const HOME_HINT = 0.22;

// Above this height the contact shadow has spread out to nothing useful.
const SHADOW_FADE_HEIGHT = 3.2;

const _v = new Vector3();
const _n = new Vector3();
const _q = new Quaternion();

export default class TrickFX extends Group {
  constructor() {
    super();
    this.opacity = 0;

    // ------------------------------------------------------- fingertips ---
    this.tips = [];
    for (let i = 0; i < 2; i++) {
      const tip = new Group();

      const ring = new Mesh(
        new TorusGeometry(0.036, 0.0055, 8, 28),
        new MeshBasicMaterial({
          color: 0xffffff,
          transparent: true,
          opacity: 0.9,
          blending: AdditiveBlending,
          depthWrite: false,
        }),
      );
      ring.rotation.x = -Math.PI / 2;
      tip.add(ring);

      const core = new Mesh(
        new CircleGeometry(0.019, 20),
        new MeshBasicMaterial({
          color: 0xffffff,
          transparent: true,
          opacity: 0.55,
          blending: AdditiveBlending,
          depthWrite: false,
        }),
      );
      core.rotation.x = -Math.PI / 2;
      tip.add(core);

      // The outer halo grows when the finger is gripping hard.
      const halo = new Mesh(
        new CircleGeometry(0.07, 24),
        new MeshBasicMaterial({
          color: 0xffffff,
          transparent: true,
          opacity: 0.0,
          blending: AdditiveBlending,
          depthWrite: false,
        }),
      );
      halo.rotation.x = -Math.PI / 2;
      tip.add(halo);

      tip.visible = false;
      this.add(tip);
      this.tips.push({ group: tip, ring, core, halo });
    }

    // ------------------------------------------------------ finger homes ---
    // Where to put your fingers, shown only while there are none on the board.
    // A touch player arriving in the close-up for the first time has no other
    // way of knowing the deck is the control surface.
    this.homes = [];
    for (const along of [-HOME_HINT, HOME_HINT]) {
      const ring = new Mesh(
        new RingGeometry(0.028, 0.038, 28),
        new MeshBasicMaterial({
          color: 0xffffff,
          transparent: true,
          opacity: 0,
          blending: AdditiveBlending,
          depthWrite: false,
        }),
      );
      ring.rotation.x = -Math.PI / 2;
      const carrier = new Group();
      carrier.add(ring);
      carrier.userData.along = along;
      this.add(carrier);
      this.homes.push({ carrier, ring });
    }
    this.homeFade = 0;

    // ------------------------------------------------------- hand plane ---
    // Nested in a carrier: the carrier takes the stance rotation, the mesh keeps
    // the -90 degrees that lays it flat. Writing both onto one object would have
    // the quaternion silently overwrite the euler.
    this.planeCarrier = new Group();
    this.planeRing = new Mesh(
      new RingGeometry(0.3, 0.325, 48),
      new MeshBasicMaterial({
        color: 0x7fd4ff,
        transparent: true,
        opacity: 0,
        blending: AdditiveBlending,
        depthWrite: false,
      }),
    );
    this.planeRing.rotation.x = -Math.PI / 2;
    this.planeRing.renderOrder = 4;
    this.planeCarrier.add(this.planeRing);
    this.add(this.planeCarrier);

    // ---------------------------------------------------- contact shadow ---
    // The sun's shadow map is coarse at trick range, and height above the
    // ground is the one thing the close-up shot cannot show directly. A blob
    // that tightens and darkens as the board falls reads as height at a glance
    // — a gameplay cue at least as much as a visual one.
    this.shadowCarrier = new Group();
    this.contactShadow = new Mesh(
      new CircleGeometry(0.5, 32),
      new MeshBasicMaterial({
        color: 0x0a0d14,
        alphaMap: radialSprite(128),
        transparent: true,
        opacity: 0,
        depthWrite: false,
      }),
    );
    this.contactShadow.rotation.x = -Math.PI / 2;
    this.contactShadow.renderOrder = 2;
    this.shadowCarrier.add(this.contactShadow);
    this.add(this.shadowCarrier);

    // ---------------------------------------------------------- reticle ---
    this.reticle = new Group();
    const outer = new Mesh(
      new RingGeometry(0.5, 0.56, 44),
      new MeshBasicMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: 0,
        blending: AdditiveBlending,
        depthWrite: false,
      }),
    );
    outer.rotation.x = -Math.PI / 2;
    this.reticle.add(outer);
    const inner = new Mesh(
      new RingGeometry(0.16, 0.2, 30),
      new MeshBasicMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: 0,
        blending: AdditiveBlending,
        depthWrite: false,
      }),
    );
    inner.rotation.x = -Math.PI / 2;
    this.reticle.add(inner);
    this.reticleParts = [outer, inner];
    this.add(this.reticle);

    // ----------------------------------------------------------- sparks ---
    this.sparkCount = 90;
    const pos = new Float32Array(this.sparkCount * 3);
    const geo = new BufferGeometry();
    geo.setAttribute('position', new BufferAttribute(pos, 3));
    this.sparkVel = new Float32Array(this.sparkCount * 3);
    this.sparkLife = new Float32Array(this.sparkCount);
    this.sparks = new Points(
      geo,
      new PointsMaterial({
        size: 0.055,
        map: radialSprite(64),
        color: 0xffd9a0,
        transparent: true,
        opacity: 0.95,
        blending: AdditiveBlending,
        depthWrite: false,
        sizeAttenuation: true,
      }),
    );
    this.sparks.frustumCulled = false;
    this.add(this.sparks);

    // Scuff ring that pops on touchdown.
    this.scuff = new Mesh(
      new RingGeometry(0.1, 0.16, 32),
      new MeshBasicMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: 0,
        blending: AdditiveBlending,
        depthWrite: false,
      }),
    );
    this.scuff.rotation.x = -Math.PI / 2;
    this.add(this.scuff);
    this.scuffT = 0;
  }

  /**
   * @param {number} realDelta
   * @param {object} s state bundle from the game
   */
  update(realDelta, s) {
    const {
      // The INTERPOLATED board position, not board.position. Everything drawn
      // around the deck — the finger reticles, the contact shadow, the plane
      // ring — has to sit in the same render space as the deck itself, or it
      // slides against it by up to one physics step. In slow motion that step
      // spans two rendered frames and the whole assembly shudders.
      boardPos,
      fingers,
      stanceQuat,
      trickActive,
      landingQuality, // 0..1 preview
      predictedLanding, // Vector3 or null
      airborne,
    } = s;

    const targetOpacity = trickActive ? 1 : 0;
    this.opacity = MathUtils.lerp(this.opacity, targetOpacity, 1 - Math.exp(-9 * realDelta));
    const o = this.opacity;

    // ------------------------------------------------------- fingertips ---
    for (let i = 0; i < 2; i++) {
      const f = fingers.fingers[i];
      const t = this.tips[i];
      const show = o > 0.02 && (f.active || f.contact > 0.02);
      t.group.visible = show;
      if (!show) continue;

      _v.copy(f.pos).applyQuaternion(stanceQuat).add(boardPos);
      t.group.position.copy(_v);
      t.group.quaternion.copy(stanceQuat);

      const c = f.contact;
      const col = c > 0.6 ? GOOD : c > 0.15 ? OK : BAD;
      t.ring.material.color.copy(col);
      t.core.material.color.copy(col);
      t.halo.material.color.copy(col);

      t.ring.material.opacity = o * (0.45 + 0.5 * c);
      t.core.material.opacity = o * (0.25 + 0.5 * c);
      t.halo.material.opacity = o * 0.22 * c;
      const scale = 1 + 0.35 * c;
      t.ring.scale.setScalar(scale);
      t.halo.scale.setScalar(0.7 + 0.9 * c);
    }

    // ---------------------------------------------------- contact shadow ---
    // Driven by height above the surface directly under the board, so it is
    // legible on a ramp face as well as on the flat.
    const shadowOn = airborne || boardPos.y > 0.001;
    this.shadowCarrier.visible = shadowOn;
    if (shadowOn) {
      const surface = groundHeight(boardPos.x, boardPos.z);
      const height = Math.max(0, boardPos.y - surface);
      const t = MathUtils.clamp(height / SHADOW_FADE_HEIGHT, 0, 1);

      this.shadowCarrier.position.set(boardPos.x, surface + 0.012, boardPos.z);
      groundNormal(boardPos.x, boardPos.z, _n);
      _q.setFromUnitVectors(UP, _n);
      this.shadowCarrier.quaternion.copy(_q);

      // Close to the ground: small, dark and tight. High up: wide and faint.
      const spread = MathUtils.lerp(0.62, 2.1, t);
      this.shadowCarrier.scale.set(spread, 1, spread);
      this.contactShadow.material.opacity = MathUtils.lerp(0.62, 0.06, t);
    }

    // ------------------------------------------------------ finger homes ---
    // Fade the hints out the moment a finger arrives, and back in if the player
    // takes both off again.
    const anyDown = fingers.fingers.some((f) => f.active);
    const wantHomes = trickActive && !anyDown ? 1 : 0;
    this.homeFade = MathUtils.lerp(this.homeFade, wantHomes, 1 - Math.exp(-7 * realDelta));
    const pulse = 0.62 + 0.38 * Math.sin(performance.now() * 0.005);
    for (const h of this.homes) {
      const show = this.homeFade > 0.02 && o > 0.02;
      h.carrier.visible = show;
      if (!show) continue;
      _v.set(0, 0, h.carrier.userData.along).applyQuaternion(stanceQuat).add(boardPos);
      h.carrier.position.copy(_v);
      h.carrier.quaternion.copy(stanceQuat);
      h.ring.material.opacity = this.homeFade * o * 0.5 * pulse;
      h.ring.scale.setScalar(1 + 0.16 * (1 - pulse));
    }

    // ------------------------------------------------------- hand plane ---
    this.planeCarrier.visible = o > 0.02;
    if (this.planeCarrier.visible) {
      this.planeCarrier.position.copy(boardPos);
      this.planeCarrier.quaternion.copy(stanceQuat);
      this.planeRing.material.opacity = o * 0.14;
    }

    // ---------------------------------------------------------- reticle ---
    const showReticle = o > 0.02 && airborne && predictedLanding;
    this.reticle.visible = showReticle;
    if (showReticle) {
      this.reticle.position.copy(predictedLanding);
      groundNormal(predictedLanding.x, predictedLanding.z, _n);
      _q.setFromUnitVectors(UP, _n);
      this.reticle.quaternion.copy(_q); // children carry the flat-lay rotation
      const col =
        landingQuality > 0.72 ? GOOD : landingQuality > 0.38 ? OK : BAD;
      const pulse = 0.6 + 0.4 * Math.sin(performance.now() * 0.006);
      for (const part of this.reticleParts) {
        part.material.color.copy(col);
        part.material.opacity = o * 0.5 * (0.6 + 0.4 * landingQuality);
      }
      this.reticleParts[1].material.opacity *= pulse;
      this.reticle.scale.setScalar(1 - 0.18 * landingQuality);
    }

    this.updateSparks(realDelta);
  }

  updateSparks(dt) {
    const pos = this.sparks.geometry.attributes.position.array;
    let alive = false;
    for (let i = 0; i < this.sparkCount; i++) {
      if (this.sparkLife[i] <= 0) continue;
      alive = true;
      this.sparkLife[i] -= dt;
      const j = i * 3;
      this.sparkVel[j + 1] -= 9.5 * dt;
      pos[j] += this.sparkVel[j] * dt;
      pos[j + 1] += this.sparkVel[j + 1] * dt;
      pos[j + 2] += this.sparkVel[j + 2] * dt;
      const h = groundHeight(pos[j], pos[j + 2]);
      if (pos[j + 1] < h + 0.01) {
        pos[j + 1] = h + 0.01;
        this.sparkVel[j + 1] *= -0.32;
        this.sparkVel[j] *= 0.6;
        this.sparkVel[j + 2] *= 0.6;
      }
      if (this.sparkLife[i] <= 0) pos[j + 1] = -999;
    }
    this.sparks.visible = alive;
    if (alive) this.sparks.geometry.attributes.position.needsUpdate = true;

    if (this.scuffT > 0) {
      this.scuffT -= dt * 2.2;
      const t = Math.max(0, this.scuffT);
      this.scuff.visible = true;
      this.scuff.material.opacity = t * 0.6;
      this.scuff.scale.setScalar(1 + (1 - t) * 5);
    } else {
      this.scuff.visible = false;
    }
  }

  /** Fire a burst at a world position. `power` 0..1 scales speed and colour. */
  burst(position, power, tint = 0xffd9a0) {
    this.sparks.material.color.setHex(tint);
    const pos = this.sparks.geometry.attributes.position.array;
    const n = Math.round(28 + power * 55);
    let placed = 0;
    for (let i = 0; i < this.sparkCount && placed < n; i++) {
      if (this.sparkLife[i] > 0) continue;
      const j = i * 3;
      pos[j] = position.x;
      pos[j + 1] = position.y + 0.02;
      pos[j + 2] = position.z;
      const a = Math.random() * Math.PI * 2;
      const sp = (1.4 + Math.random() * 3.6) * (0.4 + power);
      this.sparkVel[j] = Math.cos(a) * sp;
      this.sparkVel[j + 1] = 1.2 + Math.random() * 3.2 * power;
      this.sparkVel[j + 2] = Math.sin(a) * sp;
      this.sparkLife[i] = 0.35 + Math.random() * 0.5;
      placed++;
    }
    this.sparks.geometry.attributes.position.needsUpdate = true;

    this.scuff.position.copy(position);
    this.scuff.position.y += 0.015;
    this.scuff.scale.setScalar(1);
    this.scuffT = 1;
    this.scuff.material.color.setHex(tint);
  }
}

const UP = new Vector3(0, 1, 0);

/**
 * Where the rider will touch down. A thin wrapper now: the marcher itself lives
 * in sim/Landing.js, because slow motion needs the TIME from the same solve and
 * two copies of it would drift apart. Used by the reticle and the camera, so
 * they never disagree with each other or with the pacing.
 */
export function predictLanding(position, velocity, out = new Vector3()) {
  return predictTouchdown(position, velocity, out).point;
}
