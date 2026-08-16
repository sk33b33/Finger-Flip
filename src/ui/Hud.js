import Config from '../core/Config.js';

/**
 * UIController. Plain DOM over the canvas: sharp text at any pixel ratio, and
 * it costs the renderer nothing.
 *
 * Two layouts share one element tree — the sparse rolling HUD and the denser
 * trick HUD — toggled by a class on the root so all of it transitions together.
 */
export default class Hud {
  constructor(container) {
    this.root = document.createElement('div');
    this.root.className = 'hud';
    this.root.innerHTML = TEMPLATE;
    container.appendChild(this.root);

    const $ = (sel) => this.root.querySelector(sel);
    this.el = {
      score: $('.js-score'),
      pending: $('.js-pending'),
      combo: $('.js-combo'),
      speed: $('.js-speed'),
      meterFill: $('.js-meter-fill'),
      meterWrap: $('.js-meter'),
      trickPanel: $('.js-trick-panel'),
      trickName: $('.js-trick-name'),
      flip: $('.js-flip'),
      shuv: $('.js-shuv'),
      pitch: $('.js-pitch'),
      spinRow: $('.js-spin-row'),
      spin: $('.js-spin'),
      grabRow: $('.js-grab-row'),
      grab: $('.js-grab'),
      qualityFill: $('.js-quality-fill'),
      qualityLabel: $('.js-quality-label'),
      prompt: $('.js-prompt'),
      banner: $('.js-banner'),
      bannerTrick: $('.js-banner-trick'),
      bannerQuality: $('.js-banner-quality'),
      bannerPoints: $('.js-banner-points'),
      bannerNote: $('.js-banner-note'),
      commit: $('.js-commit'),
      help: $('.js-help'),
      start: $('.js-start'),
      startBtn: $('.js-start-btn'),
      hint: $('.js-hint'),
    };

    this._last = {};
    this.bannerTimer = 0;
    this.promptTimer = 0;
  }

  onStart(fn) {
    this.el.startBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.el.start.classList.add('is-hidden');
      fn();
    });
  }

  onCommit(fn) {
    const go = (e) => {
      e.preventDefault();
      e.stopPropagation();
      fn();
    };
    this.el.commit.addEventListener('pointerdown', go);
  }

  toggleHelp() {
    this.el.help.classList.toggle('is-hidden');
  }

  set(key, el, value) {
    if (this._last[key] === value) return;
    this._last[key] = value;
    el.textContent = value;
  }

  /** Called every real frame. */
  update(s) {
    this.set('score', this.el.score, formatNumber(s.score));
    this.set(
      'pending',
      this.el.pending,
      s.pending > 0 ? `+${formatNumber(s.pending)}` : '',
    );
    this.set(
      'combo',
      this.el.combo,
      s.comboLength > 0 ? `x${s.comboMultiplier.toFixed(2)}` : '',
    );
    this.el.combo.classList.toggle('is-hot', s.comboMultiplier > 2.4);
    this.set('speed', this.el.speed, `${Math.round(s.speed * 3.6)} km/h`);

    const pct = Math.round(s.meter * 100);
    if (this._last.meter !== pct) {
      this._last.meter = pct;
      this.el.meterFill.style.width = `${pct}%`;
    }
    this.el.meterWrap.classList.toggle('is-low', s.meter < Config.nail.meterMinToActivate);
    this.el.meterWrap.classList.toggle('is-active', s.trickActive);

    this.root.classList.toggle('is-trick', s.trickActive);
    this.el.commit.classList.toggle('is-hidden', !s.trickActive);

    if (s.trickActive) {
      this.set('trickName', this.el.trickName, s.trickName);
      this.set('flip', this.el.flip, `${signed(s.spin.flip)}°`);
      this.set('shuv', this.el.shuv, `${signed(s.spin.shuv)}°`);
      this.set('pitch', this.el.pitch, `${signed(s.spin.pitch)}°`);

      const bodyDeg = Math.round(s.bodySpin * 360);
      this.el.spinRow.classList.toggle('row--hidden', Math.abs(bodyDeg) < 20);
      this.set('spin', this.el.spin, `${signed(bodyDeg)}°`);

      this.el.grabRow.classList.toggle('row--hidden', !s.grab);
      this.set('grab', this.el.grab, s.grab ? `${s.grab} ${s.grabHold.toFixed(1)}s` : '—');

      const q = Math.round(s.landingQuality * 100);
      if (this._last.quality !== q) {
        this._last.quality = q;
        this.el.qualityFill.style.width = `${q}%`;
        this.el.qualityFill.style.background = qualityColor(s.landingQuality);
      }
      this.set(
        'qualityLabel',
        this.el.qualityLabel,
        s.landingQuality > 0.78
          ? 'PERFECT LINE'
          : s.landingQuality > 0.5
            ? 'LANDABLE'
            : s.landingQuality > 0.25
              ? 'ROUGH'
              : 'NOT LANDING THAT',
      );
    }

    if (this.promptTimer > 0) {
      this.promptTimer -= s.realDelta;
      if (this.promptTimer <= 0) this.el.prompt.classList.add('is-hidden');
    }
    if (this.bannerTimer > 0) {
      this.bannerTimer -= s.realDelta;
      if (this.bannerTimer <= 0) this.el.banner.classList.remove('is-shown');
    }
  }

  showPrompt(text, seconds = 1.6) {
    this.el.prompt.textContent = text;
    this.el.prompt.classList.remove('is-hidden');
    this.promptTimer = seconds;
  }

  hidePrompt() {
    this.el.prompt.classList.add('is-hidden');
    this.promptTimer = 0;
  }

  showResult({ trick, quality, points, note }) {
    this.el.bannerTrick.textContent = trick;
    this.el.bannerQuality.textContent = quality;
    this.el.bannerQuality.className = `banner__quality js-banner-quality q-${quality}`;
    this.el.bannerPoints.textContent = points > 0 ? `+${formatNumber(points)}` : '';
    this.el.bannerNote.textContent = note || '';
    this.el.banner.classList.add('is-shown');
    this.bannerTimer = quality === 'BAIL' ? 2.2 : 1.8;
  }

  setHint(text) {
    this.el.hint.textContent = text;
  }
}

