/**
 * Installing the game, and the service worker that makes it worth installing.
 *
 * The reason this exists is not tidiness. The trick camera is FITTED to the
 * viewport — fitToViewport() sizes the shot so the deck's width fills a set
 * fraction of the frame, because the flick window is measured in real screen
 * pixels. A mobile browser spends 12-15% of a phone's height on its address bar
 * and toolbar. Installed, the game gets that back, and the deck you are
 * flicking is physically bigger under your finger. It is a gameplay change that
 * happens to look like a platform feature.
 *
 * Two thirds of this file is the fact that there is no one way to install a web
 * app. Chrome fires `beforeinstallprompt` and hands you a prompt you can call
 * later from a gesture. Safari fires nothing, ever, and the user has to go
 * through the share sheet — so the only honest thing to do there is say so.
 * Everything else gets the same treatment as Safari.
 */

const STANDALONE = '(display-mode: standalone), (display-mode: fullscreen), (display-mode: minimal-ui)';

/** True when the page is already running as an installed app. */
export function isInstalled(win = globalThis) {
  if (!win || typeof win.matchMedia !== 'function') return false;
  // navigator.standalone is the iOS one, and it is the ONLY signal there.
  if (win.navigator && win.navigator.standalone === true) return true;
  try {
    return win.matchMedia(STANDALONE).matches;
  } catch {
    return false;
  }
}

/** iOS, where installing is a share-sheet errand rather than a button. */
export function isIOS(nav = globalThis.navigator) {
  if (!nav) return false;
  const ua = nav.userAgent || '';
  // iPadOS reports itself as a Mac, and is told apart by having a touchscreen.
  return /iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && nav.maxTouchPoints > 1);
}

export default class Install {
  constructor(win = globalThis) {
    this.win = win;
    this.deferred = null;
    this.installed = isInstalled(win);
    this.listeners = [];
    this.dismissed = false;

    if (!win || typeof win.addEventListener !== 'function') return;

    win.addEventListener('beforeinstallprompt', (e) => {
      // The default is a browser-chosen banner at a browser-chosen moment,
      // which here means over the top of somebody mid-trick.
      e.preventDefault();
      this.deferred = e;
      this.dismissed = false;
      this.changed();
    });

    win.addEventListener('appinstalled', () => {
      this.deferred = null;
      this.installed = true;
      this.changed();
    });

    // Installing does not reload the tab it was installed from, but launching
    // the installed copy does change the display mode, so this keeps a menu
    // opened in either one telling the truth.
    try {
      const mq = win.matchMedia(STANDALONE);
      const onChange = () => {
        this.installed = isInstalled(win);
        this.changed();
      };
      mq.addEventListener ? mq.addEventListener('change', onChange) : mq.addListener(onChange);
    } catch {
      /* matchMedia without listener support: the initial read still stands. */
    }
  }

  /** @param {() => void} fn */
  onChange(fn) {
    this.listeners.push(fn);
    return this;
  }

  changed() {
    for (const fn of this.listeners) fn();
  }

  /**
   * What the menu needs to draw a row, and nothing it does not.
   * @returns {{installed: boolean, promptable: boolean, manual: boolean}}
   */
  snapshot() {
    return {
      installed: this.installed,
      promptable: !this.installed && !!this.deferred,
      // Nothing to click, but something to tell them.
      manual: !this.installed && !this.deferred && isIOS(this.win.navigator),
    };
  }

  /**
   * Show the browser's install dialog. Must be called from inside a user
   * gesture, and the prompt is single-use: once it has been answered it is
   * spent, whichever way it was answered.
   */
  async prompt() {
    const e = this.deferred;
    if (!e) return 'unavailable';
    this.deferred = null;
    this.changed();
    try {
      await e.prompt();
      const { outcome } = (await e.userChoice) || {};
      if (outcome !== 'accepted') this.dismissed = true;
      return outcome || 'dismissed';
    } catch {
      return 'failed';
    }
  }
}

/**
 * Register the service worker, in production only.
 *
 * Failure is not worth reporting: the game works without it, and an alert about
 * caching is a worse first impression than no offline support.
 */
export function registerServiceWorker(url = './sw.js') {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
  if (!import.meta.env?.PROD) return;
  // After load, so it is never competing with the bundle for the connection
  // the first paint is waiting on.
  addEventListener('load', () => {
    navigator.serviceWorker.register(url, { scope: './' }).catch(() => {});
  });
}
