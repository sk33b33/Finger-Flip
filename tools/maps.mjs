/**
 * Rides each park and screenshots it, so a layout can be judged on how it looks
 * and rides rather than only on whether the tests pass.
 *
 * The suite already proves every lip is reachable and nothing is too tall to
 * climb. What it cannot tell you is whether a park is worth skating — so this
 * drops the rider in at several points down each lap and takes a picture.
 *
 *   node tools/maps.mjs [outDir]
 */
import { chromium } from 'playwright';
import { createServer } from 'vite';
import fs from 'node:fs';

const OUT = process.argv[2] || 'shots/maps';
fs.mkdirSync(OUT, { recursive: true });

const server = await createServer({ server: { port: 5196 }, logLevel: 'error' });
await server.listen();

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });

const errors = [];
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});
page.on('pageerror', (e) => errors.push('PAGEERROR ' + e.message));

await page.goto('http://localhost:5196/', { waitUntil: 'load' });
await page.waitForTimeout(3500);
// Tap the title card to reach the hub, then Drop In — which is the only thing
// that starts the skater skating. Nothing simulates until it is pressed.
await page.click('.js-start');
await page.waitForTimeout(600);
await page.click('[data-action="play"]');
await page.waitForTimeout(1200);

const maps = await page.evaluate(() => window.FF.game.constructor && null);
const layouts = await page.evaluate(async () => {
  const { listLayouts } = await import('/src/sim/Park.js');
  return listLayouts();
});

for (const layout of layouts) {
  await page.evaluate((id) => window.FF.game.setMap(id), layout.id);
  await page.waitForTimeout(700);

  // Stand the rider back from each launch lip and shoot the approach. Dropping
  // them on top of a feature only ever catches them mid-flight with the trick
  // camera in their face, which says nothing about the park.
  const stations = await page.evaluate(async (run) => {
    const { isLip } = await import('/src/sim/Park.js');
    const lips = [];
    for (let z = 0; z < run; z += 0.25) {
      if (isLip(0, z, 0.5) && !isLip(0, z + 0.25, 0.5)) lips.push(z);
    }
    return lips.slice(0, 4).map((z) => Math.max(1, Math.round(z - 17)));
  }, layout.runLength);

  const report = [];

  for (const z of stations) {
    await page.evaluate((z) => {
      const g = window.FF.game;
      g.skater.position.z = z;
      g.skater.speed = 9.5;
      g.snapBoardToSkater();
    }, z);
    // Short enough that the rider is still short of the lip when the shutter
    // opens, long enough for the camera to settle behind them.
    await page.waitForTimeout(420);
    await page.screenshot({ path: `${OUT}/${layout.id}-z${z}.png` });
    report.push(
      await page.evaluate(() => {
        const g = window.FF.game;
        return `z${Math.round(g.skater.position.z)} ${Math.round(g.skater.speed * 3.6)}km/h y${g.skater.position.y.toFixed(1)}`;
      }),
    );
  }

  console.log(`${layout.id.padEnd(7)} ${String(layout.runLength).padStart(3)}m  ${report.join('  ')}`);
}

console.log('ERRORS', errors.length ? errors.slice(0, 8) : 'none');
await browser.close();
await server.close();
