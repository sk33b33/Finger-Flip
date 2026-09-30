/**
 * Proves the installed game actually installs, and actually runs offline.
 *
 * Every part of a PWA is easy to get almost right and impossible to eyeball: a
 * manifest with a relative scope that resolves one directory off, a precache
 * list that names a bundle the build has since renamed, a service worker whose
 * navigation fallback never fires because it only ever cached "/". None of it
 * shows up until somebody is on a train.
 *
 * So this serves the real dist/, in a real browser, and then pulls the network
 * out from under it.
 *
 *   npm run build && node tools/pwa.mjs
 */
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = 'dist';
const PORT = 5201;
const ORIGIN = `http://127.0.0.1:${PORT}`;

if (!fs.existsSync(path.join(ROOT, 'sw.js'))) {
  console.error(`No ${ROOT}/sw.js — run "npm run build" first.`);
  process.exit(1);
}

const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp',
  '.webmanifest': 'application/manifest+json', '.json': 'application/json',
};

let served = 0;
const server = http.createServer((req, res) => {
  const rel = decodeURIComponent(new URL(req.url, ORIGIN).pathname).replace(/^\/+/, '') || 'index.html';
  const file = path.join(ROOT, rel);
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404).end('not found');
    return;
  }
  served++;
  res.writeHead(200, {
    'content-type': TYPES[path.extname(file)] || 'application/octet-stream',
    // The worker is the one file that must never be answered from the HTTP
    // cache, or an update can sit undelivered for a day.
    'cache-control': rel === 'sw.js' ? 'no-cache' : 'public, max-age=3600',
  }).end(fs.readFileSync(file));
});
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const context = await browser.newContext({ viewport: { width: 420, height: 880 } });
const page = await context.newPage();

const problems = [];
const check = (ok, label, detail = '') => {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) problems.push(label);
};

page.on('pageerror', (e) => problems.push(`page error: ${e.message}`));

// ---------------------------------------------------------------- online ---

await page.goto(`${ORIGIN}/`, { waitUntil: 'load' });

const manifest = await page.evaluate(async () => {
  const link = document.querySelector('link[rel="manifest"]');
  if (!link) return { error: 'no <link rel=manifest>' };
  const res = await fetch(link.href);
  if (!res.ok) return { error: `manifest ${res.status}` };
  const json = await res.json();
  // Resolved against the manifest, which is what the browser does — a relative
  // scope that comes out wrong is the classic way to ship an uninstallable app.
  return {
    json,
    href: link.href,
    scope: new URL(json.scope, link.href).href,
    start: new URL(json.start_url, link.href).href,
    icons: json.icons.map((i) => new URL(i.src, link.href).href),
  };
});

check(!manifest.error, 'the manifest loads and parses', manifest.error || '');
if (!manifest.error) {
  check(manifest.scope === `${ORIGIN}/`, 'scope covers the page', manifest.scope);
  check(manifest.start === `${ORIGIN}/`, 'start_url is inside scope', manifest.start);
  check(/fullscreen|standalone/.test(manifest.json.display), 'display drops the browser chrome', manifest.json.display);
  check(
    manifest.json.icons.some((i) => i.purpose === 'maskable' && i.sizes === '512x512'),
    'there is a 512 maskable icon',
  );
  const icons = await page.evaluate(
    (urls) =>
      Promise.all(
        urls.map(
          (u) =>
            new Promise((done) => {
              const img = new Image();
              img.onload = () => done(`${u.split('/').pop()} ${img.naturalWidth}x${img.naturalHeight}`);
              img.onerror = () => done(`${u.split('/').pop()} FAILED`);
              img.src = u;
            }),
        ),
      ),
    manifest.icons,
  );
  check(!icons.some((i) => i.includes('FAILED')), 'every icon it names exists', icons.join(', '));
}

// The worker registers on load, so it may not have finished yet.
const sw = await page.evaluate(async () => {
  const reg = await navigator.serviceWorker.getRegistration();
  if (!reg) return { error: 'nothing registered' };
  await navigator.serviceWorker.ready;
  return { scope: reg.scope, controlled: !!navigator.serviceWorker.controller };
});
check(!sw.error, 'a service worker registered', sw.error || sw.scope);
check(sw.scope === `${ORIGIN}/`, 'its scope is the whole app', sw.scope);

