/**
 * Spotify: the parts that can be proved without an account.
 *
 * The auth handshake, the redirect parsing and the session bookkeeping are all
 * pure or storage-injected, so they run in Node. What cannot be tested here is
 * anything behind a real sign-in — that needs a Premium account and a
 * registered app, and is checked by hand.
 *
 *   node --test test/spotify.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import SpotifyMusic, {
  makeVerifier,
  makeChallenge,
  parseRedirect,
  isExpired,
  redirectUriFor,
  SCOPES,
  Status,
} from '../src/audio/Spotify.js';

function fakeStore(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    raw: map,
  };
}

// ---------------------------------------------------------------- PKCE ----

test('the PKCE challenge matches the RFC 7636 test vector', async () => {
  // Appendix B of the spec. If this passes, the S256 transform, the base64url
  // alphabet and the padding strip are all right — and getting any one of them
  // wrong fails at Spotify with an error that says only "invalid_grant".
  const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
  assert.equal(await makeChallenge(verifier), 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
});

test('the verifier is long enough and uses only unreserved characters', () => {
  // RFC 7636 wants 43-128 characters from [A-Za-z0-9-._~]. Anything else gets
  // percent-encoded somewhere along the way and stops matching.
  for (let i = 0; i < 50; i++) {
    const v = makeVerifier();
    assert.ok(v.length >= 43 && v.length <= 128, `length ${v.length}`);
    assert.match(v, /^[A-Za-z0-9\-._~]+$/, v);
  }
});

test('verifiers do not repeat', () => {
  const seen = new Set();
  for (let i = 0; i < 200; i++) seen.add(makeVerifier());
  assert.equal(seen.size, 200);
});

// ------------------------------------------------------------ redirect ----

test('the redirect is read as a code, an error, or nothing at all', () => {
  assert.deepEqual(parseRedirect('https://x.dev/game/?code=abc&state=s1'), {
    code: 'abc',
    state: 's1',
  });
  assert.deepEqual(parseRedirect('https://x.dev/game/?error=access_denied&state=s1'), {
    error: 'access_denied',
    state: 's1',
  });
  // An ordinary page load must not look like an authorization.
  assert.equal(parseRedirect('https://x.dev/game/'), null);
  assert.equal(parseRedirect('https://x.dev/game/?utm=whatever'), null);
  assert.equal(parseRedirect('not a url'), null);
});

test('the redirect URI drops the query and hash', () => {
  // It has to match the whitelisted value byte for byte, and the authorization
  // response is itself a query string — so building it from a URL that still
  // carries one would change the URI between the request and the reply.
  const loc = { origin: 'https://x.dev', pathname: '/game/' };
  assert.equal(redirectUriFor(loc), 'https://x.dev/game/');
  assert.equal(redirectUriFor({ ...loc, search: '?code=abc', hash: '#x' }), 'https://x.dev/game/');
});

// ------------------------------------------------------------- session ----

test('a token is refreshed before it actually expires', () => {
  const now = 1_000_000;
  assert.equal(isExpired(null, now), true);
  assert.equal(isExpired({}, now), true);
  assert.equal(isExpired({ expiresAt: now + 5 * 60000 }, now), false);
  // Inside the skew it counts as expired, so no request races the boundary.
  assert.equal(isExpired({ expiresAt: now + 30000 }, now), true);
  assert.equal(isExpired({ expiresAt: now - 1 }, now), true);
});

test('the scopes cover playback and nothing that could change an account', () => {
  assert.ok(SCOPES.includes('streaming'), 'the Web Playback SDK needs streaming');
  assert.ok(SCOPES.includes('user-modify-playback-state'), 'remote control needs this');
  for (const s of SCOPES) {
    assert.ok(
      !/modify-playback/.test(s) === !/playback/.test(s) || /playback|streaming|read/.test(s),
      `unexpected scope ${s}`,
    );
    assert.ok(!/library|follow|ugc|upload/.test(s), `${s} is more than this needs`);
  }
});

// ---------------------------------------------------------------- state ----

test('with no client id it is inert rather than broken', () => {
  const m = new SpotifyMusic({ clientId: '', redirectUri: 'https://x.dev/', store: fakeStore() });
  assert.equal(m.status, Status.UNCONFIGURED);
  assert.equal(m.snapshot().configured, false);
  assert.equal(m.snapshot().connected, false);
  // None of these may throw on a build that never set a client id.
  m.setDuck(0.5);
  m.setVolume(0.3);
  m.disconnect();
  assert.equal(m.status, Status.UNCONFIGURED);
});

test('a session with no storage still runs', () => {
  // Same rule the profile follows: Safari's private mode throws on write, and
  // losing the session is acceptable where taking the game down is not.
  const m = new SpotifyMusic({ clientId: 'abc', redirectUri: 'https://x.dev/', store: null });
  assert.equal(m.status, Status.OFFLINE);
  m.disconnect();
  assert.equal(m.snapshot().connected, false);
});

test('a corrupt saved session is ignored, not trusted', () => {
  for (const raw of ['not json', '{', 'null', '[]', '{"accessToken":"x"}']) {
    const m = new SpotifyMusic({
      clientId: 'abc',
      redirectUri: 'https://x.dev/',
      store: fakeStore({ 'fingerflip.spotify.v1': raw }),
    });
    // Without a refresh token there is no session worth restoring.
    assert.equal(m._read(), null, `accepted ${raw}`);
  }
  const good = new SpotifyMusic({
    clientId: 'abc',
    redirectUri: 'https://x.dev/',
    store: fakeStore({
      'fingerflip.spotify.v1': JSON.stringify({ accessToken: 'a', refreshToken: 'r', expiresAt: 1 }),
    }),
  });
  assert.equal(good._read().refreshToken, 'r');
});

test('signing out clears the stored session', () => {
  const store = fakeStore({
    'fingerflip.spotify.v1': JSON.stringify({ accessToken: 'a', refreshToken: 'r', expiresAt: 1 }),
  });
  const m = new SpotifyMusic({ clientId: 'abc', redirectUri: 'https://x.dev/', store });
  m.disconnect();
  assert.equal(store.getItem('fingerflip.spotify.v1'), null);
  assert.equal(m.snapshot().connected, false);
});

test('ducking has a deadband, because remote volume is a network call', () => {
  const m = new SpotifyMusic({ clientId: 'abc', redirectUri: 'https://x.dev/', store: fakeStore() });
  const sent = [];
  m._applyVolume = () => sent.push(m.duck);

  m.setDuck(0.5);
  assert.deepEqual(sent, [0.5]);
  m.setDuck(0.52); // within the deadband
  m.setDuck(0.53);
  assert.deepEqual(sent, [0.5], 'small wobbles must not each become a request');
  m.setDuck(0.7);
  assert.deepEqual(sent, [0.5, 0.7]);

  // And it stays in range however it is driven.
  m.setDuck(9);
  assert.equal(m.duck, 1);
  m.setDuck(-4);
  assert.equal(m.duck, 0);
});

test('the snapshot never leaks the tokens', () => {
  // It goes straight into the DOM, and it is handed to anything that subscribes.
  const m = new SpotifyMusic({ clientId: 'abc', redirectUri: 'https://x.dev/', store: fakeStore() });
  m.token = { accessToken: 'SECRET-ACCESS', refreshToken: 'SECRET-REFRESH', expiresAt: 9e12 };
  const json = JSON.stringify(m.snapshot());
  assert.ok(!json.includes('SECRET'), 'a token reached the snapshot');
});
