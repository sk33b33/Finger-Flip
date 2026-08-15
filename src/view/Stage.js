import {
  Scene,
  WebGLRenderer,
  PerspectiveCamera,
  DirectionalLight,
  HemisphereLight,
  AmbientLight,
  Mesh,
  SphereGeometry,
  ShaderMaterial,
  BackSide,
  PMREMGenerator,
  Color,
  Fog,
  ACESFilmicToneMapping,
  SRGBColorSpace,
  PCFSoftShadowMap,
  Vector3,
} from 'three';
import Config from '../core/Config.js';

/**
 * Renderer, scene, sky and lighting.
 *
 * The sky is a shader dome rather than a texture, which means the environment
 * map for every reflective surface on the board can be generated from it at
 * boot with no downloads. The sun direction, horizon colour and dome are all
 * driven from one place, so changing the time of day changes everything at once.
 */

const SKY_VERT = /* glsl */ `
  varying vec3 vDir;
  void main() {
    vDir = position;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
  }
`;

const SKY_FRAG = /* glsl */ `
  varying vec3 vDir;
  uniform vec3 uZenith;
  uniform vec3 uHorizon;
  uniform vec3 uGround;
  uniform vec3 uSunDir;
  uniform vec3 uSunColor;

  void main() {
    vec3 d = normalize(vDir);
    float h = d.y;

    // Sky gradient, with a tighter falloff near the horizon so it does not
    // wash out the buildings.
    float t = clamp(h * 1.15 + 0.06, 0.0, 1.0);
    vec3 col = mix(uHorizon, uZenith, pow(t, 0.72));
    col = mix(uGround, col, smoothstep(-0.06, 0.02, h));

    // Sun disc plus a broad glow.
    float sd = max(dot(d, normalize(uSunDir)), 0.0);
    col += uSunColor * pow(sd, 620.0) * 9.0;
    col += uSunColor * pow(sd, 12.0) * 0.30;
    col += uSunColor * pow(sd, 3.0) * 0.07;

    gl_FragColor = vec4(col, 1.0);
  }
`;

const UP = new Vector3(0, 1, 0);
const _v = new Vector3();
const _o = new Vector3();

export default class Stage {
  constructor(container) {
    this.container = container;

    this.renderer = new WebGLRenderer({
      antialias: false, // the composer does MSAA on its own target instead
      powerPreference: 'high-performance',
      stencil: false,
    });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio || 1, Config.fx.maxPixelRatio));
    this.renderer.outputColorSpace = SRGBColorSpace;
    this.renderer.toneMapping = ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.06;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = PCFSoftShadowMap;
    container.appendChild(this.renderer.domElement);

    this.scene = new Scene();
    this.camera = new PerspectiveCamera(Config.camera.fov, 1, 0.05, 900);

    this.sunDir = new Vector3(-0.42, 0.46, -0.78).normalize();
    this.buildSky();
    this.buildLights();

    this.scene.fog = new Fog(new Color(0x8f9fb4), 70, 420);

    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  buildSky() {
    this.skyMaterial = new ShaderMaterial({
      vertexShader: SKY_VERT,
      fragmentShader: SKY_FRAG,
      side: BackSide,
      depthWrite: false,
      fog: false,
      uniforms: {
        uZenith: { value: new Color(0x2c5f9e) },
        uHorizon: { value: new Color(0xf2c48c) },
        uGround: { value: new Color(0x4b4740) },
        uSunDir: { value: this.sunDir.clone() },
        uSunColor: { value: new Color(0xffd9a0) },
      },
    });
    this.sky = new Mesh(new SphereGeometry(500, 32, 20), this.skyMaterial);
    this.sky.frustumCulled = false;
    this.scene.add(this.sky);

    // Bake the dome into an environment map so the trucks and the lacquered
    // deck underside actually reflect the sky as the board rotates.
    const pmrem = new PMREMGenerator(this.renderer);
    pmrem.compileEquirectangularShader();
    const envScene = new Scene();
    const envSky = new Mesh(this.sky.geometry, this.skyMaterial);
    envScene.add(envSky);
    const rt = pmrem.fromScene(envScene, 0, 0.1, 1000);
    this.scene.environment = rt.texture;
    this.scene.environmentIntensity = 0.85;
    pmrem.dispose();
  }

  buildLights() {
    const sun = new DirectionalLight(0xfff0d6, 3.1);
    sun.position.copy(this.sunDir).multiplyScalar(40);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    // A tight frustum around the rider: this is what keeps the board's own
    // shadow crisp instead of a soft blob.
    const S = 11;
    sun.shadow.camera.left = -S;
    sun.shadow.camera.right = S;
    sun.shadow.camera.top = S;
    sun.shadow.camera.bottom = -S;
    sun.shadow.camera.near = 1;
    sun.shadow.camera.far = 90;
    sun.shadow.bias = -0.0006;
    sun.shadow.normalBias = 0.022;
    this.scene.add(sun);
    this.scene.add(sun.target);
    this.sun = sun;

    this.scene.add(new HemisphereLight(0xa8c8ff, 0x6d6659, 0.85));
    this.scene.add(new AmbientLight(0xffffff, 0.12));

    // A key light that rides with the camera and only comes up during the
    // trick. Without it the board is a silhouette in its own close-up: the sun
    // is fixed, so half the time the shot catches the shaded side. This is the
    // one deliberately cinematic light in the scene.
    this.trickKey = new DirectionalLight(0xfff4e2, 0);
    this.trickKey.castShadow = false;
    this.scene.add(this.trickKey);
    this.scene.add(this.trickKey.target);

    // And a cool rim from the opposite side to pick the deck's edge out of the
    // background at any roll angle.
    this.trickRim = new DirectionalLight(0x9fd0ff, 0);
    this.trickRim.castShadow = false;
    this.scene.add(this.trickRim);
    this.scene.add(this.trickRim.target);
  }

  /**
   * @param {number} amount 0..1, the trick camera blend
   * @param {Vector3} target what the trick lights should point at
   */
  setTrickLighting(amount, target) {
    this.trickKey.intensity = amount * 1.45;
    this.trickRim.intensity = amount * 1.35;
    if (amount < 0.01) return;

    this.trickKey.target.position.copy(target);
    this.trickRim.target.position.copy(target);

    // Key over the camera's shoulder, rim from behind and above the subject.
    _v.copy(this.camera.position).sub(target).normalize();
    _o.crossVectors(_v, UP).normalize();
    this.trickKey.position
      .copy(target)
      .addScaledVector(_v, 3)
      .addScaledVector(_o, 1.6)
      .addScaledVector(UP, 2.4);
    this.trickRim.position
      .copy(target)
      .addScaledVector(_v, -3.2)
      .addScaledVector(_o, -1.2)
      .addScaledVector(UP, 2.0);

    this.trickKey.target.updateMatrixWorld();
    this.trickRim.target.updateMatrixWorld();
  }

  /** Keep the shadow frustum on the rider so shadow resolution never sags. */
  focusShadows(target) {
    this.sun.target.position.copy(target);
    this.sun.position.copy(target).addScaledVector(this.sunDir, 40);
    this.sun.target.updateMatrixWorld();
  }

  /** The sky dome rides with the camera so it never clips. */
  syncSky() {
    this.sky.position.copy(this.camera.position);
  }

  /** Re-derive the drawing buffer and everything sized from it. */
  resize() {
    const w = this.container.clientWidth || window.innerWidth;
    const h = this.container.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.width = w;
    this.height = h;
    if (this.onResize) this.onResize(w, h);
  }
}
