/**
 * The installable game, in the parts that can be checked without a browser.
 *
 * A manifest is a file full of strings that nothing validates, referring to
 * files nothing checks are there, at sizes nothing checks are the sizes
 * claimed. Every one of those is silent until an install button quietly stops
 * appearing, so they are all asserted here.
 *
 * What needs a real browser — that the worker registers, precaches the hashed
 * bundle and serves the game with the network unplugged — is tools/pwa.mjs.
 *
 *   node --test test/pwa.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import Install, { isInstalled, isIOS } from '../src/core/Install.js';

const PUBLIC = 'public';
const manifest = JSON.parse(fs.readFileSync(path.join(PUBLIC, 'manifest.webmanifest'), 'utf8'));
const html = fs.readFileSync('index.html', 'utf8');

/** Width and height straight out of a PNG's IHDR, which is always first. */
function pngSize(file) {
  const b = fs.readFileSync(file);
  assert.equal(b.subarray(1, 4).toString('ascii'), 'PNG', `${file} is not a PNG`);
  assert.equal(b.subarray(12, 16).toString('ascii'), 'IHDR', `${file} has no IHDR`);
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
}

// ------------------------------------------------------------- manifest ----

test('the manifest is scoped so it works from a subdirectory too', () => {
  // vite.config.js builds with base './', because the game may well be served
  // from a project path rather than a domain root. An absolute '/' here would
  // claim the whole origin and stop matching the page it was served from.
  for (const key of ['id', 'start_url', 'scope']) {
    assert.equal(manifest[key], './', `${key} must be relative`);
  }
  for (const icon of manifest.icons) {
    assert.ok(!icon.src.startsWith('/'), `${icon.src} must be relative`);
  }
});

test('it asks for the screen, which is the point of installing', () => {
  // The trick camera fits the shot to the viewport, so the browser chrome is
  // costing deck width, not just height.
  assert.equal(manifest.display, 'fullscreen');
  assert.deepEqual(manifest.display_override, ['fullscreen', 'standalone']);
  // NOT locked: there is splash art composed for each orientation, and the
  // camera re-fits on rotate. Locking would throw half of that away.
  assert.equal(manifest.orientation, 'any');
  assert.ok(manifest.name && manifest.short_name);
  assert.ok(manifest.short_name.length <= 12, 'short_name gets truncated under an icon');
});

test('every icon it names is there, at the size it claims', () => {
  for (const icon of manifest.icons) {
    const file = path.join(PUBLIC, icon.src);
    assert.ok(fs.existsSync(file), `${icon.src} is missing`);
    const { w, h } = pngSize(file);
    assert.equal(`${w}x${h}`, icon.sizes, `${icon.src} is ${w}x${h}`);
    assert.equal(icon.type, 'image/png');
  }
});

test('there is a maskable icon as well as a plain one', () => {
  // Without a maskable one Android crops the plain icon to a circle and takes
  // the corners of the artwork with it; without a plain one, everywhere that
  // does NOT crop shows the safe-zone padding as a fat margin.
  const at = (purpose, size) =>
    manifest.icons.some((i) => i.purpose === purpose && i.sizes === size);
  for (const size of ['192x192', '512x512']) {
    assert.ok(at('any', size), `no ${size} any icon`);
    assert.ok(at('maskable', size), `no ${size} maskable icon`);
  }
});

test('the page links the manifest, and agrees with it on the colour', () => {
  assert.match(html, /<link rel="manifest" href="\/manifest\.webmanifest"/);
  // iOS reads none of the manifest and needs its own tags.
  assert.match(html, /<link rel="apple-touch-icon" href="\/icons\/apple-touch-icon\.png"/);
  assert.match(html, /name="apple-mobile-web-app-capable" content="yes"/);
  assert.ok(fs.existsSync(path.join(PUBLIC, 'icons/apple-touch-icon.png')));

  const theme = html.match(/name="theme-color" content="(#[0-9a-f]{6})"/i);
  assert.ok(theme, 'no theme-color meta');
  // They style different things — the browser chrome and the splash behind the
  // first paint — and a mismatch is a visible seam on launch.
  assert.equal(manifest.theme_color, theme[1]);
  assert.equal(manifest.background_color, theme[1]);
});

