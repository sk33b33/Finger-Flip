import './shell.css';
import { listLayouts } from '../sim/Park.js';
import { listCharacters } from '../view/Characters.js';
import { dailyChallenges } from '../game/Events.js';
import { Status, Mode } from '../audio/Spotify.js';

/**
 * The menu: home, maps, events, profile, stats, settings.
 *
 * Plain DOM over the canvas, same as ui/Hud.js — one template, `$` lookups,
 * class toggles. It owns no state of its own: everything it draws comes from
 * the Profile it is handed and from the layout/character tables, and everything
 * it changes goes back out through callbacks. Open it twice and it renders the
 * same thing twice, because there is nothing in here to get out of sync.
 *
 * The game keeps rendering behind it — the rider is still rolling under the
 * blur, which costs nothing since the frame is being drawn anyway.
 */

const TABS = [
  { id: 'home', label: 'Home' },
  { id: 'maps', label: 'Maps' },
  { id: 'events', label: 'Events' },
  { id: 'profile', label: 'Profile' },
  { id: 'stats', label: 'Stats' },
  { id: 'music', label: 'Music' },
  { id: 'settings', label: 'Settings' },
];

export default class Shell {
  /**
   * @param {HTMLElement} container
   * @param {Profile} profile
   */
  constructor(container, profile) {
    this.profile = profile;
    this.tab = 'home';
    this.first = true; // no run started yet, so there is nothing to close back to
    this.handlers = {};

    this.root = document.createElement('div');
    this.root.className = 'shell is-hidden is-first';
    this.root.innerHTML = TEMPLATE;
    container.appendChild(this.root);

    const $ = (sel) => this.root.querySelector(sel);
    this.el = {
      tabs: $('.js-tabs'),
      body: $('.js-body'),
      best: $('.js-best'),
      close: $('.js-close'),
    };

    this.el.tabs.innerHTML = TABS.map(
      (t) =>
        `<button class="tab js-tab" type="button" data-tab="${t.id}">${t.label}<span class="tab__dot js-dot-${t.id}" hidden></span></button>`,
    ).join('');

    this.el.tabs.addEventListener('click', (e) => {
      const btn = e.target.closest('.js-tab');
      if (btn) this.show(btn.dataset.tab);
    });

    this.el.close.addEventListener('click', () => this.emit('close'));

    // One delegated listener for every tile in every pane. The panes are
    // re-rendered on each open, so per-tile listeners would have to be rebound
    // every time and any missed one is a dead button.
    this.el.body.addEventListener('click', (e) => {
      const el = e.target.closest('[data-action]');
      if (!el) return;
      this.emit(el.dataset.action, el.dataset.value);
    });
  }

  /** @param {string} name @param {(value: string) => void} fn */
  on(name, fn) {
    this.handlers[name] = fn;
    return this;
  }

  emit(name, value) {
    this.handlers[name]?.(value);
  }

  // --------------------------------------------------------- open / close ---

  open(state) {
    this.state = state;
    this.render();
    this.root.classList.remove('is-hidden');
  }

  close() {
    this.root.classList.add('is-hidden');
    this.first = false;
    this.root.classList.remove('is-first');
  }

  get isOpen() {
    return !this.root.classList.contains('is-hidden');
  }

  show(tab) {
    this.tab = tab;
    for (const btn of this.root.querySelectorAll('.js-tab')) {
      btn.classList.toggle('is-on', btn.dataset.tab === tab);
    }
    for (const pane of this.root.querySelectorAll('.js-pane')) {
      pane.classList.toggle('is-on', pane.dataset.pane === tab);
    }
    this.el.body.scrollTop = 0;
  }

  // ------------------------------------------------------------- rendering ---

  render() {
    const s = this.profile.stats;
    const today = dailyChallenges();

    this.el.best.innerHTML = `Best line<b>${num(s.bestScore)}</b>`;
    this.el.body.innerHTML = [
      pane('home', this.homeHtml(today)),
      pane('maps', this.mapsHtml()),
      pane('events', this.eventsHtml(today)),
      pane('profile', this.profileHtml()),
      pane('stats', this.statsHtml()),
      pane('music', this.musicHtml()),
      pane('settings', this.settingsHtml()),
    ].join('');

    // A dot on Events while anything is still open, so the tab is worth a look.
    const open = today.some((c) => !this.profile.eventProgress(c.id).done);
    this.root.querySelector('.js-dot-events').hidden = !open;

    this.show(this.tab);
  }