function signed(v) {
  const r = Math.round(v);
  return r > 0 ? `+${r}` : `${r}`;
}

function formatNumber(n) {
  return Math.round(n).toLocaleString('en-US');
}

function qualityColor(q) {
  if (q > 0.72) return 'linear-gradient(90deg,#1fd67f,#6ef7b6)';
  if (q > 0.38) return 'linear-gradient(90deg,#e6b02c,#ffd76a)';
  return 'linear-gradient(90deg,#e0452f,#ff8a6a)';
}

const TEMPLATE = /* html */ `
<div class="hud__corner hud__corner--tl">
  <div class="score js-score">0</div>
  <div class="score__sub">
    <span class="pending js-pending"></span>
    <span class="combo js-combo"></span>
  </div>
</div>

<div class="hud__corner hud__corner--tr">
  <div class="speed js-speed">0 km/h</div>
</div>

<div class="hud__corner hud__corner--bl">
  <div class="meter js-meter">
    <div class="meter__label">NAIL</div>
    <div class="meter__track"><div class="meter__fill js-meter-fill"></div></div>
  </div>
  <div class="hint js-hint"></div>
</div>

<div class="trick-panel js-trick-panel">
  <div class="trick-panel__top">
    <div class="trick-panel__name js-trick-name">Ollie</div>
    <div class="trick-panel__rows">
      <div class="row"><span class="row__k">FLIP</span><span class="row__v js-flip">0°</span></div>
      <div class="row"><span class="row__k">SHUV</span><span class="row__v js-shuv">0°</span></div>
      <div class="row"><span class="row__k">PITCH</span><span class="row__v js-pitch">0°</span></div>
      <div class="row row--hidden js-spin-row"><span class="row__k">SPIN</span><span class="row__v js-spin">0°</span></div>
      <div class="row row--grab row--hidden js-grab-row"><span class="row__k">GRAB</span><span class="row__v js-grab">—</span></div>
    </div>
    <div class="quality__label js-quality-label">LANDABLE</div>
  </div>
  <div class="quality__track"><div class="quality__fill js-quality-fill"></div></div>
</div>

<button class="commit js-commit is-hidden" type="button">
  <span class="commit__key">SPACE</span>
  <span class="commit__text">LAND IT</span>
</button>

<div class="prompt js-prompt is-hidden"></div>

<div class="banner js-banner">
  <div class="banner__trick js-banner-trick"></div>
  <div class="banner__quality js-banner-quality"></div>
  <div class="banner__points js-banner-points"></div>
  <div class="banner__note js-banner-note"></div>
</div>

<div class="overlay js-help is-hidden">
  <div class="panel">
    <h2>Controls</h2>
    <div class="cols">
      <div>
        <h3>Rolling</h3>
        <p><b>A / D</b> or drag left–right &mdash; steer</p>
        <p><b>Space</b> or hold anywhere &mdash; charge the pop, release to ollie</p>
        <p>Hit a marked lip and you launch whether you popped or not.</p>
      </div>
      <div>
        <h3>In the air</h3>
        <p><b>Two fingers on the board.</b> Each one presses the deck where you put it.</p>
        <p>Press near a <b>tip</b> to pitch it. Slide off the <b>toe rail</b> (orange) for a kickflip, the <b>heel rail</b> (cyan) for a heelflip. Scoop <b>sideways</b> across the tail for a shove-it.</p>
        <p>Put a finger back on the spinning deck to <b>catch</b> it. Catch late for the biggest bonus.</p>
        <p><b>Hold</b> that catch and it becomes a grab &mdash; named by where you are holding. A rail between the trucks is an Indy or a Melon; a tip is a Nosegrab or a Tailgrab. Longer holds score more.</p>
        <p>Carve as you pop and you carry the turn into the air: that is your <b>180</b> or <b>360</b>.</p>
        <p>Keyboard: <b>W A S D</b> is one finger, <b>arrow keys</b> the other. <b>Q</b> / <b>&#47;</b> plant a finger without moving it.</p>
      </div>
    </div>
    <p class="panel__foot"><b>H</b> controls &nbsp;&middot;&nbsp; <b>R</b> restart run &nbsp;&middot;&nbsp; <b>M</b> mute</p>
  </div>
</div>

<div class="overlay js-start">
  <div class="panel panel--start">
    <div class="brand">FINGER<span>FLIP</span></div>
    <p class="tagline">Roll in. Pop. Then the world slows down and it is just you, two fingers and a spinning deck.</p>
    <div class="cols">
      <div>
        <h3>Touch</h3>
        <p>Hold to charge your pop. In the air, put <b>a finger from each hand</b> on the board and work the deck.</p>
      </div>
      <div>
        <h3>Keyboard</h3>
        <p><b>Space</b> pop &middot; <b>WASD</b> left finger &middot; <b>Arrows</b> right finger &middot; <b>Q</b> and <b>&#47;</b> to plant &amp; catch</p>
      </div>
    </div>
    <button class="start-btn js-start-btn" type="button">DROP IN</button>
  </div>
</div>
`;
