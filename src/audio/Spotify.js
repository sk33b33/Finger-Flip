/**
 * Spotify — optional music, signed in by the player.
 *
 * ## What is actually possible here, stated up front
 *
 * Spotify gates ALL playback behind Premium. A free account can authenticate
 * and read its own playlists perfectly well, and then every call that would
 * make a sound returns 403. That is not something this code can work around,
 * so it detects the case and says so plainly rather than failing quietly.
 *
 * There are two ways to make sound, and which is available depends on the
 * device rather than on anything we choose:
 *
 *   SDK    — the Web Playback SDK turns this page into a Spotify Connect
 *            device and plays here. Desktop browsers only: it needs EME, and
 *            Spotify does not support it on mobile browsers at all.
 *   REMOTE — the Web API drives a device the player already has running,
 *            typically the Spotify app on their phone. Works everywhere,
 *            including iOS, but they have to have Spotify open somewhere.
 *
 * So this tries the SDK, falls back to remote, and reports which one it got.
 *
 * ## Auth
 *
 * Authorization Code with PKCE. The game is a static bundle with no server, so
 * there is nowhere to keep a client secret — which is exactly the case PKCE
 * exists for. The implicit grant would also avoid a secret and is what old
 * tutorials show; it is deprecated and returns no refresh token, so sessions
 * would die after an hour.
 *
 * The client ID is not a secret either. It identifies the app, and PKCE is what
 * stops anyone else using it. It comes from the environment so that whoever
 * builds this points it at their own Spotify app registration.
 */

const AUTH_HOST = 'https://accounts.spotify.com';
const API = 'https://api.spotify.com/v1';
const SDK_SRC = 'https://sdk.scdn.co/spotify-player.js';

const STORE_KEY = 'fingerflip.spotify.v1';
const VERIFIER_KEY = 'fingerflip.spotify.pkce';

/**
 * `streaming` is what the Web Playback SDK needs; the two user-read scopes are
 * its prerequisites. The playback-state pair is what lets the remote mode see
 * and drive another device. Nothing here can modify a library or a playlist.
 */
export const SCOPES = [
  'streaming',
  'user-read-email',
  'user-read-private',
  'user-read-playback-state',
  'user-modify-playback-state',
  'user-read-currently-playing',
  'playlist-read-private',
  'playlist-read-collaborative',
];

export const Status = Object.freeze({
  UNCONFIGURED: 'UNCONFIGURED', // no client id was built in
  OFFLINE: 'OFFLINE', // configured, nobody signed in
  CONNECTING: 'CONNECTING',
  READY: 'READY',
  NO_PREMIUM: 'NO_PREMIUM', // signed in, but Spotify will not play for them
  NO_DEVICE: 'NO_DEVICE', // remote mode with nothing to drive
  ERROR: 'ERROR',
});

export const Mode = Object.freeze({ SDK: 'SDK', REMOTE: 'REMOTE', NONE: 'NONE' });

// ---------------------------------------------------------------- PKCE ----

const VERIFIER_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';

/** A high-entropy code verifier, 64 characters from the unreserved set. */
export function makeVerifier(length = 64) {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let out = '';
  for (const b of bytes) out += VERIFIER_CHARS[b % VERIFIER_CHARS.length];
  return out;
}