  homeHtml(today) {
    const map = this.currentMap();
    const character = this.currentCharacter();
    const next = today.find((c) => !this.profile.eventProgress(c.id).done);

    return `
      <div class="grid grid--wide">
        <button class="tile tile--play" type="button" data-action="play">
          <div class="tile__kicker">${esc(map.name)} &middot; ${esc(character.name)}</div>
          <div class="tile__name">Drop in</div>
          <div class="tile__blurb">${esc(map.blurb)}</div>
          <div class="tile__foot">Best here ${num(this.profile.bestOn(map.id))}</div>
        </button>

        <button class="tile" type="button" data-action="tab" data-value="events">
          <div class="tile__kicker">Today</div>
          <div class="tile__name">${esc(next ? next.name : 'All done')}</div>
          <div class="tile__blurb">${esc(next ? next.blurb : 'Every challenge cleared. New set at midnight.')}</div>
          ${next ? bar(this.profile.eventProgress(next.id).progress, next.goal) : ''}
        </button>

        <button class="tile" type="button" data-action="tab" data-value="maps">
          <div class="tile__kicker">Parks</div>
          <div class="tile__name">Pick a park</div>
          <div class="tile__blurb">Three of them, and they ride nothing like each other.</div>
          <div class="tile__foot">${listLayouts().length} available</div>
        </button>

        <button class="tile" type="button" data-action="tab" data-value="profile">
          <div class="tile__kicker">Rider</div>
          <div class="tile__name">${esc(character.name)}</div>
          <div class="tile__blurb">${esc(character.blurb)}</div>
          ${swatch(character.swatch)}
        </button>
      </div>`;
  }

  mapsHtml() {
    const current = this.state.mapId;
    return `<div class="grid grid--wide">${listLayouts()
      .map(
        (m) => `
        <button class="tile ${m.id === current ? 'is-on' : ''}" type="button"
                data-action="map" data-value="${m.id}">
          <div class="tile__kicker">${m.runLength}m lap</div>
          <div class="tile__name">${esc(m.name)}</div>
          <div class="tile__blurb">${esc(m.blurb)}</div>
          <div class="tile__foot">Best ${num(this.profile.bestOn(m.id))}</div>
        </button>`,
      )
      .join('')}</div>`;
  }

  eventsHtml(today) {
    return `
      <div class="grid grid--wide">${today
        .map((c) => {
          const p = this.profile.eventProgress(c.id);
          return `
          <div class="tile ${p.done ? 'is-done is-on' : ''}">
            <div class="tile__kicker">${p.done ? 'Complete' : 'Today'}</div>
            <div class="tile__name">${esc(c.name)}</div>
            <div class="tile__blurb">${esc(c.blurb)}</div>
            ${bar(p.progress, c.goal)}
            <div class="tile__foot">${p.progress} / ${c.goal} ${esc(c.unit)}</div>
          </div>`;
        })
        .join('')}</div>
      <div class="section">
        <div class="section__h">How this works</div>
        <div class="rows"><div class="rows__empty">
          Three challenges a day, the same for everyone, changing at midnight.
          They are graded off the tricks you land, so nothing needs claiming.
        </div></div>
      </div>`;
  }

  profileHtml() {
    const current = this.state.characterId;
    return `<div class="grid">${listCharacters()
      .map(
        (c) => `
        <button class="tile ${c.id === current ? 'is-on' : ''}" type="button"
                data-action="character" data-value="${c.id}">
          <div class="tile__kicker">${c.id === current ? 'Riding' : 'Rider'}</div>
          <div class="tile__name">${esc(c.name)}</div>
          <div class="tile__blurb">${esc(c.blurb)}</div>
          ${swatch(c.swatch)}
        </button>`,
      )
      .join('')}</div>`;
  }

