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
      qualityFill: $('.js-quality-fill'),
      qualityLabel: $('.js-quality-label'),
      prompt: $('.js-prompt'),
      banner: $('.js-banner'),
      bannerTrick: $('.js-banner-trick'),
      bannerQuality: $('.js-banner-quality'),
      bannerPoints: $('.js-banner-points'),
      bannerNote: $('.js-banner-note'),
      help: $('.js-help'),
      start: $('.js-start'),
      splashImg: $('.js-splash-img'),
      menuBtn: $('.js-menu-btn'),
      hint: $('.js-hint'),
      lesson: $('.js-lesson'),
      lessonStep: $('.js-lesson-step'),
      lessonTitle: $('.js-lesson-title'),
      lessonBody: $('.js-lesson-body'),
      call: $('.js-call'),
      callName: $('.js-call-name'),
      callLetters: $('.js-call-letters'),
    };

    this._last = {};
    this.bannerTimer = 0;
    this.promptTimer = 0;

    this._readySplash();
  }

  /**
   * The splash art fades in once it has actually arrived; a title card that
   * pops in halfway through being read is worse than one that arrives late.
   *
   * It fades in on error and on a timeout too. The overlay is the thing you tap
   * to start, so it must never be left invisible waiting on an image.
   */
  _readySplash() {
    const img = this.el.splashImg;
    const ready = () => this.el.start.classList.add('is-ready');
    if (!img || img.complete) {
      ready();
      return;
    }
    img.addEventListener('load', ready, { once: true });
    img.addEventListener('error', ready, { once: true });
    setTimeout(ready, 2500);
  }

  /**
   * Tap anywhere on the splash to drop in — the whole overlay is the target,
   * and it fires on pointerdown rather than click so the tap lands instantly.
   */
  onStart(fn) {
    this.el.start.addEventListener(
      'pointerdown',
      (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.hideStart();
        fn();
      },
      { once: true },
    );
  }

  hideStart() {
    this.el.start.classList.add('is-hidden');
  }

  onMenu(fn) {
    this.el.menuBtn.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      fn();
    });
  }

  toggleHelp() {
    this.el.help.classList.toggle('is-hidden');
  }

  set(key, el, value, html = false) {
    if (this._last[key] === value) return;
    this._last[key] = value;
    if (html) el.innerHTML = value;
    else el.textContent = value;
  }

  /** Called every real frame. */
  update(s) {
    this.set('speed', this.el.speed, `${Math.round(s.speed * 3.6)} km/h`);

    const pct = Math.round(s.meter * 100);
    if (this._last.meter !== pct) {
      this._last.meter = pct;
      this.el.meterFill.style.width = `${pct}%`;
    }
    this.el.meterWrap.classList.toggle('is-low', s.meter < Config.nail.meterMinToActivate);
    this.el.meterWrap.classList.toggle('is-active', s.trickActive);

    this.root.classList.toggle('is-trick', s.trickActive);

    if (s.trickActive) {
      this.set('trickName', this.el.trickName, s.trickName);
      this.set('flip', this.el.flip, `${signed(s.spin.flip)}°`);
      this.set('shuv', this.el.shuv, `${signed(s.spin.shuv)}°`);
      this.set('pitch', this.el.pitch, `${signed(s.spin.pitch)}°`);

      const bodyDeg = Math.round(s.bodySpin * 360);
      this.el.spinRow.classList.toggle('row--hidden', Math.abs(bodyDeg) < 20);
      this.set('spin', this.el.spin, `${signed(bodyDeg)}°`);

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

  /**
   * The S.K.A.T.E. call sheet. `null` hides it, which is what every other
   * mode passes, so nothing has to know this exists to not show it.
   *
   * @param {{name:string, letters:string, total:number}|null} call
   */
  setCall(call) {
    if (!call) {
      this.el.call.classList.add('is-hidden');
      this.root.classList.remove('is-skate');
      return;
    }
    this.el.call.classList.remove('is-hidden');
    // Drops the trick panel clear of the call so the two never overlap.
    this.root.classList.add('is-skate');
    this.set('callName', this.el.callName, call.name);

    // Letters taken are lit, the rest are outlines. Drawing all five always
    // is the point: what is at stake has to be visible before the attempt,
    // not revealed one at a time after it.
    const letters = call.letters || '';
    const html = SKATE_LETTERS.map(
      (ch, i) =>
        `<span class="call__letter${i < letters.length ? ' is-on' : ''}">${ch}</span>`,
    ).join('');
    this.set('callLetters', this.el.callLetters, html, true);
  }

  /**
   * The tutorial's current instruction. `null` hides it.
   * @param {{title:string, body:string, step:number, total:number}|null} lesson
   */
  setLesson(lesson) {
    if (!lesson) {
      this.el.lesson.classList.add('is-hidden');
      return;
    }
    this.el.lesson.classList.remove('is-hidden');
    this.set('lessonStep', this.el.lessonStep, `${lesson.step} / ${lesson.total}`);
    this.set('lessonTitle', this.el.lessonTitle, lesson.title);
    // The lesson copy carries <b> around the bits that name a part of the
    // board, which is the half of the sentence that actually matters.
    this.set('lessonBody', this.el.lessonBody, lesson.body, true);
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

/**
 * Where the splash art lives. The only two files in the project that are not
 * generated at runtime, so they come from `public/` — via the bundler's base so
 * the game still works when it is served from a sub-path.
 */
const BASE = import.meta.env?.BASE_URL ?? '/';

const SKATE_LETTERS = ['S', 'K', 'A', 'T', 'E'];

const TEMPLATE = /* html */ `
<button class="menu-btn js-menu-btn" type="button">
  <span class="menu-btn__bars"><i></i><i></i><i></i></span>
  <span>MENU</span>
</button>

<div class="hud__corner hud__corner--br">
  <div class="speed js-speed">0 km/h</div>
</div>

<!-- Only ever shown in a game of S.K.A.T.E. The called trick has to be legible
     while the rider is still rolling up to the pop, because deciding how to
     produce it is most of the thinking. -->
<div class="call js-call is-hidden">
  <div class="call__k">LAND A</div>
  <div class="call__name js-call-name"></div>
  <div class="call__letters js-call-letters"></div>
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
    </div>
    <div class="quality__label js-quality-label">LANDABLE</div>
  </div>
  <div class="quality__track"><div class="quality__fill js-quality-fill"></div></div>
</div>

<!-- The tutorial's instruction. Bottom centre, where it is readable without
     covering the deck the lesson is about. -->
<div class="lesson js-lesson is-hidden">
  <div class="lesson__step js-lesson-step"></div>
  <div class="lesson__title js-lesson-title"></div>
  <div class="lesson__body js-lesson-body"></div>
</div>

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
        <p>Carve as you pop and you carry the turn into the air: that is your <b>180</b> or <b>360</b>.</p>
        <p>Keyboard: <b>W A S D</b> is one finger, <b>arrow keys</b> the other. <b>Q</b> / <b>&#47;</b> plant a finger without moving it.</p>
      </div>
    </div>
    <p class="panel__foot"><b>H</b> controls &nbsp;&middot;&nbsp; <b>R</b> restart run &nbsp;&middot;&nbsp; <b>M</b> mute</p>
  </div>
</div>

<div class="overlay overlay--splash js-start">
  <picture class="splash__art">
    <source media="(max-aspect-ratio: 1/1)" srcset="${BASE}splash-portrait.webp" type="image/webp" />
    <source media="(max-aspect-ratio: 1/1)" srcset="${BASE}splash-portrait.jpg" type="image/jpeg" />
    <source srcset="${BASE}splash.webp" type="image/webp" />
    <img class="js-splash-img" src="${BASE}splash.jpg" alt="Finger Flip" decoding="async" />
  </picture>
  <div class="splash__prompt">
    <div class="splash__tap">TAP TO ENTER</div>
    <div class="splash__sub">or press any key &nbsp;&middot;&nbsp; H for controls</div>
  </div>
</div>
`;
