/**
 * Converts Mixamo animation exports into something the game can ship.
 *
 * The clips arrive as FBX — 866KB for two of them, and FBXLoader is another
 * ~150KB of bundle to read a format the game has no other use for. Neither is
 * worth carrying: the clips are skeleton-only, so all that is actually wanted
 * is the keyframe tracks.
 *
 * So this reads them once, here, with a headless browser, and writes them out
 * as three's own AnimationClip JSON. At runtime the game calls
 * AnimationClip.parse on that and never knows FBX existed.
 *
 * ## Retargeting
 *
 * The clips and the model are separate Mixamo exports and they do NOT agree
 * on the skeleton's rest orientation. The model came out of Blender, which
 * works Z-up: its Armature carries a +90 degree X rotation and its Hips bone
 * carries -90 to cancel it. The animation FBX has identity on both. So a clip
 * key applied straight to the model is missing that 90 degrees, and the rider
 * skates lying on his side.
 *
 * Each key is therefore converted into the model's bone space:
 *
 *     q_model = q_modelBind * inverse(q_clipBind) * q_key
 *
 * For most bones the two binds agree to three decimal places and this is a
 * no-op. For the hips it is the whole difference between standing and lying
 * down. Done here rather than at runtime because it is the same arithmetic
 * every frame forever otherwise, and because a clip that has been retargeted
 * once is a clip anything can play.
 *
 * Position tracks are dropped. The clips carry one, on the hips, and it is in
 * the FBX's units rather than the GLB's bone units — a hundred times smaller,
 * so played against the model it puts the hips on the floor and folds the
 * rider into a heap. Rescaling it would be guesswork about two exports that
 * need not agree, and it is not wanted anyway: the game owns where the rider
 * stands, because the feet have to be on a board whose height it decides. The
 * clips supply joint rotations, which is the part no amount of code can
 * invent, and nothing else.
 *
 * Numbers are rounded on the way out. A quaternion track at 30fps is four
 * floats a frame, and printing each to seventeen significant figures triples
 * the file to describe rotations finer than a sixteenth of a degree.
 *
 *   node tools/anim.mjs <name>=<file.fbx> [<name>=<file.fbx> ...] [--out path]
 */
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { launchOptions } from './chrome.mjs';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const take = (flag, fallback) => {
  const i = args.indexOf(flag);
  if (i < 0) return fallback;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
};
const OUT = take('--out', 'public/rider-james.anim.json');
const MODEL = take('--model', 'public/rider-james.glb');
const inputs = args
  .map((a) => {
    const i = a.indexOf('=');
    return { name: a.slice(0, i), file: a.slice(i + 1) };
  })
  .filter((x) => x.name && x.file);

if (!fs.existsSync(MODEL)) {
  console.error(`no model at ${MODEL} to retarget onto (pass --model)`);
  process.exit(1);
}

if (!inputs.length) {
  console.error('usage: node tools/anim.mjs stance=a.fbx move=b.fbx [--out public/x.json]');
  process.exit(1);
}
for (const i of inputs) {
  if (!fs.existsSync(i.file)) {
    console.error(`no such file: ${i.file}`);
    process.exit(1);
  }
}

/** Decimal places kept per track type. Rotations need more than positions. */
const PLACES = { quaternion: 5, position: 4, scale: 4, time: 4 };