  statsHtml() {
    const s = this.profile.stats;
    const tricks = Object.entries(s.trickCounts).sort((a, b) => b[1] - a[1]);
    const landRate = s.tricksLanded + s.bails > 0
      ? Math.round((s.tricksLanded / (s.tricksLanded + s.bails)) * 100)
      : 0;

    return `
      <div class="stats">
        ${stat('Best line', num(s.bestScore))}
        ${stat('Lines banked', num(s.runs))}
        ${stat('Total points', num(s.totalScore))}
        ${stat('Tricks landed', num(s.tricksLanded))}
        ${stat('Slams', num(s.bails))}
        ${stat('Land rate', `${landRate}%`)}
        ${stat('Best combo', `${(s.bestCombo || 1).toFixed(2)}x`)}
        ${stat('Air time', `${Math.round(s.airTime)}s`)}
      </div>

      <div class="section">
        <div class="section__h">Best trick</div>
        <div class="rows">${
          s.bestTrick
            ? `<div class="rows__row">${esc(s.bestTrick.name)}
                 <span style="color:var(--dim)">on ${esc(mapName(s.bestTrick.map))}</span>
                 <b>${num(s.bestTrick.points)}</b></div>`
            : '<div class="rows__empty">Land something and it will show up here.</div>'
        }</div>
      </div>

      <div class="section">
        <div class="section__h">Best per park</div>
        <div class="rows">${listLayouts()
          .map(
            (m) =>
              `<div class="rows__row">${esc(m.name)}<b>${num(this.profile.bestOn(m.id))}</b></div>`,
          )
          .join('')}</div>
      </div>

      <div class="section">
        <div class="section__h">Tricks landed</div>
        <div class="rows">${
          tricks.length
            ? tricks
                .map(([n, c]) => `<div class="rows__row">${esc(n)}<b>${num(c)}</b></div>`)
                .join('')
            : '<div class="rows__empty">Nothing yet.</div>'
        }</div>
      </div>
`;
  }

  musicHtml() {
    const m = this.state.music;
    if (!m || !m.configured) {
      return `
        <div class="tile" style="cursor:default">
          <div class="tile__kicker">Spotify</div>
          <div class="tile__name">Not set up</div>
          <div class="tile__blurb">
            This build has no Spotify client ID. Register an app at
            developer.spotify.com, whitelist this page as a redirect URI, and
            build with <b>VITE_SPOTIFY_CLIENT_ID</b> set. The README has the steps.
          </div>
        </div>`;
    }

    if (m.status === Status.NO_PREMIUM) {
      return `
        <div class="tile is-done" style="cursor:default">
          <div class="tile__kicker">Signed in${m.user ? ` as ${esc(m.user.name || '')}` : ''}</div>
          <div class="tile__name">Premium required</div>
          <div class="tile__blurb">
            Spotify only allows an app to play audio for Premium accounts — both
            in the browser and on another device. Your playlists are readable,
            but nothing here can start them. Nothing to be done from this end.
          </div>
          <div class="tile__foot">
            <button class="btn" type="button" data-action="spotify-out">Sign out</button>
          </div>
        </div>`;
    }

    if (!m.connected && m.status !== Status.CONNECTING) {
      return `
        <button class="tile tile--play" type="button" data-action="spotify-in">
          <div class="tile__kicker">Spotify</div>
          <div class="tile__name">Connect</div>
          <div class="tile__blurb">
            Play your own music over the run. Sends you to Spotify to sign in
            and comes straight back. Premium only — that is Spotify's rule for
            any app that plays audio, not ours.
          </div>
          ${m.error ? `<div class="tile__foot" style="color:#ff8a72">${esc(m.error)}</div>` : ''}
        </button>`;
    }

    if (m.status === Status.CONNECTING) {
      return `<div class="tile" style="cursor:default">
          <div class="tile__kicker">Spotify</div>
          <div class="tile__name">Connecting…</div>
        </div>`;
    }

    const where =
      m.mode === Mode.SDK
        ? 'Playing here in the browser.'
        : `Driving ${esc(m.deviceName || 'your Spotify app')}.`;

    const nothing = m.status === Status.NO_DEVICE;
    return `
      <div class="tile" style="cursor:default">
        <div class="tile__kicker">${esc(m.user?.name || 'Spotify')} &middot; ${where}</div>
        <div class="tile__name">${esc(m.track ? m.track.name : nothing ? 'Nothing playing' : '—')}</div>
        <div class="tile__blurb">${
          m.track
            ? esc(m.track.artist)
            : nothing
              ? 'Open Spotify on a phone or desktop and start something, or pick a playlist below.'
              : ''
        }</div>
        <div class="tile__foot" style="display:flex;gap:8px;align-items:center">
          <button class="btn" type="button" data-action="spotify-prev">&#9664;&#9664;</button>
          <button class="btn btn--acid" type="button" data-action="spotify-toggle">${m.playing ? 'Pause' : 'Play'}</button>
          <button class="btn" type="button" data-action="spotify-next">&#9654;&#9654;</button>
          <button class="btn" type="button" data-action="spotify-out" style="margin-left:auto">Sign out</button>
        </div>
      </div>

      <div class="section">
        <div class="section__h">Your playlists</div>
        <div class="grid">${
          m.playlists.length
            ? m.playlists
                .map(
                  (p) => `
              <button class="tile" type="button" data-action="spotify-play" data-value="${esc(p.uri)}">
                <div class="tile__name" style="font-size:15px">${esc(p.name)}</div>
                <div class="tile__foot">${p.tracks} tracks</div>
              </button>`,
                )
                .join('')
            : '<div class="rows"><div class="rows__empty">No playlists found.</div></div>'
        }</div>
      </div>

      <div class="section">
        <div class="section__h">In the mix</div>
        <div class="rows"><div class="rows__empty">
          The music pulls back while the world is in slow motion and comes back
          on the landing, so the trick window still sounds like somewhere else.
        </div></div>
      </div>`;
  }

