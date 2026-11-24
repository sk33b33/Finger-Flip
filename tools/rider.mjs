/**
 * Re-encodes a Mixamo character export into something shippable.
 *
 * The source is 8.4MB, of which 6.6MB is eight 1024x1024 PNG textures. The
 * whole rest of this game is 664KB, so dropped in as-is the rider would be
 * thirteen times the thing it is standing on — and it would land in the
 * service worker's precache too, turning a game that installs in under a
 * second into one that does not.
 *
 * There is still no image toolchain here, and still a headless Chromium, so
 * the same trick as tools/encode-splash.mjs: decode each texture onto a
 * canvas, draw it down, read it back as WebP.
 *
 * ## Why the sizes differ by role
 *
 * The rider is never the subject. At chase range it is a few hundred pixels
 * tall, and during the trick — the only time the camera is close — it is
 * being faded out on purpose (RiderMesh#setFade) so it does not sit between
 * you and the deck. So:
 *
 *   diffuse    the only one you actually read. Kept largest.
 *   normal     3.2MB of the source and the least visible of the three at this
 *              distance, where the lighting is broad and the silhouette does
 *              the work. Quartered.
 *   roughness  a broad mask, not detail. Quartered.
 *   specular   already tiny.
 *
 * ## WebP in a GLB
 *
 * glTF 2.0 only blesses PNG and JPEG, so WebP goes in through EXT_texture_webp:
 * each texture gets an extension pointing at the WebP image. Because the PNGs
 * are thrown away rather than kept as a fallback, the extension has to be
 * REQUIRED — a reader that does not understand it must fail loudly instead of
 * rendering an untextured mannequin. three's GLTFLoader understands it, and
 * every browser that can run WebGL 2 can decode WebP.
 *
 *   node tools/rider.mjs <input.glb> [out.glb]
 */
import { chromium } from 'playwright';
import { launchOptions } from './chrome.mjs';
import fs from 'node:fs';
import path from 'node:path';

const IN = process.argv[2];
const OUT = process.argv[3] || 'public/rider-james.glb';

if (!IN || !fs.existsSync(IN)) {
  console.error('usage: node tools/rider.mjs <input.glb> [out.glb]');
  process.exit(1);
}

/** Longest edge and quality, by what the texture is for. */
const ROLE = {
  diffuse: { size: 512, quality: 0.84 },
  normal: { size: 256, quality: 0.8 },
  glossiness: { size: 256, quality: 0.78 },
  specular: { size: 128, quality: 0.78 },
  other: { size: 256, quality: 0.8 },
};

const roleOf = (name = '') => {
  const n = name.toLowerCase();
  for (const key of Object.keys(ROLE)) if (n.includes(key)) return key;
  return 'other';
};

// ------------------------------------------------------------- read GLB ----

const src = fs.readFileSync(IN);
if (src.toString('ascii', 0, 4) !== 'glTF') throw new Error('not a GLB');
const jsonLen = src.readUInt32LE(12);
const gltf = JSON.parse(src.toString('utf8', 20, 20 + jsonLen));

// Chunk 1 is the binary blob. Its header sits straight after the JSON chunk.
const binHeader = 20 + jsonLen;
const binLen = src.readUInt32LE(binHeader);
// The chunk type is four bytes padded with NULs, and String#trim does not
// remove those — only whitespace.
if (src.toString('ascii', binHeader + 4, binHeader + 8).replace(/\0/g, '') !== 'BIN')
  throw new Error('second chunk is not BIN');
const bin = src.subarray(binHeader + 8, binHeader + 8 + binLen);

const viewBytes = (i) => {
  const v = gltf.bufferViews[i];
  const off = v.byteOffset || 0;
  return bin.subarray(off, off + v.byteLength);
};

// ---------------------------------------------------------- re-encode -----

const browser = await chromium.launch(launchOptions({ gpu: false }));
const page = await browser.newPage();

const jobs = gltf.images.map((im, i) => ({
  index: i,
  name: im.name || `image${i}`,
  role: roleOf(im.name),
  mime: im.mimeType,
  b64: viewBytes(im.bufferView).toString('base64'),
}));

const encoded = await page.evaluate(
  async ({ jobs, ROLE }) => {
    const out = [];
    for (const job of jobs) {
      const { size, quality } = ROLE[job.role];
      const img = new Image();
      img.src = `data:${job.mime};base64,${job.b64}`;
      await img.decode();

      const scale = Math.min(1, size / Math.max(img.width, img.height));
      const w = Math.max(1, Math.round(img.width * scale));
      const h = Math.max(1, Math.round(img.height * scale));
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      const g = c.getContext('2d');
      g.imageSmoothingQuality = 'high';
      g.drawImage(img, 0, 0, w, h);

      out.push({
        index: job.index,
        was: `${img.width}x${img.height}`,
        now: `${w}x${h}`,
        data: c.toDataURL('image/webp', quality),
      });
    }
    return out;
  },
  { jobs, ROLE },
);

await browser.close();

// ------------------------------------------------------------ rewrite -----

/** New bytes per image index. */
const newImage = new Map();
for (const e of encoded) newImage.set(e.index, Buffer.from(e.data.split(',')[1], 'base64'));