const serve = {
  name: 'serve-fbx',
  configureServer(s) {
    s.middlewares.use('/fbx', (req, res) => {
      const want = decodeURIComponent(req.url.split('?')[0]).replace(/^\//, '');
      const hit = inputs.find((i) => i.name === want);
      if (!hit) {
        res.writeHead(404).end();
        return;
      }
      res.setHeader('content-type', 'application/octet-stream');
      res.end(fs.readFileSync(hit.file));
    });
    s.middlewares.use('/retarget-model.glb', (_req, res) => {
      res.setHeader('content-type', 'model/gltf-binary');
      res.end(fs.readFileSync(MODEL));
    });
  },
};

const server = await createServer({
  server: { port: 5322, hmr: false },
  logLevel: 'error',
  plugins: [serve],
});
await server.listen();

const browser = await chromium.launch(launchOptions({ gpu: false }));
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
await page.goto('http://127.0.0.1:5322/', { waitUntil: 'domcontentloaded' });

const clips = await page.evaluate(
  async ({ names, PLACES }) => {
    const THREE = await import('/node_modules/three/build/three.module.js');
    const { FBXLoader } = await import('/node_modules/three/examples/jsm/loaders/FBXLoader.js');
    const { GLTFLoader } = await import('/node_modules/three/examples/jsm/loaders/GLTFLoader.js');

    // The bind rotations the clips must be converted ONTO.
    const model = await new GLTFLoader().loadAsync('/retarget-model.glb');
    const modelBind = new Map();
    model.scene.traverse((o) => {
      if (o.isBone) modelBind.set(o.name, o.quaternion.clone());
    });

    const out = {};
    for (const name of names) {
      const fbx = await new FBXLoader().loadAsync(`/fbx/${name}`);
      const clip = (fbx.animations || [])[0];
      if (!clip) throw new Error(`${name} has no animation`);

      const clipBind = new Map();
      fbx.traverse((o) => {
        if (o.isBone) clipBind.set(o.name, o.quaternion.clone());
      });

      const json = clip.toJSON(clip);
      json.name = name;
      const before = json.tracks.length;
      json.tracks = json.tracks.filter((t) => !t.name.endsWith('.position'));
      json.droppedPositionTracks = before - json.tracks.length;

      // q_model = q_modelBind * inverse(q_clipBind) * q_key, per key.
      json.retargeted = 0;
      const q = new THREE.Quaternion();
      const fix = new THREE.Quaternion();
      for (const t of json.tracks) {
        if (!t.name.endsWith('.quaternion')) continue;
        const bone = t.name.slice(0, -'.quaternion'.length);
        const mb = modelBind.get(bone);
        const cb = clipBind.get(bone);
        if (!mb || !cb) continue;
        fix.copy(cb).invert().premultiply(mb);
        // Only count it as work where it actually changes something.
        if (1 - Math.abs(fix.w) > 1e-4) json.retargeted++;
        for (let i = 0; i < t.values.length; i += 4) {
          q.set(t.values[i], t.values[i + 1], t.values[i + 2], t.values[i + 3]);
          q.premultiply(fix);
          t.values[i] = q.x;
          t.values[i + 1] = q.y;
          t.values[i + 2] = q.z;
          t.values[i + 3] = q.w;
        }
      }

      for (const t of json.tracks) {
        const kind = t.name.split('.').pop();
        const p = PLACES[kind] ?? 4;
        const f = 10 ** p;
        t.values = Array.from(t.values, (v) => Math.round(v * f) / f);
        const tf = 10 ** PLACES.time;
        t.times = Array.from(t.times, (v) => Math.round(v * tf) / tf);
      }
      out[name] = json;
    }
    return out;
  },
  { names: inputs.map((i) => i.name), PLACES },
);

await browser.close();
await server.close();

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(clips));

const sourceBytes = inputs.reduce((a, i) => a + fs.statSync(i.file).size, 0);
for (const [name, clip] of Object.entries(clips)) {
  const keys = clip.tracks.reduce((a, t) => a + t.times.length, 0);
  console.log(
    `  ${name.padEnd(10)} ${clip.duration.toFixed(2)}s  ${String(clip.tracks.length).padStart(3)} rotation tracks  ` +
      `${keys} keys  (${clip.droppedPositionTracks} position dropped, ` +
      `${clip.retargeted} bone(s) actually retargeted)`,
  );
}
const bytes = fs.statSync(OUT).size;
console.log(
  `\n${(sourceBytes / 1024).toFixed(0)}KB of FBX -> ${OUT} ${(bytes / 1024).toFixed(0)}KB` +
    ` (${(100 - (bytes / sourceBytes) * 100).toFixed(0)}% smaller, and no FBXLoader in the bundle)`,
);
