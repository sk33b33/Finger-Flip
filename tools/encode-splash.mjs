/**
 * Re-encodes the splash artwork for the web.
 *
 * The source is a 2.7MB PNG, which is far too heavy to hold up a first paint on
 * a phone. There is no sharp, ffmpeg or ImageMagick in this environment — but
 * there is a headless Chromium, and a browser is a perfectly good image encoder.
 * Load the source into a canvas, draw it down to a sane width, and read it back
 * out as WebP, with a JPEG alongside for anything that cannot take WebP.
 *
 *   node tools/encode-splash.mjs <source.png>
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const SOURCE = process.argv[2] ||
  '/root/.claude/uploads/b81e52e3-b579-5dff-a737-e8febe7c27f7/4cd900c1-1000239054.png';
const OUT_DIR = 'public';
const MAX_WIDTH = 1400;
const QUALITY = 0.82;

if (!fs.existsSync(SOURCE)) {
  console.error(`source not found: ${SOURCE}`);
  process.exit(1);
}
fs.mkdirSync(OUT_DIR, { recursive: true });

const dataUrl = `data:image/png;base64,${fs.readFileSync(SOURCE).toString('base64')}`;

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--no-sandbox'],
});
const page = await browser.newPage();

const encoded = await page.evaluate(
  async ({ dataUrl, maxWidth, quality }) => {
    const img = new Image();
    img.src = dataUrl;
    await img.decode();

    const scale = Math.min(1, maxWidth / img.naturalWidth);
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
  { dataUrl, maxWidth: MAX_WIDTH, quality: QUALITY },
);

await browser.close();

const write = (name, dataUri) => {
  const base64 = dataUri.slice(dataUri.indexOf(',') + 1);
  const buf = Buffer.from(base64, 'base64');
  fs.writeFileSync(path.join(OUT_DIR, name), buf);
  return buf.length;
};

const srcKb = fs.statSync(SOURCE).size / 1024;
const webpKb = write('splash.webp', encoded.webp) / 1024;
const jpegKb = write('splash.jpg', encoded.jpeg) / 1024;

console.log(`source  ${encoded.sourceW}x${encoded.sourceH}  ${srcKb.toFixed(0)}KB`);
console.log(`webp    ${encoded.w}x${encoded.h}  ${webpKb.toFixed(0)}KB`);
console.log(`jpeg    ${encoded.w}x${encoded.h}  ${jpegKb.toFixed(0)}KB`);
