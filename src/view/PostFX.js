import {
  WebGLRenderTarget,
  HalfFloatType,
  LinearFilter,
  ClampToEdgeWrapping,
  ShaderMaterial,
  OrthographicCamera,
  Scene,
  Mesh,
  PlaneGeometry,
  Vector2,
  NoBlending,
  DataTexture,
} from 'three';
import Config from '../core/Config.js';

/**
 * A small hand-rolled composer. Three passes, no example dependencies:
 *
 *   1. scene  -> MSAA HDR target
 *   2. bright -> two mip levels of separable blur (the bloom)
 *   3. composite: bloom + radial motion blur + chromatic aberration + vignette
 *      + grain, all driven by a single `slowmo` uniform.
 *
 * Everything that intensifies during Nail-the-Trick keys off that one uniform,
 * so the whole look ramps together instead of drifting out of sync.
 */

const QUAD_VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

const BRIGHT_FRAG = /* glsl */ `
  varying vec2 vUv;
  uniform sampler2D tDiffuse;
  uniform float uThreshold;
  uniform float uSoft;
  void main() {
    vec3 c = texture2D(tDiffuse, vUv).rgb;
    float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
    float k = smoothstep(uThreshold, uThreshold + uSoft, l);
    gl_FragColor = vec4(c * k, 1.0);
  }
`;

// Nine-tap Gaussian, separable. Cheap and smooth enough for bloom.
const BLUR_FRAG = /* glsl */ `
  varying vec2 vUv;
  uniform sampler2D tDiffuse;
  uniform vec2 uDir;     // texel-sized step
  void main() {
    vec3 sum = texture2D(tDiffuse, vUv).rgb * 0.227027;
    vec2 o1 = uDir * 1.3846153846;
    vec2 o2 = uDir * 3.2307692308;
    sum += texture2D(tDiffuse, vUv + o1).rgb * 0.3162162162;
    sum += texture2D(tDiffuse, vUv - o1).rgb * 0.3162162162;
    sum += texture2D(tDiffuse, vUv + o2).rgb * 0.0702702703;
    sum += texture2D(tDiffuse, vUv - o2).rgb * 0.0702702703;
    gl_FragColor = vec4(sum, 1.0);
  }
`;

const COMPOSITE_FRAG = /* glsl */ `
  varying vec2 vUv;
  uniform sampler2D tDiffuse;
  uniform sampler2D tBloomA;
  uniform sampler2D tBloomB;
  uniform vec2 uResolution;
  uniform float uTime;
  uniform float uSlowmo;      // 0..1 how deep into Nail-the-Trick we are
  uniform float uBloom;
  uniform float uChroma;
  uniform float uVignette;
  uniform float uGrain;
  uniform float uRadial;
  uniform vec2 uFocus;        // NDC-ish centre the radial blur spins around
  uniform float uFlash;       // landing / bail impact flash

  float hash(vec2 p) {
    p = fract(p * vec2(443.897, 441.423));
    p += dot(p, p.yx + 19.19);
    return fract((p.x + p.y) * p.x);
  }

  vec3 sampleScene(vec2 uv) {
    return texture2D(tDiffuse, uv).rgb;
  }

  void main() {
    vec2 uv = vUv;
    vec2 toCentre = uv - uFocus;
    float dist = length(toCentre);

    // --- Radial motion blur and chromatic aberration, in one pass ----------
    // Both effects are radial about the focus point, so they share a single
    // set of taps with a per-channel scale. Blurring first and then fetching
    // sharp samples for R and B (the obvious way round) mixes a blurred green
    // with sharp red and blue, which fringes every high-contrast edge.
    float radial = uRadial * uSlowmo;
    float chroma = uChroma * (0.35 + dist * 1.65) / max(dist, 1e-4);

    vec3 base;
    if (radial > 0.001) {
      vec3 acc = vec3(0.0);
      float total = 0.0;
      for (int i = 0; i < RADIAL_TAPS; i++) {
        float t = float(i) / float(RADIAL_TAPS - 1);
        // Strength grows with distance from the focus, so the board stays sharp
        // and the world smears past it.
        float scale = 1.0 - radial * 0.06 * t * dist * 2.2;
        float w = 1.0 - t * 0.55;
        acc.r += sampleScene(uFocus + toCentre * (scale + chroma)).r * w;
        acc.g += sampleScene(uFocus + toCentre * scale).g * w;
        acc.b += sampleScene(uFocus + toCentre * (scale - chroma)).b * w;
        total += w;
      }
      base = acc / total;
    } else {
      base.r = sampleScene(uFocus + toCentre * (1.0 + chroma)).r;
      base.g = sampleScene(uv).g;
      base.b = sampleScene(uFocus + toCentre * (1.0 - chroma)).b;
    }

    // --- Bloom ------------------------------------------------------------
    vec3 bloom = texture2D(tBloomA, uv).rgb * 0.62 + texture2D(tBloomB, uv).rgb * 0.38;
    vec3 col = base + bloom * uBloom;

    // --- Impact flash -----------------------------------------------------
    col += vec3(1.0, 0.96, 0.9) * uFlash;

    // --- Slow-motion colour grade -----------------------------------------
    // Cooler shadows and a touch more saturation, so the trick window reads as
    // a different place without going full sepia.
    if (uSlowmo > 0.001) {
      float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
      vec3 graded = mix(vec3(l), col, 1.0 + 0.30 * uSlowmo);
      graded *= mix(vec3(1.0), vec3(0.94, 0.98, 1.10), uSlowmo);
      col = mix(col, graded, uSlowmo);
    }

    // --- Vignette ---------------------------------------------------------
    float v = 1.0 - uVignette * dot(toCentre, toCentre) * (1.0 + 0.55 * uSlowmo);
    col *= clamp(v, 0.0, 1.0);

    // --- Grain ------------------------------------------------------------
    float g = hash(uv * uResolution + fract(uTime) * 137.0) - 0.5;
    col += g * uGrain;

    gl_FragColor = vec4(max(col, 0.0), 1.0);
    #include <colorspace_fragment>
  }
`;

