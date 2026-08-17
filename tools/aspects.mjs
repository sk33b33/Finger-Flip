/**
 * Screenshots the trick close-up at real device aspect ratios and measures how
 * many pixels the deck's ACROSS axis spans, because that distance is the flick
 * window. Too few pixels and the mechanic is unusable on a phone.
 *
 *   node tools/aspects.mjs
 */
import { chromium } from 'playwright';
import { createServer } from 'vite';
import fs from 'node:fs';

fs.mkdirSync('shots/aspect', { recursive: true });
const server = await createServer({ server: { port: 5192 }, logLevel: 'error' });
await server.listen();
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});

const SIZES = [
  { name: 'phone-portrait', width: 390, height: 844 },
  { name: 'phone-landscape', width: 844, height: 390 },
  { name: 'tablet', width: 1024, height: 768 },
  { name: 'desktop', width: 1440, height: 900 },
];

for (const size of SIZES) {
  const page = await browser.newPage({ viewport: { width: size.width, height: size.height } });
  await page.goto('http://localhost:5192/', { waitUntil: 'load' });
  await page.waitForTimeout(2600);
  await page.click('.js-start').catch(() => {});
  await page.waitForTimeout(400);
  await page.click('[data-action="play"]').catch(() => {});
  await page.waitForTimeout(700);
  await page.evaluate(() => window.FF.game.pop(1.0));

  // Wait for the close-up to arrive.
  for (let i = 0; i < 60; i++) {
    const b = await page.evaluate(() => window.FF.game.cameraRig.trickBlend);
    if (b > 0.99) break;
    await page.waitForTimeout(120);
  }
  await page.waitForTimeout(700); // let the position lerp settle too

  // Project the deck's two rails and measure the gap in device pixels: that is
  // the distance a finger must travel to flick off the edge.
  const m = await page.evaluate(() => {
    const g = window.FF.game;
    const THREE = g.boardMesh.position.constructor;
    const cam = g.stage.camera;
    const w = g.stage.width;
    const h = g.stage.height;
    const half = 0.205 / 2;
    const project = (x, z) => {
      const v = new THREE(x, 0, z).applyQuaternion(g.cameraRig.stanceQuat).add(g.board.position);
      v.project(cam);
      return { x: (v.x * 0.5 + 0.5) * w, y: (-v.y * 0.5 + 0.5) * h };
    };
    const heel = project(-half, 0.22);
    const toe = project(half, 0.22);
    const tail = project(0, -0.41);
    const nose = project(0, 0.41);
    return {
      acrossPx: Math.hypot(toe.x - heel.x, toe.y - heel.y),
      alongPx: Math.hypot(nose.x - tail.x, nose.y - tail.y),
      w, h,
    };
  });

  await page.screenshot({ path: `shots/aspect/${size.name}.png` });
  const minDim = Math.min(size.width, size.height);
  console.log(
    `${size.name.padEnd(16)} ${size.width}x${size.height}  deck across ${m.acrossPx.toFixed(0)}px ` +
      `(${((m.acrossPx / minDim) * 100).toFixed(1)}% of short edge), along ${m.alongPx.toFixed(0)}px`,
  );
  await page.close();
}

await browser.close();
await server.close();
