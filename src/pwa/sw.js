/**
 * The service worker. Not a module — this file is read from disk at build time
 * by the `ff-service-worker` plugin in vite.config.js, which substitutes the
 * two placeholders below and emits it at the root of dist/ as `sw.js`.
 *
 * It is never registered in dev. A service worker in front of Vite's module
 * graph serves yesterday's code back at you, and the half hour you spend
 * working out why is not worth what it saves.
 *
 * What it is here for, in one line: the game is FITTED to the viewport — the
 * trick camera measures the flick window in screen pixels — so an installed
 * game that has reclaimed the browser's address bar is not tidier, it is a
 * bigger deck to flick. Offline is the second prize.
 *
 * Three rules, and nothing else:
 *
 *   navigations     network first, falling back to the cached page. The HTML is
 *                   ~2KB and names the hashed bundle, so it is the one file
 *                   that must not go stale or the game never updates.
 *   same-origin GET cache first. The bundle's filenames carry a hash of their
 *                   contents, so a hit is by definition the right answer and
 *                   there is nothing to revalidate. Art in public/ is not
 *                   hashed, but it only changes when the version does.
 *   anything else   not ours. Spotify's SDK and its API go straight past.
 */

const VERSION = '__FF_VERSION__';
const CACHE = `finger-flip-${VERSION}`;

/** Everything needed to start the game with no network at all. */
const PRECACHE = __FF_PRECACHE__;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) =>
      // Not addAll: that rejects the whole install if any one entry 404s, and
      // an install that fails leaves the player with no offline game at all
      // over one missing icon. Take what is there.
      Promise.all(
        PRECACHE.map((url) =>
          cache.add(new Request(url, { cache: 'reload' })).catch(() => {}),
        ),
      ),
    ),
  );
  // Deliberately NO skipWaiting. A new worker taking over mid-session would
  // start answering from a cache the running page knows nothing about, and the
  // one moment it is most likely to happen is while somebody is in the air.
  // The update lands on the next cold start, which for a game is soon enough.
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.filter((k) => k.startsWith('finger-flip-') && k !== CACHE).map((k) => caches.delete(k)),
        ),
      )
      // Only reached on a first install, since an update cannot activate until
      // the last controlled page has gone. There it matters: without it the
      // very first visit finishes uncontrolled and caches nothing.
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  let url;
  try {
    url = new URL(req.url);
  } catch {
    return;
  }
  if (url.origin !== self.location.origin) return;

  if (req.mode === 'navigate') {
    // Always stored and fetched back under the one key, never under the URL
    // that was asked for. Two reasons, and the second is the important one:
    // every distinct query string would otherwise become its own cache entry,
    // and the Spotify sign-in comes back to this page with the authorization
    // code IN the query string. There is no version of writing that to disk
    // that is better than not writing it.
    const shell = new URL('./index.html', self.registration.scope).href;
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res && res.ok && res.type === 'basic') {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(shell, copy));
          }
          return res;
        })
        .catch(() => caches.match(shell).then((hit) => hit || Response.error())),
    );
    return;
  }

  event.respondWith(
    caches.match(req).then((hit) => {
      if (hit) return hit;
      return fetch(req).then((res) => {
        // Opaque responses have a status of 0 and an unknown size; storing them
        // is how a cache quietly fills up with failures.
        if (res && res.ok && res.type === 'basic') {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      });
    }),
  );
});