// It claims on first activate, so the very first visit ends up controlled.
await page.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 10000 }).catch(() => {});
check(await page.evaluate(() => !!navigator.serviceWorker.controller), 'and it is controlling this page');

const cached = await page.evaluate(async () => {
  const names = await caches.keys();
  const out = {};
  for (const n of names) out[n] = (await (await caches.open(n)).keys()).map((r) => new URL(r.url).pathname);
  return out;
});
const entries = Object.values(cached).flat();
check(Object.keys(cached).length === 1, 'exactly one cache', Object.keys(cached).join(', '));
check(entries.includes('/index.html'), 'the page itself is precached');
check(entries.some((e) => /^\/assets\/.*\.js$/.test(e)), 'the hashed bundle is precached');
check(entries.some((e) => /^\/assets\/.*\.css$/.test(e)), 'the stylesheet is precached');
check(entries.includes('/manifest.webmanifest'), 'the manifest is precached');
check(entries.includes('/deck-art.webp'), 'the deck art is precached');

// The Spotify sign-in comes back to this page with the authorization code in
// the query string, and a navigation cache keyed on the request URL would
// write it to disk. It also turns every ?utm= into its own copy of the page.
await page.goto(`${ORIGIN}/?code=SECRET-CODE&state=s1`, { waitUntil: 'load' });
await page.waitForTimeout(400);
const keys = await page.evaluate(async () => {
  const out = [];
  for (const n of await caches.keys()) {
    for (const r of await (await caches.open(n)).keys()) out.push(r.url);
  }
  return out;
});
check(!keys.some((k) => k.includes('SECRET-CODE')), 'an auth code never reaches the cache');
check(!keys.some((k) => k.includes('?')), 'and no navigation is cached under its query string');
await page.goto(`${ORIGIN}/`, { waitUntil: 'load' });

// ---------------------------------------------------------------- offline ---

console.log('\n  pulling the network out...');
await context.setOffline(true);
server.close();
const before = served;

await page.goto(`${ORIGIN}/`, { waitUntil: 'load' });
check(served === before, 'nothing reached the server', `${served - before} request(s) got through`);

const booted = await page
  .waitForFunction(() => !!(window.FF && window.FF.game && window.FF.game.running), null, { timeout: 25000 })
  .then(() => true)
  .catch(() => false);
check(booted, 'the game boots with no network at all');

if (booted) {
  // Right through to a rolling skater, since the deck's textures are fetched
  // lazily and a missing one only shows up once the board is on screen.
  await page.click('.js-start');
  await page.waitForTimeout(500);
  await page.click('[data-action="play"]');
  await page.waitForTimeout(3000);
  const rolling = await page.evaluate(() => ({
    started: window.FF.game.started,
    speed: +window.FF.game.skater.speed.toFixed(2),
    // The deck is two materials on one mesh, and the graphic is the one
    // that is fetched rather than drawn, so it is the one that can 404.
    deck: window.FF.game.boardMesh.materials.graphic.map?.image?.width || 0,
  }));
  check(rolling.started && rolling.speed > 0, 'and it rolls', `${rolling.speed} m/s`);
  check(rolling.deck > 0, 'with the deck artwork on the board', `${rolling.deck}px texture`);
  await page.screenshot({ path: 'shots/pwa-offline.png' });
}

// A navigation to somewhere inside the app that was never visited must still
// come back with the page, or a deep link offline is a dinosaur.
const deep = await page.goto(`${ORIGIN}/?utm=offline`, { waitUntil: 'domcontentloaded' }).catch(() => null);
check(!!deep && deep.ok(), 'an unvisited URL inside the app still serves the page');

await browser.close();

console.log(problems.length ? `\n${problems.length} problem(s):\n  ${problems.join('\n  ')}` : '\nAll good.');
process.exit(problems.length ? 1 : 0);
