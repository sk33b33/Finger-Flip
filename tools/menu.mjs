/**
 * Screenshots every tab of the menu at four device shapes, and drives the two
 * things it can actually break: picking a map and picking a character.
 *
 * The suite cannot see a layout, and the menu is almost entirely layout.
 *
 *   node tools/menu.mjs [outDir]
 */
import { chromium } from 'playwright';
import { createServer } from 'vite';
import fs from 'node:fs';

const OUT = process.argv[2] || 'shots/menu';
fs.mkdirSync(OUT, { recursive: true });

const SHAPES = [
  ['phone', 390, 844],
  ['landscape', 844, 390],
  ['tablet', 820, 1180],
  ['desktop', 1440, 900],
];
const TABS = ['home', 'maps', 'events', 'profile', 'stats', 'settings'];

const server = await createServer({ server: { port: 5194 }, logLevel: 'error' });
await server.listen();

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});

const errors = [];

for (const [shape, width, height] of SHAPES) {
  const page = await browser.newPage({ viewport: { width, height } });
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`${shape}: ${m.text()}`);
  });
  page.on('pageerror', (e) => errors.push(`${shape}: PAGEERROR ${e.message}`));

  await page.goto('http://localhost:5194/', { waitUntil: 'load' });
  await page.waitForTimeout(3200);

  // Seed some history so the stats and events screens are not all zeroes —
  // an empty screen is the one state that always looks fine.
  await page.evaluate(() => {
    const g = window.FF.game;
    g.profile.recordTrick(
      { trick: 'Kickflip', grab: null, grabHold: 0, quality: 'PERFECT', points: 1840, comboAt: 1.6, lateCatch: true, airTime: 1.2 },
      'funrun',
    );
    g.profile.recordTrick(
      { trick: '360 Flip', grab: 'Indy', grabHold: 1.1, quality: 'CLEAN', points: 3120, comboAt: 2.1, lateCatch: false, airTime: 1.5 },
      'vert',
    );
    g.profile.recordTrick({ trick: 'Heelflip', quality: 'BAIL', points: 0, comboAt: 1 }, 'slope');
    g.profile.recordRun({ banked: 7480, mapId: 'funrun', airTime: 12.4 });
    g.profile.recordRun({ banked: 3100, mapId: 'vert', airTime: 6.1 });
    g.profile.advanceEvent(g.today[0].id, g.today[0].goal, g.today[0].goal);
    g.profile.advanceEvent(g.today[1].id, 1, g.today[1].goal);
  });

  await page.click('.js-start');
  await page.waitForTimeout(700);

  for (const tab of TABS) {
    await page.click(`.js-tab[data-tab="${tab}"]`);
    await page.waitForTimeout(320);
    await page.screenshot({ path: `${OUT}/${shape}-${tab}.png` });
  }

  // Does the menu actually change the game? Pick the map and rider that are not
  // currently selected and check the game moved.
  const changed = await page.evaluate(async () => {
    const g = window.FF.game;
    document.querySelector('.js-tab[data-tab="maps"]').click();
    document.querySelector('[data-action="map"][data-value="slope"]').click();
    await new Promise((r) => setTimeout(r, 250));
    const map = g.map.id;

    document.querySelector('.js-tab[data-tab="profile"]').click();
    document.querySelector('[data-action="character"][data-value="hollow"]').click();
    await new Promise((r) => setTimeout(r, 250));
    const character = g.character.id;

    document.querySelector('.js-tab[data-tab="home"]').click();
    document.querySelector('[data-action="play"]').click();
    await new Promise((r) => setTimeout(r, 400));

    return {
      map,
      character,
      closed: document.querySelector('.shell').classList.contains('is-hidden'),
      started: g.started,
      // And it must survive a reload, which is the whole point of the profile.
      saved: JSON.parse(localStorage.getItem('fingerflip.profile.v1')),
    };
  });

  await page.waitForTimeout(500);
  await page.screenshot({ path: `${OUT}/${shape}-playing.png` });

  console.log(
    `${shape.padEnd(10)} ${String(width).padStart(4)}x${height}  ` +
      `map=${changed.map} rider=${changed.character} closed=${changed.closed} ` +
      `playing=${changed.started} saved=${changed.saved.mapId}/${changed.saved.characterId}`,
  );

  await page.close();
}

console.log('ERRORS', errors.length ? errors.slice(0, 8) : 'none');
await browser.close();
await server.close();
