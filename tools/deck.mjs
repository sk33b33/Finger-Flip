/**
 * A turntable of the board on its own, so the deck art and the hardware can be
 * checked without hunting for the right frame of a real trick.
 *
 * Renders BoardMesh into a scene of its own rather than posing the one in the
 * game: the game's own presentation pass rewrites the board's transform and the
 * camera every frame, so anything set by hand is gone before the shutter opens.
 *
 *   node tools/deck.mjs [outDir]
 */
import { chromium } from 'playwright';
import { createServer } from 'vite';
import fs from 'node:fs';

const OUT = process.argv[2] || 'shots/deck';
fs.mkdirSync(OUT, { recursive: true });

const server = await createServer({ server: { port: 5187 }, logLevel: 'error' });
await server.listen();
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 900, height: 900 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push('PAGEERROR ' + e.message));

await page.goto('http://localhost:5187/', { waitUntil: 'load' });
await page.waitForTimeout(2500);

const views = await page.evaluate(async () => {
  const THREE = await import('/node_modules/three/build/three.module.js');
  const { default: BoardMesh } = await import('/src/view/BoardMesh.js');

  const board = new BoardMesh();
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x1b1e25);
  scene.add(board);
  scene.add(new THREE.HemisphereLight(0xdfe8ff, 0x40381f, 1.5));
  const key = new THREE.DirectionalLight(0xfff4e2, 2.6);
  key.position.set(2, 5, 3);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0x9fd0ff, 1.4);
  rim.position.set(-3, 2, -3);
  scene.add(rim);
  // A fill from underneath, or the graphic face renders as a black slab.
  const under = new THREE.DirectionalLight(0xffffff, 2.2);
  under.position.set(1, -4, 1.5);
  scene.add(under);

  const canvas = document.createElement('canvas');
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
  renderer.setSize(900, 900, false);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  const cam = new THREE.PerspectiveCamera(34, 1, 0.05, 50);

  // Give the textures a moment to arrive; they load asynchronously.
  await new Promise((r) => setTimeout(r, 1500));

  const shots = {};
  // The board never moves; the camera does. Rolling the deck AND moving the
  // camera under it just cancels out and shows the grip from below.
  const takes = [
    ['top-grip', [0, 1.5, 0.001], [0, 0, 1]],
    ['bottom-graphic', [0, -1.5, 0.001], [0, 0, 1]],
    ['three-quarter', [0.8, -0.85, 0.95], [0, 1, 0]],
    ['side', [1.35, 0.28, 0.4], [0, 1, 0]],
  ];
  for (const [name, eye, up] of takes) {
    cam.position.set(...eye);
    cam.up.set(...up);
    cam.lookAt(0, 0, 0);
    renderer.render(scene, cam);
    shots[name] = canvas.toDataURL('image/png');
  }
  return shots;
});

for (const [name, uri] of Object.entries(views)) {
  fs.writeFileSync(`${OUT}/${name}.png`, Buffer.from(uri.split(',')[1], 'base64'));
  console.log('shot', name);
}
console.log('ERRORS', errors.length ? errors.slice(0, 6) : 'none');
await browser.close();
await server.close();