/** Minimal full-screen triangle-ish quad renderer. */
class Quad {
  constructor(material) {
    this.camera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.scene = new Scene();
    this.mesh = new Mesh(new PlaneGeometry(2, 2), material);
    this.mesh.frustumCulled = false;
    this.scene.add(this.mesh);
  }
  get material() {
    return this.mesh.material;
  }
  set material(m) {
    this.mesh.material = m;
  }
  render(renderer, target) {
    renderer.setRenderTarget(target || null);
    renderer.render(this.scene, this.camera);
  }
}

const rtOpts = {
  type: HalfFloatType,
  minFilter: LinearFilter,
  magFilter: LinearFilter,
  wrapS: ClampToEdgeWrapping,
  wrapT: ClampToEdgeWrapping,
  depthBuffer: false,
};

export default class PostFX {
  constructor(renderer) {
    this.renderer = renderer;
    this.enabled = true;

    this.sceneTarget = new WebGLRenderTarget(1, 1, {
      type: HalfFloatType,
      minFilter: LinearFilter,
      magFilter: LinearFilter,
      samples: 4, // MSAA on the HDR target: cheaper and cleaner than FXAA here
    });

    this.bloomA = [new WebGLRenderTarget(1, 1, rtOpts), new WebGLRenderTarget(1, 1, rtOpts)];
    this.bloomB = [new WebGLRenderTarget(1, 1, rtOpts), new WebGLRenderTarget(1, 1, rtOpts)];

    this.brightMat = new ShaderMaterial({
      vertexShader: QUAD_VERT,
      fragmentShader: BRIGHT_FRAG,
      blending: NoBlending,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        tDiffuse: { value: null },
        uThreshold: { value: Config.fx.bloomThreshold },
        uSoft: { value: 0.35 },
      },
    });

    this.blurMat = new ShaderMaterial({
      vertexShader: QUAD_VERT,
      fragmentShader: BLUR_FRAG,
      blending: NoBlending,
      depthTest: false,
      depthWrite: false,
      uniforms: { tDiffuse: { value: null }, uDir: { value: new Vector2() } },
    });

