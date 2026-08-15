/**
 * Raw device input. Deliberately knows nothing about skateboards.
 *
 * Exposes a normalised pointer set (multi-touch, mouse and pen all land in the
 * same table) plus a key table. Everything is sampled in real time; the higher
 * layers decide what a pointer means.
 *
 * Pointer coordinates are NDC: x in [-1, 1] right-positive, y in [-1, 1]
 * up-positive. Velocities are NDC units per real second.
 */
export default class Input {
  constructor(domElement) {
    this.el = domElement;
    this.pointers = new Map();
    this.keys = new Set();
    this.keysPressed = new Set(); // cleared every frame
    this.keysReleased = new Set();
    this._pending = [];
    this.enabled = true;

    this._onPointerDown = this._onPointerDown.bind(this);
    this._onPointerMove = this._onPointerMove.bind(this);
    this._onPointerUp = this._onPointerUp.bind(this);
    this._onKeyDown = this._onKeyDown.bind(this);
    this._onKeyUp = this._onKeyUp.bind(this);
    this._onBlur = this._onBlur.bind(this);

    const el = this.el;
    el.addEventListener('pointerdown', this._onPointerDown, { passive: false });
    el.addEventListener('pointermove', this._onPointerMove, { passive: false });
    window.addEventListener('pointerup', this._onPointerUp, { passive: false });
    window.addEventListener('pointercancel', this._onPointerUp, { passive: false });
    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('keyup', this._onKeyUp);
    window.addEventListener('blur', this._onBlur);
    // Stop the browser from scrolling, zooming or showing a context menu while
    // two fingers are working the board.
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    el.style.touchAction = 'none';
  }

  _ndc(e) {
    const r = this.el.getBoundingClientRect();
    return {
      x: ((e.clientX - r.left) / r.width) * 2 - 1,
      y: -(((e.clientY - r.top) / r.height) * 2 - 1),
    };
  }

  _onPointerDown(e) {
    if (!this.enabled) return;
    e.preventDefault();
    const p = this._ndc(e);
    this.pointers.set(e.pointerId, {
      id: e.pointerId,
      x: p.x,
      y: p.y,
      startX: p.x,
      startY: p.y,
      prevX: p.x,
      prevY: p.y,
      vx: 0,
      vy: 0,
      down: true,
      justDown: true,
      justUp: false,
      age: 0,
      owner: null, // claimed by a consumer (e.g. 'nose' / 'tail')
    });
    if (this.el.setPointerCapture) {
      try {
        this.el.setPointerCapture(e.pointerId);
      } catch {
        /* capture is best-effort */
      }
    }
  }

  _onPointerMove(e) {
    const ptr = this.pointers.get(e.pointerId);
    if (!ptr) return;
    e.preventDefault();
    // Coalesced events give sub-frame precision on high-rate touch panels, which
    // matters a lot for reading the speed of a flick.
    const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
    const last = events[events.length - 1] || e;
    const p = this._ndc(last);
    ptr.x = p.x;
    ptr.y = p.y;
  }

  _onPointerUp(e) {
    const ptr = this.pointers.get(e.pointerId);
    if (!ptr) return;
    ptr.down = false;
    ptr.justUp = true;
  }

  _onKeyDown(e) {
    if (e.repeat) return;
    const c = e.code;
    if (!this.keys.has(c)) this.keysPressed.add(c);
    this.keys.add(c);
    if (KEY_SWALLOW.has(c)) e.preventDefault();
  }

  _onKeyUp(e) {
    this.keys.delete(e.code);
    this.keysReleased.add(e.code);
  }

  _onBlur() {
    this.keys.clear();
    for (const p of this.pointers.values()) {
      p.down = false;
      p.justUp = true;
    }
  }

  down(code) {
    return this.keys.has(code);
  }

  pressed(code) {
    return this.keysPressed.has(code);
  }

  released(code) {
    return this.keysReleased.has(code);
  }

  /** Any of the supplied codes held. */
  anyDown(...codes) {
    for (const c of codes) if (this.keys.has(c)) return true;
    return false;
  }

  /** Call once per real frame, before consumers read pointers. */
  update(realDelta) {
    const inv = realDelta > 1e-5 ? 1 / realDelta : 0;
    for (const p of this.pointers.values()) {
      p.vx = (p.x - p.prevX) * inv;
      p.vy = (p.y - p.prevY) * inv;
      p.prevX = p.x;
      p.prevY = p.y;
      p.age += realDelta;
    }
  }

  /** Call once per real frame, after consumers read pointers. */
  endFrame() {
    this.keysPressed.clear();
    this.keysReleased.clear();
    for (const [id, p] of this.pointers) {
      p.justDown = false;
      if (p.justUp) this.pointers.delete(id);
    }
  }

  /** Number of pointers currently touching. */
  get touchCount() {
    let n = 0;
    for (const p of this.pointers.values()) if (p.down) n++;
    return n;
  }

  dispose() {
    window.removeEventListener('pointerup', this._onPointerUp);
    window.removeEventListener('pointercancel', this._onPointerUp);
    window.removeEventListener('keydown', this._onKeyDown);
    window.removeEventListener('keyup', this._onKeyUp);
    window.removeEventListener('blur', this._onBlur);
  }
}

const KEY_SWALLOW = new Set([
  'Space',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'KeyW',
  'KeyA',
  'KeyS',
  'KeyD',
  'Tab',
]);
