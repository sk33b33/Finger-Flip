import { defineConfig } from 'vite';
import { createHash } from 'node:crypto';
import fs from 'node:fs';

/**
 * Builds src/pwa/sw.js into dist/sw.js with the precache list filled in.
 *
 * The list cannot be written by hand, because the things most worth precaching
 * are the ones whose names the build invents — index.html names a bundle called
 * something like `index-B3kQ9x1a.js`, and a service worker that does not know
 * that name can only cache it after somebody has already loaded it once online.
 * That is exactly one visit too late for "add to home screen, get on the tube".
 *
 * The version is a hash of the list. Every content-hashed filename in it moves
 * when its contents move, so any real change to the game produces a new cache
 * name and the old one is dropped on activate.
 */
function serviceWorker({ source = 'src/pwa/sw.js', extra = [] } = {}) {
  return {
    name: 'ff-service-worker',
    apply: 'build',
    generateBundle(_options, bundle) {
      const built = Object.keys(bundle).filter((f) => !f.endsWith('.map'));
      // Files in public/ are copied straight through and never appear in the
      // bundle, and index.html is emitted after this hook runs, so the handful
      // that are load-bearing are named rather than discovered.
      const precache = [...new Set(['index.html', ...built, ...extra])]
        .sort()
        .map((f) => `./${f}`);

      const version = createHash('sha256').update(precache.join('\n')).digest('hex').slice(0, 12);

      const code = fs
        .readFileSync(source, 'utf8')
        .replace('__FF_VERSION__', version)
        .replace('__FF_PRECACHE__', JSON.stringify(precache, null, 2));

      this.emitFile({ type: 'asset', fileName: 'sw.js', source: code });
    },
  };
}

export default defineConfig({
  base: './',
  server: { host: true, port: 5173 },
  build: { target: 'es2020', outDir: 'dist', assetsInlineLimit: 0 },
  plugins: [
    serviceWorker({
      extra: [
        'manifest.webmanifest',
        'icons/icon-192.png',
        'icons/icon-512.png',
        'icons/icon-maskable-192.png',
        'icons/icon-maskable-512.png',
        'icons/apple-touch-icon.png',
        // The deck art is the board you are flipping: without it the game runs
        // but the thing in the middle of the screen is untextured.
        'deck-grip.webp',
        'deck-art.webp',
        // Not the splash art. It is 240KB an orientation, it is on screen for
        // as long as it takes to tap it, and the page has a solid colour under
        // it. Whichever one the player's phone actually asks for gets picked up
        // by the runtime cache on the first visit anyway.
      ],
    }),
  ],
});
