/**
 * Lays the rigged rider out in the poses the game actually puts it in, on a
 * board, so the stance can be judged rather than guessed at.
 *
 * The rig arrives in a T-pose with no animations, so every pose in the game is
 * something view/GlbRider.js computes. The only way to know whether the feet
 * are on the deck, the knees bend the right way and the body is turned across
 * the board rather than down it, is to look.
 *
 *   node tools/rider-preview.mjs [outDir]
 */
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { launchOptions } from './chrome.mjs';
import fs from 'node:fs';

const OUT = process.argv[2] || 'shots';
fs.mkdirSync(OUT, { recursive: true });

const ENTRY = '_rider-preview-entry.js';
const PAGE = '_rider-preview.html';

fs.writeFileSync(
  ENTRY,
  `
import * as THREE from 'three';
import GlbRider from '/src/view/GlbRider.js';
import BoardMesh from '/src/view/BoardMesh.js';

const W = 520, H = 620;
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(W, H);
renderer.outputColorSpace = THREE.SRGBColorSpace;
document.body.style.margin = '0';
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x12151d);
scene.add(new THREE.HemisphereLight(0xcfe3ff, 0x2a2118, 2.0));
const key = new THREE.DirectionalLight(0xfff2e0, 2.4);
key.position.set(2.5, 5, 2);
scene.add(key);

// A floor line at y=0, so "are the feet on the board" is answerable.
const grid = new THREE.GridHelper(4, 16, 0x3a4356, 0x222835);
scene.add(grid);

const board = new BoardMesh();
scene.add(board);

const rider = new GlbRider('/rider-james.glb', { id: 'james' });
scene.add(rider);

window.__preview = (async () => {
  await rider.ready;
  if (!rider.loaded) throw new Error('rider did not load');

  const cam = new THREE.PerspectiveCamera(30, W / H, 0.1, 100);
  const shots = [];
  const look = new THREE.Vector3(0, 0.95, 0);

  const poses = [
    ['rest',    () => rider.setPose(0, 0, 0)],
    ['crouch',  () => rider.setPose(1, 0, 0)],
    ['air',     () => rider.setPose(0.2, 0, 1)],
    ['lean',    () => rider.setPose(0.4, 1, 0)],
    ['bail',    () => rider.setBailPose(0.5)],
    ['push',    () => { rider.setPose(0.15, 0, 0); if (rider.clips.move) rider.playBase('move'); }],
  ];

  const probes = {};
  const diag = {
    clips: Object.keys(rider.clips || {}),
    hasMixer: !!rider.mixer,
    limb: rider.limb,
    bindAngles: rider.bindAngles,
    bindHipPos: rider.bindHipPos && rider.bindHipPos.toArray().map((v) => +v.toFixed(2)),
  };
  for (const [name, apply] of poses) {
    apply();
    rider.update(0.016);
    rider.updateMatrixWorld(true);

    // Where did the feet actually end up? This is the thing that matters.
    const feet = rider.bones.legs.map((l) => +l.foot.getWorldPosition(new THREE.Vector3()).y.toFixed(3));
    const toes = rider.toeBones.map((t) => +(t.getWorldPosition(new THREE.Vector3()).y - rider.soleDrop).toFixed(3));
    const leg = rider.bones.legs[0];
    probes[name] = {
      hipRotX: +leg.up.rotation.x.toFixed(3),
      kneeRotX: +leg.low.rotation.x.toFixed(3),
      poseSeen: JSON.stringify(rider.pose),
      feet, toes, 
                     hipWorldY: +rider.bones.hips.getWorldPosition(new THREE.Vector3()).y.toFixed(3) };

    for (const [view, angle] of [['front', 0.55], ['side', Math.PI / 2]]) {
      cam.position.set(Math.sin(angle) * 3.1, 1.45, Math.cos(angle) * 3.1);
      cam.lookAt(look);
      renderer.render(scene, cam);
      shots.push({ name: name + '-' + view, png: renderer.domElement.toDataURL('image/png') });
    }
  }
  return { shots, probes, diag };
})();
`,
);
fs.writeFileSync(PAGE, `<!doctype html><meta charset=utf-8><body><script type="module" src="/${ENTRY}"></script>\n`);

const server = await createServer({ server: { port: 5310, hmr: false }, logLevel: 'error' });
await server.listen();
const browser = await chromium.launch(launchOptions());
const page = await browser.newPage({ viewport: { width: 520, height: 620 } });
page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
page.on('console', (m) => m.type() === 'error' && console.log('CONSOLE', m.text()));

try {
  await page.goto(`http://127.0.0.1:5310/${PAGE}`, { waitUntil: 'load' });
  await page.waitForFunction(() => !!window.__preview, null, { timeout: 60000 });
  const { shots, probes, diag } = await page.evaluate(() => window.__preview);
  console.log('measured off the rig:', JSON.stringify(diag));


  console.log('SOLE height above the deck (want ~0 on the ground, >0 in the air):');
  for (const [name, p] of Object.entries(probes)) {
    const stand = (p.hipWorldY - Math.min(...p.toes)).toFixed(3);
    console.log(`  ${name.padEnd(8)} sole ${String(p.toes[0]).padEnd(8)} ${String(p.toes[1]).padEnd(8)} hip-above-feet ${stand}`);
  }
  for (const s of shots) {
    fs.writeFileSync(`${OUT}/rider-${s.name}.png`, Buffer.from(s.png.split(',')[1], 'base64'));
  }
  console.log(`\nwrote ${shots.length} views to ${OUT}/`);
} finally {
  await browser.close();
  await server.close();
  fs.rmSync(ENTRY, { force: true });
  fs.rmSync(PAGE, { force: true });
}