test('everything the worker is told to precache actually exists', () => {
  // The precache list is half discovered from the bundle and half named by
  // hand in vite.config.js. The named half is the half that rots: rename a
  // file in public/ and offline play loses it with no error anywhere.
  const config = fs.readFileSync('vite.config.js', 'utf8');
  const block = config.match(/serviceWorker\(\{\s*extra: \[([\s\S]*?)\],\s*\}\)/);
  assert.ok(block, 'no extra[] list in vite.config.js');
  const names = [...block[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  assert.ok(names.length >= 6, `only found ${names.length} entries`);
  for (const name of names) {
    assert.ok(fs.existsSync(path.join(PUBLIC, name)), `${name} is precached but not in ${PUBLIC}/`);
  }
  assert.ok(names.includes('manifest.webmanifest'), 'an offline launch still reads the manifest');
});

test('the worker source still has both placeholders for the build to fill', () => {
  const sw = fs.readFileSync('src/pwa/sw.js', 'utf8');
  assert.match(sw, /__FF_VERSION__/);
  assert.match(sw, /__FF_PRECACHE__/);
  // skipWaiting would let a new worker start answering a running game from a
  // cache the loaded page knows nothing about. It must stay out.
  assert.ok(!/skipWaiting\(\)/.test(sw.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, '')));
});

// -------------------------------------------------------------- install ----

function fakeWin({ ua = 'Mozilla/5.0 (Linux; Android 13)', touch = 0, standalone, matches = false } = {}) {
  const handlers = {};
  const mq = { matches, addEventListener: (_, fn) => (mq._fn = fn) };
  return {
    navigator: { userAgent: ua, maxTouchPoints: touch, ...(standalone === undefined ? {} : { standalone }) },
    matchMedia: () => mq,
    addEventListener: (name, fn) => (handlers[name] = fn),
    fire: (name, e) => handlers[name]?.(e),
    mq,
  };
}

test('an installed launch is recognised on both kinds of browser', () => {
  assert.equal(isInstalled(fakeWin({ matches: true })), true, 'display-mode');
  assert.equal(isInstalled(fakeWin({ standalone: true })), true, 'iOS navigator.standalone');
  assert.equal(isInstalled(fakeWin()), false);
  // Node, a stubbed window, anything without matchMedia: not installed, and
  // above all not a crash on the path that builds the menu.
  assert.equal(isInstalled({}), false);
  assert.equal(isInstalled(null), false);
});

test('iPadOS is caught, and a desktop Mac is not', () => {
  // An iPad claims to be a Macintosh. The touchscreen is the only tell, and
  // getting it wrong sends a desktop user hunting for a share sheet.
  assert.equal(isIOS({ userAgent: 'iPhone', maxTouchPoints: 5 }), true);
  assert.equal(isIOS({ userAgent: 'Mozilla/5.0 (Macintosh)', maxTouchPoints: 5 }), true);
  assert.equal(isIOS({ userAgent: 'Mozilla/5.0 (Macintosh)', maxTouchPoints: 0 }), false);
  assert.equal(isIOS({ userAgent: 'Mozilla/5.0 (Linux; Android 13)', maxTouchPoints: 5 }), false);
});

test('the menu is told which of the three things to say', () => {
  const win = fakeWin();
  const install = new Install(win);
  // Before the browser has decided the game is installable there is no row at
  // all, which is the only honest state: a button that might not work is worse
  // than no button.
  assert.deepEqual(install.snapshot(), { installed: false, promptable: false, manual: false });

  let changes = 0;
  install.onChange(() => changes++);

  let defaulted = false;
  win.fire('beforeinstallprompt', { preventDefault: () => (defaulted = true) });
  assert.ok(defaulted, 'the browser must not choose its own moment to ask');
  assert.equal(install.snapshot().promptable, true);
  assert.equal(changes, 1, 'an open menu has to be told to re-render');

  win.fire('appinstalled');
  assert.deepEqual(install.snapshot(), { installed: true, promptable: false, manual: false });
});

test('iOS gets told how to do it by hand, since it will never offer', () => {
  const install = new Install(fakeWin({ ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)' }));
  assert.deepEqual(install.snapshot(), { installed: false, promptable: false, manual: true });
});

test('the deferred prompt is spent once, however it is answered', async () => {
  const win = fakeWin();
  const install = new Install(win);
  let asked = 0;
  win.fire('beforeinstallprompt', {
    preventDefault() {},
    prompt: async () => asked++,
    userChoice: Promise.resolve({ outcome: 'dismissed' }),
  });

  assert.equal(await install.prompt(), 'dismissed');
  assert.equal(asked, 1);
  assert.equal(install.snapshot().promptable, false, 'a spent prompt must stop offering');
  // Calling it again is a dead button, not an exception.
  assert.equal(await install.prompt(), 'unavailable');
  assert.equal(asked, 1);
});

test('a browser that throws out of prompt() does not take the menu with it', async () => {
  const win = fakeWin();
  const install = new Install(win);
  win.fire('beforeinstallprompt', {
    preventDefault() {},
    prompt: async () => {
      throw new Error('not allowed');
    },
  });
  assert.equal(await install.prompt(), 'failed');
});
