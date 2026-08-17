/**
 * Screenshots every character from the chase camera, which is where they are
 * actually seen. A roster that reads well in a turntable and not from behind at
 * three metres is a roster nobody can tell apart while playing.
 *
 *   node tools/roster.mjs [outDir]
 */
import { chromium } from 'playwright';
import { createServer } from 'vite';
import fs from 'node:fs';

const OUT = process.argv[2] || 'shots/roster';
fs.mkdirSync(OUT, { recursive: true });

const server = await createServer({ server: { port: 5195 }, logLevel: 'error' });
await server.listen();

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 640, height: 720 } });

const errors = [];
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});
page.on('pageerror', (e) => errors.push('PAGEERROR ' + e.message));

await page.goto('http://localhost:5195/', { waitUntil: 'load' });
await page.waitForTimeout(3500);
// Tap the title card to reach the hub, then Drop In — which is the only thing
// that starts the skater skating. Nothing simulates until it is pressed.
await page.click('.js-start');
await page.waitForTimeout(600);
await page.click('[data-action="play"]');
await page.waitForTimeout(1200);

const roster = await page.evaluate(async () => {
  const { listCharacters } = await import('/src/view/Characters.js');
  return listCharacters();
});

for (const c of roster) {
  await page.evaluate((id) => {
    const g = window.FF.game;
    g.setCharacter(id);
    // Flat ground well clear of any lip, so nobody is caught mid-launch.
    g.skater.position.z = 6;
    g.skater.speed = 6;
    g.snapBoardToSkater();
  }, c.id);
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${OUT}/${c.id}.png` });
  console.log(`${c.id.padEnd(8)} ${c.name}`);
}

console.log('ERRORS', errors.length ? errors.slice(0, 8) : 'none');
await browser.close();
await server.close();
