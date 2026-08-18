import { CanvasTexture, RepeatWrapping, SRGBColorSpace, LinearFilter } from 'three';

/**
 * Procedural textures. Everything the game draws is generated at runtime, so
 * there are no asset files and nothing is borrowed from anywhere.
 */

function canvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

function finish(c, { srgb = true, repeat = null, aniso = 8 } = {}) {
  const t = new CanvasTexture(c);
  if (srgb) t.colorSpace = SRGBColorSpace;
  if (repeat) {
    t.wrapS = t.wrapT = RepeatWrapping;
    t.repeat.set(repeat[0], repeat[1]);
  }
  t.anisotropy = aniso;
  t.minFilter = LinearFilter;
  t.needsUpdate = true;
  return t;
}

/** Value noise, seeded, so every run looks the same. */
function makeRng(seed) {
  let s = seed >>> 0;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) % 100000) / 100000;
  };
}

/** Matching roughness map so the grit catches light unevenly. */
export function gripRoughness(size = 256) {
  const c = canvas(size, size);
  const g = c.getContext('2d');
  const rng = makeRng(19);
  const img = g.createImageData(size, size);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const v = 210 + rng() * 45;
    d[i] = d[i + 1] = d[i + 2] = v;
    d[i + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  return finish(c, { srgb: false, repeat: [4, 10] });
}

/** Seven-ply maple, seen on the cut edge of the deck. */
export function plyTexture(w = 64, h = 256) {
  const c = canvas(w, h);
  const g = c.getContext('2d');
  const plies = 7;
  for (let i = 0; i < plies; i++) {
    // Alternating stained plies, the classic look of a cut deck edge.
    const dark = i % 2 === 1;
    g.fillStyle = dark ? '#5d3a24' : '#e0c095';
    g.fillRect(0, (i * h) / plies, w, h / plies + 1);
  }
  // Grain streaks along the ply.
  const rng = makeRng(41);
  g.globalAlpha = 0.16;
  for (let i = 0; i < 260; i++) {
    g.fillStyle = rng() > 0.5 ? '#2c1a10' : '#fff2d8';
    g.fillRect(rng() * w, rng() * h, 1 + rng() * 3, 1);
  }
  g.globalAlpha = 1;
  return finish(c, { repeat: [1, 6] });
}

/**
 * Wood for the ramps: planks running up the ramp, with grain, per-plank colour
 * variation and darker seams between them.
 *
 * V runs along +Z, which on every feature in this park is the direction you
 * ride, so the planks run up the ramp the way a built one would.
 */
export function woodTexture(size = 1024) {
  const c = canvas(size, size);
  const g = c.getContext('2d');
  const rng = makeRng(613);

  const PLANKS = 8;
  const plankW = size / PLANKS;

  for (let i = 0; i < PLANKS; i++) {
    // Each plank is cut from a different board, so each gets its own tone.
    const warmth = rng();
    const l = 38 + warmth * 16;
    g.fillStyle = `hsl(${26 + warmth * 10}, ${34 + warmth * 12}%, ${l}%)`;
    g.fillRect(i * plankW, 0, plankW + 1, size);

    // Grain: long streaks along the plank, denser near its edges.
    g.save();
    g.beginPath();
    g.rect(i * plankW, 0, plankW, size);
    g.clip();
    for (let k = 0; k < 90; k++) {
      const x = i * plankW + rng() * plankW;
      const y0 = rng() * size;
      const len = size * (0.25 + rng() * 0.6);
      g.strokeStyle = rng() > 0.5 ? `rgba(60,36,18,${0.06 + rng() * 0.14})` : `rgba(224,186,132,${0.05 + rng() * 0.12})`;
      g.lineWidth = 1 + rng() * 2.5;
      g.beginPath();
      g.moveTo(x, y0);
      // A slight wander, so the grain is not a set of straight rules.
      g.bezierCurveTo(x + (rng() - 0.5) * 10, y0 + len * 0.33, x + (rng() - 0.5) * 10, y0 + len * 0.66, x + (rng() - 0.5) * 6, y0 + len);
      g.stroke();
    }
    // A few knots.
    if (rng() > 0.55) {
      const kx = i * plankW + plankW * (0.3 + rng() * 0.4);
      const ky = rng() * size;
      const kr = 4 + rng() * 7;
      const grd = g.createRadialGradient(kx, ky, 0, kx, ky, kr);
      grd.addColorStop(0, 'rgba(48,28,14,0.75)');
      grd.addColorStop(0.6, 'rgba(78,48,24,0.4)');
      grd.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = grd;
      g.beginPath();
      g.arc(kx, ky, kr, 0, Math.PI * 2);
      g.fill();
    }
    g.restore();

    // Seam between planks.
    g.fillStyle = 'rgba(24,14,7,0.55)';
    g.fillRect(i * plankW - 1.5, 0, 3, size);
  }

  // Worn, lighter tracks where wheels have run.
  g.globalAlpha = 0.07;
  for (let i = 0; i < 3; i++) {
    const x = size * (0.2 + i * 0.3);
    const grd = g.createLinearGradient(x - 40, 0, x + 40, 0);
    grd.addColorStop(0, 'rgba(255,226,180,0)');
    grd.addColorStop(0.5, 'rgba(255,226,180,1)');
    grd.addColorStop(1, 'rgba(255,226,180,0)');
    g.fillStyle = grd;
    g.fillRect(x - 40, 0, 80, size);
  }
  g.globalAlpha = 1;

  return finish(c, { repeat: [14, 30] });
}

/** Wood is smoother than concrete, and smoother still along the worn tracks. */
export function woodRoughness(size = 256) {
  const c = canvas(size, size);
  const g = c.getContext('2d');
  const rng = makeRng(977);
  const img = g.createImageData(size, size);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const v = 150 + rng() * 55;
    d[i] = d[i + 1] = d[i + 2] = v;
    d[i + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  return finish(c, { srgb: false, repeat: [14, 30] });
}

/** Concrete for the park floor: mottled, with faint expansion joints. */
export function concreteTexture(size = 1024) {
  const c = canvas(size, size);
  const g = c.getContext('2d');
  g.fillStyle = '#8f9096';
  g.fillRect(0, 0, size, size);

  const rng = makeRng(101);
  // Blotches of slightly different pours.
  for (let i = 0; i < 900; i++) {
    const x = rng() * size;
    const y = rng() * size;
    const r = 8 + rng() * 90;
    const v = 130 + rng() * 60;
    const grd = g.createRadialGradient(x, y, 0, x, y, r);
    grd.addColorStop(0, `rgba(${v},${v + 2},${v + 6},0.10)`);
    grd.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grd;
    g.beginPath();
    g.arc(x, y, r, 0, Math.PI * 2);
    g.fill();
  }
  // Fine aggregate speckle.
  const img = g.getImageData(0, 0, size, size);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = (rng() - 0.5) * 26;
    d[i] += n;
    d[i + 1] += n;
    d[i + 2] += n;
  }
  g.putImageData(img, 0, 0);

  // Expansion joints on a 1/4 grid.
  g.strokeStyle = 'rgba(40,42,48,0.5)';
  g.lineWidth = 3;
  for (let i = 1; i < 4; i++) {
    g.beginPath();
    g.moveTo((i * size) / 4, 0);
    g.lineTo((i * size) / 4, size);
    g.moveTo(0, (i * size) / 4);
    g.lineTo(size, (i * size) / 4);
    g.stroke();
  }
  return finish(c, { repeat: [10, 44] });
}

/**
 * Normal map for the concrete, derived from the same aggregate noise as the
 * colour so the bumps line up with the specks. Generated by finite difference
 * on a height field, which is cheap enough to do at boot and means there is
 * still no asset to download.
 */
export function concreteNormal(size = 512) {
  const rng = makeRng(101);
  const height = new Float32Array(size * size);

  // Fine per-texel tooth only. Blocky octaves tile into visible diagonal
  // scratches at the repeat this material uses, which reads as scraped ice
  // rather than concrete.
  for (let i = 0; i < height.length; i++) height[i] = rng();

  // One box-blur pass so the tooth has a grain size rather than being pure
  // per-pixel hash, which a normal map turns into noise.
  const smoothed = new Float32Array(height.length);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let sum = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          sum += height[((y + dy + size) % size) * size + ((x + dx + size) % size)];
        }
      }
      smoothed[y * size + x] = sum / 9;
    }
  }
  height.set(smoothed);

  const c = canvas(size, size);
  const g = c.getContext('2d');
  const img = g.createImageData(size, size);
  const d = img.data;
  const STRENGTH = 1.1;
  const at = (x, y) => height[((y + size) % size) * size + ((x + size) % size)];

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (at(x + 1, y) - at(x - 1, y)) * STRENGTH;
      const dy = (at(x, y + 1) - at(x, y - 1)) * STRENGTH;
      // Normalise (-dx, -dy, 1) into the 0..255 tangent-space encoding.
      const len = Math.hypot(dx, dy, 1);
      const i = (y * size + x) * 4;
      d[i] = ((-dx / len) * 0.5 + 0.5) * 255;
      d[i + 1] = ((-dy / len) * 0.5 + 0.5) * 255;
      d[i + 2] = (1 / len) * 0.5 * 255 + 127.5;
      d[i + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  return finish(c, { srgb: false, repeat: [10, 44] });
}

