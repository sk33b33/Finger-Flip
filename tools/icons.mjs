/**
 * Draws the app icons for the installed game.
 *
 * Same trick as tools/encode-splash.mjs: there is no image toolchain in this
 * environment, but there is a headless Chromium, and a canvas is a perfectly
 * good drawing surface and PNG encoder.
 *
 * The deck is not a rounded rectangle here. The silhouette is read straight out
 * of view/BoardMesh.js — the same measured half-width table the mesh is built
 * from — so the icon on the home screen is the shape of the board in the game,
 * and it cannot drift away from it without this tool being re-run.
 *
 * Two sets come out:
 *   icon-*.png            the deck framed with air around it, for anywhere the
 *                         icon is shown as drawn
 *   icon-maskable-*.png   the same art pulled in to 60% so it survives the
 *                         circle Android crops it to, on a field that runs to
 *                         the edges because the corners will be cut off anyway
 *
 * plus apple-touch-icon.png, which iOS rounds itself and shows on an opaque
 * field, so it gets no transparency and no corner radius of its own.
 *
 *   node tools/icons.mjs
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const OUT_DIR = 'public/icons';

/** Pull the measured outline out of the mesh, rather than keeping a second copy. */
function readOutline(file = 'src/view/BoardMesh.js') {
  const src = fs.readFileSync(file, 'utf8');
  const m = src.match(/const OUTLINE = \[([\s\S]*?)\];/);
  if (!m) throw new Error(`no OUTLINE table in ${file}`);
  const nums = m[1].split(',').map((s) => Number(s.trim())).filter((n) => Number.isFinite(n));
  if (nums.length < 8) throw new Error(`OUTLINE in ${file} parsed to ${nums.length} entries`);
  return nums;
}

const TARGETS = [
  { file: 'icon-192.png', size: 192, fill: 0.9, rounded: true, alpha: true },
  { file: 'icon-512.png', size: 512, fill: 0.9, rounded: true, alpha: true },
  // 60%, not the 80% the safe zone allows: the deck is drawn on the diagonal,
  // so its bounding box is mostly empty and fitting the box to the circle would
  // leave the board itself looking lost in the middle of it.
  { file: 'icon-maskable-192.png', size: 192, fill: 0.6, rounded: false, alpha: false },
  { file: 'icon-maskable-512.png', size: 512, fill: 0.6, rounded: false, alpha: false },
  { file: 'apple-touch-icon.png', size: 180, fill: 0.86, rounded: false, alpha: false },
];

fs.mkdirSync(OUT_DIR, { recursive: true });

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--no-sandbox'],
});
const page = await browser.newPage();

