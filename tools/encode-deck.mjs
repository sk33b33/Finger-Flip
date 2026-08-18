/**
 * Re-encodes the deck artwork for the web, and measures the deck it draws.
 *
 * The two source PNGs are ~2.5MB each and carry three things the game needs:
 * the grip face, the graphic face, and — implicitly — the SHAPE of the board
 * they are painted on. The third one matters as much as the other two. A
 * rectangular bitmap only sits on a parametric deck without stretching or
 * transparent notches if the deck's outline is the one in the picture, and the
 * trucks only look right if they sit under the bolt holes that are painted on.
 *
 * So this prints the measurements as well as writing the images, and the
 * constants it prints are pasted into view/BoardMesh.js.
 *
 *   node tools/encode-deck.mjs [grip.png] [graphic.png]
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const UPLOADS = '/root/.claude/uploads/b81e52e3-b579-5dff-a737-e8febe7c27f7';
const SOURCES = [
  { name: 'deck-grip', file: process.argv[2] || `${UPLOADS}/e5c11aa5-1000239406.png`, long: 768 },
  { name: 'deck-art', file: process.argv[3] || `${UPLOADS}/9243d155-1000239407.png`, long: 1200 },
];
const OUT_DIR = 'public';
const QUALITY = 0.86;
/** Transparent margins are flattened to this, so neither format needs alpha. */
const BACKDROP = '#b98a52';
/** How many stations to report the half-width profile at. The tip closes over
 * the last few percent, so it needs resolving finely or the mesh facets there. */
const PROFILE_STOPS = 48;

fs.mkdirSync(OUT_DIR, { recursive: true });

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--no-sandbox'],
});
const page = await browser.newPage();

for (const { name, file, long } of SOURCES) {
  if (!fs.existsSync(file)) {
    console.error(`source not found, skipping ${name}: ${file}`);
    continue;
  }
  const dataUrl = `data:image/png;base64,${fs.readFileSync(file).toString('base64')}`;

  const r = await page.evaluate(
    async ({ dataUrl, long, quality, backdrop, stops }) => {
      const img = new Image();
      img.src = dataUrl;
      await img.decode();
      const W = img.naturalWidth;
      const H = img.naturalHeight;

      const probe = document.createElement('canvas');
      probe.width = W;
      probe.height = H;
      const p = probe.getContext('2d');
      p.drawImage(img, 0, 0);
      const d = p.getImageData(0, 0, W, H).data;
      const opaque = (x, y) => d[(y * W + x) * 4 + 3] > 160;

      // Where the board actually is in the frame.
      let x0 = W, x1 = -1, y0 = H, y1 = -1;
      for (let y = 0; y < H; y++)
        for (let x = 0; x < W; x++)
          if (opaque(x, y)) {
            if (x < x0) x0 = x;
            if (x > x1) x1 = x;
            if (y < y0) y0 = y;
            if (y > y1) y1 = y;
          }
      const dw = x1 - x0 + 1;
      const dh = y1 - y0 + 1;

      // Half-width down the length, as a fraction of the widest point. This is
      // the deck's outline, which the mesh has to reproduce.
      const widthAt = (y) => {
        let a = W, b = -1;
        for (let x = 0; x < W; x++) if (opaque(x, y)) { if (x < a) a = x; if (x > b) b = x; }
        return b < 0 ? 0 : b - a + 1;
      };
      let maxW = 0;
      for (let y = y0; y <= y1; y++) maxW = Math.max(maxW, widthAt(y));
      const profile = [];
      for (let i = 0; i <= stops; i++) {
        // Sample from the middle of the deck out to the tip.
        const yy = Math.round(y0 + (dh - 1) * (0.5 + 0.5 * (i / stops)));
        profile.push(+(widthAt(yy) / maxW).toFixed(4));
      }

      // Crop to the board and scale, flattening onto an opaque backdrop so
      // neither WebP nor the JPEG fallback has to carry an alpha channel.
      const scale = Math.min(1, long / dh);
      const cw = Math.round(dw * scale);
      const ch = Math.round(dh * scale);
      const c = document.createElement('canvas');
      c.width = cw;
      c.height = ch;
      const g = c.getContext('2d');
      g.fillStyle = backdrop;
      g.fillRect(0, 0, cw, ch);
      g.imageSmoothingQuality = 'high';
      g.drawImage(img, x0, y0, dw, dh, 0, 0, cw, ch);

      return {
        W, H, dw, dh, cw, ch, maxW, profile,
        webp: c.toDataURL('image/webp', quality),
        jpeg: c.toDataURL('image/jpeg', quality),
      };
    },
    { dataUrl, long, quality: QUALITY, backdrop: BACKDROP, stops: PROFILE_STOPS },
  );

  const write = (out, uri) => {
    const buf = Buffer.from(uri.slice(uri.indexOf(',') + 1), 'base64');
    fs.writeFileSync(path.join(OUT_DIR, out), buf);
    return buf.length / 1024;
  };
  const srcKb = fs.statSync(file).size / 1024;
  const webpKb = write(`${name}.webp`, r.webp);
  const jpegKb = write(`${name}.jpg`, r.jpeg);

  console.log(
    `${name.padEnd(10)} ${r.W}x${r.H} ${srcKb.toFixed(0)}KB  ->  board ${r.dw}x${r.dh} ` +
      `(aspect ${(r.dw / r.dh).toFixed(4)})  out ${r.cw}x${r.ch}  ` +
      `webp ${webpKb.toFixed(0)}KB  jpeg ${jpegKb.toFixed(0)}KB`,
  );
  console.log(`  outline, centre -> tip in ${PROFILE_STOPS} steps:`);
  console.log(`  [${r.profile.join(', ')}]`);
}

await browser.close();
