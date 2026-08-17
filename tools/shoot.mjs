/**
 * Plays a full kickflip in a real browser and screenshots each beat, so the
 * look and the flow can be checked without a human at the keyboard.
 *
 * SwiftShader renders at roughly 10fps here, so every step waits on game state
 * rather than on wall-clock time.
 *
 *   node tools/shoot.mjs [outDir]
 */
import { chromium } from 'playwright';
import { createServer } from 'vite';
import fs from 'node:fs';

const OUT = process.argv[2] || 'shots';
fs.mkdirSync(OUT, { recursive: true });

const server = await createServer({ server: { port: 5199 }, logLevel: 'error' });
await server.listen();

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });

const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push('PAGEERROR ' + e.message));

await page.goto('http://localhost:5199/', { waitUntil: 'load' });
await page.waitForTimeout(3500);

const shot = async (n) => {
  await page.waitForTimeout(220); // let a settled frame present
  await page.screenshot({ path: `${OUT}/${n}.png` });
  console.log('shot', n);
};
const state = () => page.evaluate(() => {
  const g = window.FF.game;
  return { state: g.state, blend: +g.cameraRig.trickBlend.toFixed(2), ts: +g.time.timeScale.toFixed(3),
    flightT: +g.flightT.toFixed(2), roll: +g.board.spin.z.toFixed(2), yaw: +g.board.spin.y.toFixed(2),
    pitch: +g.board.spin.x.toFixed(2), omega: +g.board.angularVelocity.length().toFixed(2),
    trick: g.lastTrick.name, score: g.score.total, pending: g.score.comboPending,
    meter: +g.meter.normalised.toFixed(2), contacts: g.fingers.fingers.map((f) => +f.contact.toFixed(2)) };
});
const waitFor = async (fn, ms = 20000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (fn(await state())) return true; await page.waitForTimeout(80); }
  console.log('  (timed out waiting)', JSON.stringify(await state()));
  return false;
};

await shot('01-start');
// Tap the title card to reach the hub, then Drop In — which is the only thing
// that starts the skater skating. Nothing simulates until it is pressed.
await page.click('.js-start');
await page.waitForTimeout(600);
await page.click('[data-action="play"]');
await page.waitForTimeout(1800);
await shot('02-rolling');

// Approach the second kicker and launch off it.
await page.evaluate(() => { const g = window.FF.game; g.skater.position.z = 56; g.skater.speed = 12; });
await page.waitForTimeout(900);
await shot('03-approach');
await waitFor((s) => s.state === 'AIR', 9000);
await waitFor((s) => s.blend > 0.95);
await shot('04-slowmo-closeup');

// Front finger off the toe rail.
await page.keyboard.down('ArrowRight');
await waitFor((s) => Math.abs(s.roll) > 0.30, 9000);
await page.keyboard.up('ArrowRight');
await shot('05-flick');

await waitFor((s) => Math.abs(s.roll) > 0.86, 20000);
console.log('BEFORE CATCH', JSON.stringify(await state()));
await shot('06-mid-flip');

// Plant both fingers to stop it flat.
await page.keyboard.down('KeyQ');
await page.keyboard.down('Slash');
// Let go as soon as the spin is off it. Holding two fingers flat on the deck
// through several real seconds of slow motion keeps levering it, which is a
// thing the physics is right to do and a thing no player would do.
await waitFor((s) => s.omega < 2.5, 12000);
await shot('07-catch');
await page.keyboard.up('KeyQ');
await page.keyboard.up('Slash');
console.log('CAUGHT', JSON.stringify(await state()));

// No commit button any more: the landing takes itself when the wheels touch.
await waitFor((s) => s.state !== 'AIR', 20000);
await page.waitForTimeout(300);
console.log('RESULT', JSON.stringify(await state()));
await shot('08-landed');

await page.waitForTimeout(2600);
await shot('09-rolling-away');

console.log('ERRORS', errors.length ? errors.slice(0, 8) : 'none');
await browser.close();
await server.close();
