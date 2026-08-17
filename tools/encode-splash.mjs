/**
 * Re-encodes the splash artwork for the web.
 *
 * The sources are ~2.8MB PNGs, which are far too heavy to hold up a first paint
 * on a phone. There is no sharp, ffmpeg or ImageMagick in this environment — but
 * there is a headless Chromium, and a browser is a perfectly good image encoder.
 * Load each source into a canvas, draw it down to a sane size, and read it back
 * out as WebP, with a JPEG alongside for anything that cannot take WebP.
 *
 * Two orientations, because one crop cannot serve both. The landscape art is 3:2
 * and the portrait art 3:4; the page picks between them with a media query, so
 * an upright phone gets art composed for an upright phone rather than a slice
 * out of the middle of a wide one.
 *
 *   node tools/encode-splash.mjs [landscape.png] [portrait.png]
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const UPLOADS = '/root/.claude/uploads/b81e52e3-b579-5dff-a737-e8febe7c27f7';

const SOURCES = [
  { name: 'splash', file: process.argv[2] || `${UPLOADS}/4cd900c1-1000239054.png` },
  { name: 'splash-portrait', file: process.argv[3] || `${UPLOADS}/d758a031-1000239096.png` },
];

const OUT_DIR = 'public';
// Cap the LONG edge, so the portrait art gets the same pixel budget as the
// landscape one rather than being upscaled to match its width.
const MAX_LONG_EDGE = 1400;
const QUALITY = 0.82;

fs.mkdirSync(OUT_DIR, { recursive: true });

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--no-sandbox'],
});
const page = await browser.newPage();

for (const { name, file } of SOURCES) {
  if (!fs.existsSync(file)) {
    console.error(`source not found, skipping ${name}: ${file}`);
    continue;
  }

  const dataUrl = `data:image/png;base64,${fs.readFileSync(file).toString('base64')}`;
  const encoded = await page.evaluate(
    async ({ dataUrl, maxLongEdge, quality }) => {
      const img = new Image();
      img.src = dataUrl;
      await img.decode();

      const scale = Math.min(1, maxLongEdge / Math.max(img.naturalWidth, img.naturalHeight));
      const w = Math.round(img.naturalWidth * scale);
      const h = Math.round(img.naturalHeight * scale);

      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, 0, 0, w, h);

      return {
        w,
        h,
        sourceW: img.naturalWidth,
        sourceH: img.naturalHeight,
        webp: canvas.toDataURL('image/webp', quality),
        jpeg: canvas.toDataURL('image/jpeg', quality),
      };
    },
    { dataUrl, maxLongEdge: MAX_LONG_EDGE, quality: QUALITY },
  );

  const write = (out, dataUri) => {
    const base64 = dataUri.slice(dataUri.indexOf(',') + 1);
    const buf = Buffer.from(base64, 'base64');
    fs.writeFileSync(path.join(OUT_DIR, out), buf);
    return buf.length / 1024;
  };

  const srcKb = fs.statSync(file).size / 1024;
  const webpKb = write(`${name}.webp`, encoded.webp);
  const jpegKb = write(`${name}.jpg`, encoded.jpeg);

  const ratio = (encoded.sourceW / encoded.sourceH).toFixed(2);
  console.log(
    `${name.padEnd(16)} ${encoded.sourceW}x${encoded.sourceH} (${ratio}) ${srcKb.toFixed(0)}KB` +
      `  ->  ${encoded.w}x${encoded.h}  webp ${webpKb.toFixed(0)}KB  jpeg ${jpegKb.toFixed(0)}KB`,
  );
}

await browser.close();