/**
 * Skin weights, as bytes.
 *
 * Blender writes WEIGHTS_0 as four float32s per vertex: sixteen bytes to carry
 * four numbers between 0 and 1 that are about to be multiplied by matrices and
 * averaged. It is the single largest thing in the file after the textures are
 * dealt with — bigger than the positions. glTF 2.0 allows normalized ubyte for
 * exactly this, so no extension is needed and no loader has to opt in.
 *
 * The weights per vertex must still sum to one, and rounding four values
 * independently does not guarantee that. The remainder is handed to the
 * largest weight, which is both the least visible place to put it and the one
 * already doing most of the work.
 */
const requantised = new Map(); // bufferView index -> Buffer
function quantiseWeights() {
  const seen = new Set();
  let saved = 0;
  for (const mesh of gltf.meshes) {
    for (const prim of mesh.primitives) {
      const index = prim.attributes.WEIGHTS_0;
      if (index == null || seen.has(index)) continue;
      seen.add(index);
      const acc = gltf.accessors[index];
      const view = gltf.bufferViews[acc.bufferView];
      // Only the simple case: already-packed data with its own view. An
      // interleaved or shared view cannot be rewritten in isolation.
      if (acc.componentType !== 5126 || acc.type !== 'VEC4' || view.byteStride) continue;

      const src = viewBytes(acc.bufferView);
      const out = Buffer.alloc(acc.count * 4);
      for (let v = 0; v < acc.count; v++) {
        const w = [0, 1, 2, 3].map((k) => src.readFloatLE((v * 4 + k) * 4));
        const total = w[0] + w[1] + w[2] + w[3];
        const scale = total > 0 ? 255 / total : 0;
        const q = w.map((x) => Math.round(x * scale));
        // Put the rounding error on the dominant weight.
        let big = 0;
        for (let k = 1; k < 4; k++) if (q[k] > q[big]) big = k;
        q[big] += 255 - (q[0] + q[1] + q[2] + q[3]);
        for (let k = 0; k < 4; k++) out[v * 4 + k] = Math.max(0, Math.min(255, q[k]));
      }
      requantised.set(acc.bufferView, out);
      acc.componentType = 5121; // UNSIGNED_BYTE
      acc.normalized = true;
      saved += src.length - out.length;
    }
  }
  return saved;
}
const weightSaving = quantiseWeights();

// Rebuild the binary chunk view by view, so every offset stays correct and
// nothing has to be patched in place.
const chunks = [];
let offset = 0;
const pad = (n) => (4 - (n % 4)) % 4;

const imageViewOf = new Map();
for (let i = 0; i < gltf.images.length; i++) imageViewOf.set(gltf.images[i].bufferView, i);

gltf.bufferViews.forEach((v, i) => {
  const imageIndex = imageViewOf.get(i);
  const bytes =
    imageIndex !== undefined
      ? newImage.get(imageIndex)
      : requantised.get(i) || viewBytes(i);
  v.byteOffset = offset;
  v.byteLength = bytes.length;
  chunks.push(bytes);
  offset += bytes.length;
  const p = pad(offset);
  if (p) {
    chunks.push(Buffer.alloc(p));
    offset += p;
  }
});

const newBin = Buffer.concat(chunks);
gltf.buffers[0].byteLength = newBin.length;

for (const im of gltf.images) im.mimeType = 'image/webp';

// EXT_texture_webp, required: the PNGs are gone, so a reader that cannot
// decode WebP must say so rather than draw an untextured mannequin.
gltf.extensionsUsed = [...new Set([...(gltf.extensionsUsed || []), 'EXT_texture_webp'])];
gltf.extensionsRequired = [...new Set([...(gltf.extensionsRequired || []), 'EXT_texture_webp'])];
for (const t of gltf.textures) {
  t.extensions = { ...(t.extensions || {}), EXT_texture_webp: { source: t.source } };
  delete t.source;
}

let jsonText = JSON.stringify(gltf);
jsonText += ' '.repeat(pad(Buffer.byteLength(jsonText)));
const jsonBuf = Buffer.from(jsonText, 'utf8');

const header = Buffer.alloc(12);
header.write('glTF', 0, 'ascii');
header.writeUInt32LE(2, 4);
header.writeUInt32LE(12 + 8 + jsonBuf.length + 8 + newBin.length, 8);

const jsonChunk = Buffer.alloc(8);
jsonChunk.writeUInt32LE(jsonBuf.length, 0);
jsonChunk.write('JSON', 4, 'ascii');

const binChunk = Buffer.alloc(8);
binChunk.writeUInt32LE(newBin.length, 0);
binChunk.write('BIN\0', 4, 'ascii');

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, Buffer.concat([header, jsonChunk, jsonBuf, binChunk, newBin]));

// -------------------------------------------------------------- report ----

console.log('textures:');
for (const e of encoded) {
  const before = viewBytes(gltf.images[e.index].bufferView).length; // now the NEW length
  console.log(
    `  ${jobs[e.index].name.padEnd(26)} ${jobs[e.index].role.padEnd(11)} ` +
      `${e.was.padEnd(10)} -> ${e.now.padEnd(10)} ${(newImage.get(e.index).length / 1024).toFixed(0)}KB`,
  );
}
console.log(`\nskin weights: float32 -> normalized ubyte, ${(weightSaving / 1024).toFixed(0)}KB saved`);

const a = fs.statSync(IN).size;
const b = fs.statSync(OUT).size;
console.log(
  `\n${IN}\n  ${(a / 1048576).toFixed(2)}MB  ->  ${OUT}\n  ${(b / 1048576).toFixed(2)}MB ` +
    `(${(100 - (b / a) * 100).toFixed(0)}% smaller)`,
);