const written = await page.evaluate(
  async ({ outline, targets }) => {
    const DECK = '#d7f23a';
    const BACK = '#0b0e14';
    const HOLE = '#0b0e14';
    /** Deck length as a multiple of its width, from Config.board (0.82 / 0.205). */
    const ASPECT = 4;
    // The bolt pattern is a real, standardised thing: 41mm across by 54mm
    // along. On a 205 x 820 deck centred at 53.5% that is these numbers, as
    // fractions of the half-width and the half-length.
    const BOLTS_ALONG = [0.469, 0.601];
    const BOLTS_ACROSS = 0.2;
    const TILT = (-38 * Math.PI) / 180;
    /** Draw this many times over and scale down: curves this tight alias badly. */
    const SS = 4;

    // The table's LAST entry is the mesh closing its end cap — it drops the
    // half-width from 0.40 to 0.03 in a single step, and traced literally that
    // comes out as a spike off the nose. The tip is rounded by the stroke in
    // deckPath instead, so this stops one entry short.
    const TOP = outline.length - 2;
    const halfWidth = (u) => {
      const a = Math.min(1, Math.abs(u)) * TOP;
      const i = Math.min(TOP - 1, Math.floor(a));
      return outline[i] + (outline[i + 1] - outline[i]) * (a - i);
    };

    /**
     * The deck outline as a path, length along y, centred on the origin.
     *
     * Drawn inset by `pad` and stroked back out to full width with round joins
     * and caps, which is what gives the nose and tail the radius they have on a
     * real deck without a second table describing it.
     */
    function deckPath(ctx, halfLen, halfWide) {
      const STEPS = 240;
      const pad = halfWide * 0.3;
      const inner = halfWide - pad;
      ctx.beginPath();
      for (let i = 0; i <= STEPS; i++) {
        const u = -1 + (2 * i) / STEPS;
        i === 0
          ? ctx.moveTo(halfWidth(u) * inner, u * halfLen)
          : ctx.lineTo(halfWidth(u) * inner, u * halfLen);
      }
      for (let i = STEPS; i >= 0; i--) {
        const u = -1 + (2 * i) / STEPS;
        ctx.lineTo(-halfWidth(u) * inner, u * halfLen);
      }
      ctx.closePath();
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.lineWidth = pad * 2;
    }

    function roundRect(ctx, s, r) {
      ctx.beginPath();
      ctx.moveTo(r, 0);
      ctx.arcTo(s, 0, s, s, r);
      ctx.arcTo(s, s, 0, s, r);
      ctx.arcTo(0, s, 0, 0, r);
      ctx.arcTo(0, 0, s, 0, r);
      ctx.closePath();
    }

    function draw(size, fill, rounded, alpha) {
      const S = size * SS;
      const big = document.createElement('canvas');
      big.width = big.height = S;
      const ctx = big.getContext('2d');

      // --- field ---
      if (!alpha || !rounded) {
        ctx.fillStyle = BACK;
        ctx.fillRect(0, 0, S, S);
      } else {
        ctx.save();
        roundRect(ctx, S, S * 0.22);
        ctx.clip();
        ctx.fillStyle = BACK;
        ctx.fillRect(0, 0, S, S);
      }
      // A soft lift behind the board, so it does not read as flat black.
      const g = ctx.createRadialGradient(S * 0.5, S * 0.42, 0, S * 0.5, S * 0.42, S * 0.72);
      g.addColorStop(0, 'rgba(120,160,255,0.20)');
      g.addColorStop(1, 'rgba(120,160,255,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, S, S);
      if (alpha && rounded) ctx.restore();

      // --- deck ---
      // Tilted, so it is sized by the diagonal of the box it has to fit in.
      const span = S * fill;
      const halfLen = span / 2 / (Math.abs(Math.sin(TILT)) + Math.abs(Math.cos(TILT)) / ASPECT);
      const halfWide = halfLen / ASPECT;

      ctx.save();
      ctx.translate(S / 2, S / 2);
      ctx.rotate(TILT);

      deckPath(ctx, halfLen, halfWide);
      ctx.fillStyle = DECK;
      ctx.strokeStyle = DECK;
      ctx.stroke();
      ctx.fill();

      // Bolts, punched rather than drawn over, so they read at 48px too.
      const r = halfWide * 0.15;
      ctx.fillStyle = HOLE;
      for (const along of BOLTS_ALONG) {
        for (const end of [-1, 1]) {
          for (const side of [-1, 1]) {
            ctx.beginPath();
            ctx.arc(side * halfWide * BOLTS_ACROSS, end * along * halfLen, r, 0, Math.PI * 2);
            ctx.fill();
          }
        }
      }
      ctx.restore();

      const out = document.createElement('canvas');
      out.width = out.height = size;
      const octx = out.getContext('2d');
      octx.imageSmoothingQuality = 'high';
      octx.drawImage(big, 0, 0, size, size);
      return out.toDataURL('image/png');
    }

    return targets.map((t) => ({
      file: t.file,
      data: draw(t.size, t.fill, t.rounded, t.alpha),
    }));
  },
  { outline: readOutline(), targets: TARGETS },
);

for (const { file, data } of written) {
  const buf = Buffer.from(data.split(',')[1], 'base64');
  const out = path.join(OUT_DIR, file);
  fs.writeFileSync(out, buf);
  console.log(`${out.padEnd(38)} ${(buf.length / 1024).toFixed(1)}KB`);
}

await browser.close();