    this.radialTaps = 6;
    this.bloomEnabled = true;
    this.compositeMat = new ShaderMaterial({
      vertexShader: QUAD_VERT,
      fragmentShader: COMPOSITE_FRAG,
      defines: { RADIAL_TAPS: 6 },
      blending: NoBlending,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        tDiffuse: { value: null },
        tBloomA: { value: null },
        tBloomB: { value: null },
        uResolution: { value: new Vector2(1, 1) },
        uTime: { value: 0 },
        uSlowmo: { value: 0 },
        uBloom: { value: Config.fx.bloomStrength },
        uChroma: { value: Config.fx.chromaBase },
        uVignette: { value: Config.fx.vignette },
        uGrain: { value: Config.fx.grain },
        uRadial: { value: Config.fx.radialBlurSlowmo },
        uFocus: { value: new Vector2(0.5, 0.5) },
        uFlash: { value: 0 },
      },
    });

    this.quad = new Quad(this.compositeMat);

    // A 1x1 black texture to stand in for the bloom buffers when bloom is off,
    // so the composite shader needs no branch and no second variant.
    this.black = new DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
    this.black.needsUpdate = true;
  }

  setSize(w, h, pixelRatio) {
    const W = Math.max(1, Math.floor(w * pixelRatio));
    const H = Math.max(1, Math.floor(h * pixelRatio));
    this.sceneTarget.setSize(W, H);
    for (const rt of this.bloomA) rt.setSize(Math.max(1, W >> 1), Math.max(1, H >> 1));
    for (const rt of this.bloomB) rt.setSize(Math.max(1, W >> 2), Math.max(1, H >> 2));
    this.compositeMat.uniforms.uResolution.value.set(W, H);
  }

  /**
   * Change how many taps the radial blur takes. Recompiles the composite, so it
   * is only called when the quality tier actually moves.
   */
  setRadialTaps(taps) {
    const n = Math.max(2, Math.round(taps));
    if (n === this.radialTaps) return;
    this.radialTaps = n;
    this.compositeMat.defines.RADIAL_TAPS = n;
    this.compositeMat.needsUpdate = true;
  }

  /**
   * @param {number} slowmo 0..1
   * @param {{x:number,y:number}} focus screen UV the radial blur pivots around
   * @param {number} flash 0..1 impact flash
   */
  setLook(slowmo, focus, flash, time) {
    const u = this.compositeMat.uniforms;
    u.uSlowmo.value = slowmo;
    u.uFocus.value.set(focus.x, focus.y);
    u.uFlash.value = flash;
    u.uTime.value = time;
    u.uChroma.value =
      Config.fx.chromaBase + (Config.fx.chromaSlowmo - Config.fx.chromaBase) * slowmo;
  }

  render(scene, camera) {
    const r = this.renderer;

    if (!this.enabled) {
      r.setRenderTarget(null);
      r.render(scene, camera);
      return;
    }

    r.setRenderTarget(this.sceneTarget);
    r.clear();
    r.render(scene, camera);

    if (!this.bloomEnabled) {
      this.quad.material = this.compositeMat;
      const u0 = this.compositeMat.uniforms;
      u0.tDiffuse.value = this.sceneTarget.texture;
      u0.tBloomA.value = this.black;
      u0.tBloomB.value = this.black;
      this.quad.render(r, null);
      return;
    }

    // Bright pass into the half-res chain.
    this.quad.material = this.brightMat;
    this.brightMat.uniforms.tDiffuse.value = this.sceneTarget.texture;
    this.quad.render(r, this.bloomA[0]);

    this.blurChain(this.bloomA, Config.fx.bloomRadius);
    // Downsample the blurred half-res into the quarter-res chain for a wide,
    // soft second lobe. Reusing the blur shader with a zero step is a copy.
    this.quad.material = this.blurMat;
    this.blurMat.uniforms.tDiffuse.value = this.bloomA[0].texture;
    this.blurMat.uniforms.uDir.value.set(0, 0);
    this.quad.render(r, this.bloomB[0]);
    this.blurChain(this.bloomB, Config.fx.bloomRadius * 1.9);

    this.quad.material = this.compositeMat;
    const u = this.compositeMat.uniforms;
    u.tDiffuse.value = this.sceneTarget.texture;
    u.tBloomA.value = this.bloomA[0].texture;
    u.tBloomB.value = this.bloomB[0].texture;
    this.quad.render(r, null);
  }

  /** Two ping-pong passes: horizontal then vertical, leaving the result in [0]. */
  blurChain(pair, radius) {
    const r = this.renderer;
    const w = pair[0].width;
    const h = pair[0].height;
    this.quad.material = this.blurMat;

    this.blurMat.uniforms.tDiffuse.value = pair[0].texture;
    this.blurMat.uniforms.uDir.value.set(radius / w, 0);
    this.quad.render(r, pair[1]);

    this.blurMat.uniforms.tDiffuse.value = pair[1].texture;
    this.blurMat.uniforms.uDir.value.set(0, radius / h);
    this.quad.render(r, pair[0]);
  }

  dispose() {
    this.sceneTarget.dispose();
    for (const rt of [...this.bloomA, ...this.bloomB]) rt.dispose();
  }
}