/** base64url, without padding — what RFC 7636 asks for. */
function base64url(bytes) {
  let bin = '';
  for (const b of new Uint8Array(bytes)) bin += String.fromCharCode(b);
  // btoa exists in browsers and in Node 16+; neither gives base64url directly.
  const b64 = typeof btoa === 'function' ? btoa(bin) : Buffer.from(bin, 'binary').toString('base64');
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** S256 challenge for a verifier. */
export async function makeChallenge(verifier) {
  const data = new TextEncoder().encode(verifier);
  return base64url(await crypto.subtle.digest('SHA-256', data));
}

/**
 * Pulls the authorization result out of a redirect URL.
 *
 * Spotify comes back to exactly the URI it was given, with either `code` and
 * `state` or an `error`. Anything else is an ordinary page load.
 */
export function parseRedirect(href) {
  let url;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  const p = url.searchParams;
  if (p.get('error')) return { error: p.get('error'), state: p.get('state') };
  if (p.get('code')) return { code: p.get('code'), state: p.get('state') };
  return null;
}

/** Tokens are refreshed a minute early, so a call never races the expiry. */
export function isExpired(token, now = Date.now(), skewMs = 60000) {
  if (!token || !token.expiresAt) return true;
  return now + skewMs >= token.expiresAt;
}

/**
 * The redirect URI to register with Spotify.
 *
 * Must match what is whitelisted byte for byte, so it is built from the origin
 * and path with the query and hash stripped — the authorization response is
 * itself a query string, and leaving one on would change the URI between the
 * request and the reply.
 */
export function redirectUriFor(loc = window.location) {
  return `${loc.origin}${loc.pathname}`;
}

// ------------------------------------------------------------- storage ----

function storage() {
  try {
    if (typeof localStorage === 'undefined') return null;
    const probe = '__ffs__';
    localStorage.setItem(probe, '1');
    localStorage.removeItem(probe);
    return localStorage;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------- the thing ---

export default class SpotifyMusic {
  /**
   * @param {object} o
   * @param {string} o.clientId  from VITE_SPOTIFY_CLIENT_ID
   * @param {Storage|null} o.store injectable so the tests need no DOM
   */
  constructor({ clientId, redirectUri, store = storage(), allowSdk } = {}) {
    this.clientId = clientId || '';
    this.redirectUri = redirectUri || (typeof window !== 'undefined' ? redirectUriFor() : '');
    this.store = store;
    // The SDK cannot run on a mobile browser — Spotify does not support it
    // there — so those devices go straight to driving a device they already
    // have running rather than failing at EME and looking broken.
    this.allowSdk =
      allowSdk ?? (typeof navigator !== 'undefined' && !/Android|iPhone|iPad|iPod/i.test(navigator.userAgent));

    this.token = null;
    this.status = this.clientId ? Status.OFFLINE : Status.UNCONFIGURED;
    this.mode = Mode.NONE;
    this.error = null;
    this.user = null;
    this.playlists = [];
    this.track = null;
    this.playing = false;
    this.deviceId = null; // our SDK device, when we have one
    this.deviceName = null; // whatever we are actually driving
    this.volume = 0.55;
    this.duck = 0;

    this._player = null;
    this._listeners = new Set();
    this._poll = null;
  }

  onChange(fn) {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  _emit() {
    for (const fn of this._listeners) fn(this.snapshot());
  }

  /** Everything the UI needs, and nothing it can break. */
  snapshot() {
    return {
      status: this.status,
      mode: this.mode,
      configured: !!this.clientId,
      connected: this.status === Status.READY || this.status === Status.NO_DEVICE,
      error: this.error,
      user: this.user && { name: this.user.display_name, product: this.user.product },
      playlists: this.playlists,
      track: this.track,
      playing: this.playing,
      deviceName: this.deviceName,
      volume: this.volume,
    };
  }

  // ------------------------------------------------------------- auth ----

  /**
   * Pick up where we left off: an existing token, or a fresh authorization
   * coming back from Spotify. Safe to call on every boot.
   */
  async resume() {
    if (!this.clientId) return;

    const redirect = typeof window !== 'undefined' ? parseRedirect(window.location.href) : null;
    if (redirect) {
      // Clean the URL whatever happened, so a refresh does not replay an
      // authorization code that Spotify has already spent.
      const clean = this.redirectUri;
      try {
        window.history.replaceState({}, '', clean);
      } catch {
        /* a sandboxed frame may refuse; the code is single-use anyway */
      }
      if (redirect.error) {
        this._fail(redirect.error === 'access_denied' ? 'Sign-in cancelled.' : redirect.error);
        return;
      }
      await this._exchange(redirect.code);
      return;
    }

    const saved = this._read();
    if (!saved) return;
    this.token = saved;
    await this._ensureToken();
    if (this.token) await this._connect();
  }

  /** Send the player to Spotify to sign in. Navigates away. */
  async beginLogin() {
    if (!this.clientId) return;
    const verifier = makeVerifier();
    const challenge = await makeChallenge(verifier);
    const state = makeVerifier(16);
    try {
      this.store?.setItem(VERIFIER_KEY, JSON.stringify({ verifier, state }));
    } catch {
      /* without storage the exchange will fail cleanly below */
    }
    const q = new URLSearchParams({
      client_id: this.clientId,
      response_type: 'code',
      redirect_uri: this.redirectUri,
      code_challenge_method: 'S256',
      code_challenge: challenge,
      state,
      scope: SCOPES.join(' '),
    });
    window.location.assign(`${AUTH_HOST}/authorize?${q}`);
  }

  disconnect() {
    try {
      this._player?.disconnect();
    } catch {
      /* already gone */
    }
    this._player = null;
    if (this._poll) clearInterval(this._poll);
    this._poll = null;
    this.token = null;
    this.user = null;
    this.playlists = [];
    this.track = null;
    this.playing = false;
    this.deviceId = null;
    this.deviceName = null;
    this.mode = Mode.NONE;
    this.error = null;
    this.status = this.clientId ? Status.OFFLINE : Status.UNCONFIGURED;
    try {
      this.store?.removeItem(STORE_KEY);
    } catch {
      /* nothing to clear */
    }
    this._emit();
  }

  async _exchange(code) {
    let pkce = null;
    try {
      pkce = JSON.parse(this.store?.getItem(VERIFIER_KEY) || 'null');
    } catch {
      pkce = null;
    }
    try {
      this.store?.removeItem(VERIFIER_KEY);
    } catch {
      /* best effort */
    }
    if (!pkce?.verifier) {
      this._fail('Sign-in could not be completed. Try again.');
      return;
    }

    this.status = Status.CONNECTING;
    this._emit();
    const body = new URLSearchParams({
      client_id: this.clientId,
      grant_type: 'authorization_code',
      code,
      redirect_uri: this.redirectUri,
      code_verifier: pkce.verifier,
    });
    try {
      const res = await fetch(`${AUTH_HOST}/api/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      });
      if (!res.ok) throw new Error(`token exchange failed (${res.status})`);
      this._store(await res.json());
      await this._connect();
    } catch (e) {
      this._fail(e.message);
    }
  }

  async _ensureToken() {
    if (!isExpired(this.token)) return true;
    if (!this.token?.refreshToken) {
      this.disconnect();
      return false;
    }
    const body = new URLSearchParams({
      client_id: this.clientId,
      grant_type: 'refresh_token',
      refresh_token: this.token.refreshToken,
    });
    try {
      const res = await fetch(`${AUTH_HOST}/api/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      });
      if (!res.ok) throw new Error('session expired');
      const json = await res.json();
      // A refresh does not always return a new refresh token; keep the old one.
      this._store({ refresh_token: this.token.refreshToken, ...json });
      return true;
    } catch {
      this.disconnect();
      return false;
    }
  }

  _store(json) {
    this.token = {
      accessToken: json.access_token,
      refreshToken: json.refresh_token || this.token?.refreshToken || null,
      expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000,
    };
    try {
      this.store?.setItem(STORE_KEY, JSON.stringify(this.token));
    } catch {
      /* a session that cannot be saved still works until reload */
    }
  }

  _read() {
    try {
      const raw = this.store?.getItem(STORE_KEY);
      if (!raw) return null;
      const t = JSON.parse(raw);
      return t && t.refreshToken ? t : null;
    } catch {
      return null;
    }
  }

  _fail(message) {
    this.status = Status.ERROR;
    this.error = message;
    this._emit();
  }

  // -------------------------------------------------------------- api ----

  async api(path, init = {}) {
    if (!(await this._ensureToken())) return null;
    const res = await fetch(path.startsWith('http') ? path : `${API}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.token.accessToken}`,
        'Content-Type': 'application/json',
        ...(init.headers || {}),
      },
    });
    // 204 is the usual success for the player endpoints, and has no body.
    if (res.status === 204) return {};
    if (res.status === 403) {
      this.status = Status.NO_PREMIUM;
      this._emit();
      return null;
    }
    if (res.status === 404) {
      // No active device — the remote has nothing to drive.
      this.status = Status.NO_DEVICE;
      this._emit();
      return null;
    }
    if (!res.ok) return null;
    try {
      return await res.json();
    } catch {
      return {};
    }
  }

  // ---------------------------------------------------------- connect ----

  async _connect() {
    this.status = Status.CONNECTING;
    this.error = null;
    this._emit();

    this.user = await this.api('/me');
    if (!this.user) {
      this._fail('Could not read your Spotify profile.');
      return;
    }
    if (this.user.product !== 'premium') {
      // Everything that makes a sound is Premium-only. Say so now rather than
      // letting every control 403 one at a time.
      this.status = Status.NO_PREMIUM;
      this.mode = Mode.NONE;
      await this._loadPlaylists();
      this._emit();
      return;
    }

    await this._loadPlaylists();

    if (this.allowSdk && (await this._startSdk())) {
      this.mode = Mode.SDK;
      this.status = Status.READY;
    } else {
      this.mode = Mode.REMOTE;
      this.status = Status.READY;
      await this.refreshPlayback();
    }

    if (!this._poll) this._poll = setInterval(() => this.refreshPlayback(), 5000);
    this._emit();
  }

  async _loadPlaylists() {
    const json = await this.api('/me/playlists?limit=24');
    this.playlists = (json?.items || [])
      .filter(Boolean)
      .map((p) => ({ id: p.id, uri: p.uri, name: p.name, tracks: p.tracks?.total ?? 0 }));
  }

  /** Load the Web Playback SDK and register this page as a device. */
  _startSdk() {
    return new Promise((resolve) => {
      if (typeof window === 'undefined' || typeof document === 'undefined') return resolve(false);

      const boot = () => {
        const Player = window.Spotify?.Player;
        if (!Player) return resolve(false);
        const player = new Player({
          name: 'Finger Flip',
          getOAuthToken: async (cb) => {
            if (await this._ensureToken()) cb(this.token.accessToken);
          },
          volume: this.volume,
        });
        this._player = player;

        player.addListener('ready', ({ device_id: id }) => {
          this.deviceId = id;
          this.deviceName = 'this browser';
          resolve(true);
        });
        player.addListener('not_ready', () => {
          this.deviceId = null;
          this._emit();
        });
        player.addListener('player_state_changed', (s) => {
          if (!s) return;
          const t = s.track_window?.current_track;
          this.track = t && {
            name: t.name,
            artist: (t.artists || []).map((a) => a.name).join(', '),
            art: t.album?.images?.[0]?.url || null,
          };
          this.playing = !s.paused;
          this._emit();
        });
        player.addListener('account_error', () => {
          this.status = Status.NO_PREMIUM;
          this._emit();
          resolve(false);
        });
        player.addListener('initialization_error', () => resolve(false));
        player.addListener('authentication_error', () => resolve(false));

        player.connect().then((ok) => {
          if (!ok) resolve(false);
        });
        // The SDK can sit silently on an unsupported browser; do not hang the
        // whole connect on it.
        setTimeout(() => resolve(!!this.deviceId), 6000);
      };

      if (window.Spotify?.Player) return boot();
      window.onSpotifyWebPlaybackSDKReady = boot;
      if (!document.querySelector(`script[src="${SDK_SRC}"]`)) {
        const el = document.createElement('script');
        el.src = SDK_SRC;
        el.async = true;
        el.onerror = () => resolve(false);
        document.head.appendChild(el);
      }
      setTimeout(() => resolve(!!this.deviceId), 8000);
    });
  }

  // -------------------------------------------------------- transport ----

  /** Which device the commands go to: ours if we have one, else theirs. */
  _target() {
    return this.deviceId ? `?device_id=${this.deviceId}` : '';
  }

  async refreshPlayback() {
    if (this.status !== Status.READY && this.status !== Status.NO_DEVICE) return;
    const s = await this.api('/me/player');
    if (!s || !s.item) {
      if (this.mode === Mode.REMOTE && !this.track) this.status = Status.NO_DEVICE;
      this._emit();
      return;
    }
    this.status = Status.READY;
    this.deviceName = s.device?.name || this.deviceName;
    this.playing = !!s.is_playing;
    this.track = {
      name: s.item.name,
      artist: (s.item.artists || []).map((a) => a.name).join(', '),
      art: s.item.album?.images?.[0]?.url || null,
    };
    this._emit();
  }

  async playPlaylist(uri) {
    await this.api(`/me/player/play${this._target()}`, {
      method: 'PUT',
      body: JSON.stringify({ context_uri: uri }),
    });
    this.playing = true;
    this._emit();
    setTimeout(() => this.refreshPlayback(), 700);
  }

  async toggle() {
    await this.api(`/me/player/${this.playing ? 'pause' : 'play'}${this._target()}`, { method: 'PUT' });
    this.playing = !this.playing;
    this._emit();
    setTimeout(() => this.refreshPlayback(), 700);
  }

  async skip(dir = 1) {
    await this.api(`/me/player/${dir > 0 ? 'next' : 'previous'}${this._target()}`, { method: 'POST' });
    setTimeout(() => this.refreshPlayback(), 700);
  }

  // ------------------------------------------------------------ mixing ----

  setVolume(v) {
    this.volume = Math.max(0, Math.min(1, v));
    this._applyVolume();
    this._emit();
  }

  /**
   * Pull the music back while the world is in slow motion.
   *
   * Spotify's audio is out of reach of the game's filter bus — it is a
   * different graph entirely, and in remote mode a different machine — so the
   * only handle is its volume. Ducking it is what keeps the trick window
   * feeling like it happens somewhere else, the same job setSlowmo() does to
   * everything the game synthesises itself.
   *
   * @param {number} amount 0 = full, 1 = fully ducked
   */
  setDuck(amount) {
    const next = Math.max(0, Math.min(1, amount));
    // Volume calls are network requests in remote mode, so only send one when
    // the value has actually moved a noticeable amount.
    if (Math.abs(next - this.duck) < 0.05) return;
    this.duck = next;
    this._applyVolume();
  }

  _applyVolume() {
    const v = this.volume * (1 - this.duck);
    if (this._player) {
      this._player.setVolume(v).catch(() => {});
      return;
    }
    // Remote: a whole HTTP round trip, hence the deadband above.
    if (this.status === Status.READY) {
      this.api(`/me/player/volume?volume_percent=${Math.round(v * 100)}`, { method: 'PUT' });
    }
  }
}