  settingsHtml() {
    const st = this.state;
    return `
      <div class="setting">
        <div>
          <div class="setting__label">Render quality</div>
          <div class="setting__note">Steps down on its own if the frame rate sags.</div>
        </div>
        <div class="setting__ctl">
          <button class="btn" type="button" data-action="quality">${esc(st.quality)}</button>
        </div>
      </div>

      <div class="setting">
        <div>
          <div class="setting__label">Sound</div>
          <div class="setting__note">Synthesised at runtime, no files.</div>
        </div>
        <div class="setting__ctl">
          <button class="btn" type="button" data-action="mute">${st.muted ? 'Off' : 'On'}</button>
        </div>
      </div>

      <div class="section">
        <div class="section__h">Controls</div>
        <div class="rows"><div class="rows__row" style="display:block">
          <p class="keys" style="margin:0 0 8px">
            <b>A</b> <b>D</b> or drag &mdash; steer &nbsp;&middot;&nbsp;
            <b>Space</b> or hold anywhere &mdash; charge the pop
          </p>
          <p class="keys" style="margin:0 0 8px">
            In the air, a finger on each end of the board. Slide off the
            <b>toe rail</b> for a kickflip, the <b>heel rail</b> for a heelflip,
            scoop across the tail for a shove-it. Plant a finger back on the
            deck to catch it — that is the whole skill.
          </p>
          <p class="keys" style="margin:0">
            Keyboard fingers: <b>WASD</b> and the <b>arrow keys</b>.
            <b>Q</b> and <b>/</b> plant without moving.
            <b>R</b> restart &middot; <b>M</b> mute &middot; <b>Esc</b> this menu
          </p>
        </div></div>
      </div>

      <div class="section">
        <div class="section__h">Danger</div>
        <div class="setting">
          <div>
            <div class="setting__label">Erase everything</div>
            <div class="setting__note">Stats, bests and today's progress. No undo.</div>
          </div>
          <div class="setting__ctl">
            <button class="btn btn--danger" type="button" data-action="wipe">Erase</button>
          </div>
        </div>
      </div>`;
  }

  currentMap() {
    return listLayouts().find((m) => m.id === this.state.mapId) || listLayouts()[0];
  }

  currentCharacter() {
    return (
      listCharacters().find((c) => c.id === this.state.characterId) || listCharacters()[0]
    );
  }
}

// -------------------------------------------------------------- fragments ---

function pane(id, html) {
  return `<div class="pane js-pane" data-pane="${id}">${html}</div>`;
}

function stat(k, v) {
  return `<div class="stat"><div class="stat__k">${k}</div><div class="stat__v">${v}</div></div>`;
}

function bar(progress, goal) {
  const pct = Math.round((Math.min(progress, goal) / goal) * 100);
  return `<div class="bar"><span style="width:${pct}%"></span></div>`;
}

function swatch(palette) {
  return `<div class="swatch">${['suit', 'suitDark', 'trim', 'accent']
    .map((k) => `<span style="background:#${palette[k].toString(16).padStart(6, '0')}"></span>`)
    .join('')}</div>`;
}

function mapName(id) {
  return listLayouts().find((m) => m.id === id)?.name || id || '—';
}

function num(n) {
  return Math.round(n || 0).toLocaleString('en-US');
}

/**
 * Everything interpolated into the templates above comes from our own tables,
 * but it is rendered with innerHTML, and a table is exactly the kind of thing
 * someone adds an apostrophe to later.
 */
function esc(s) {
  return String(s ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
}

const TEMPLATE = /* html */ `
<div class="shell__head">
  <div class="shell__mark">Finger<em>Flip</em></div>
  <div class="shell__best js-best"></div>
  <button class="shell__close js-close" type="button" title="Back to the run">&#10005;</button>
</div>
<div class="shell__tabs js-tabs"></div>
<div class="shell__body js-body"></div>
`;