export function concreteRoughness(size = 512) {
  const c = canvas(size, size);
  const g = c.getContext('2d');
  const rng = makeRng(303);
  const img = g.createImageData(size, size);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const v = 175 + rng() * 60;
    d[i] = d[i + 1] = d[i + 2] = v;
    d[i + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  return finish(c, { srgb: false, repeat: [10, 44] });
}

/** Brushed metal for the trucks. */
export function truckRoughness(size = 256) {
  const c = canvas(size, size);
  const g = c.getContext('2d');
  g.fillStyle = '#666';
  g.fillRect(0, 0, size, size);
  const rng = makeRng(77);
  for (let i = 0; i < 4000; i++) {
    const y = rng() * size;
    g.strokeStyle = `rgba(255,255,255,${0.02 + rng() * 0.05})`;
    g.beginPath();
    g.moveTo(0, y);
    g.lineTo(size, y + (rng() - 0.5) * 3);
    g.stroke();
  }
  return finish(c, { srgb: false, repeat: [2, 2] });
}

/** A soft round blob used for the contact shadow and for spark sprites. */
export function radialSprite(size = 128, inner = 'rgba(255,255,255,1)') {
  const c = canvas(size, size);
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grd.addColorStop(0, inner);
  grd.addColorStop(0.4, 'rgba(255,255,255,0.35)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, size, size);
  return finish(c, { srgb: false });
}
