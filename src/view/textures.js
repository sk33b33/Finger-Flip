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

/**
 * Grip tape, mapped once across the deck rather than tiled, because it carries
 * the single most important readability cue in the game: the two rails are
 * different colours.
 *
 * Mid-flip the deck is a dark rectangle at an unknown angle. One orange rail and
 * one cyan rail tell the player instantly which way it is rolled and how far it
 * still has to come round — without that, catching a kickflip is guesswork.
 *
 * U runs across the width, V along the length.
 */
export function gripTexture(w = 512, h = 1024) {
  const c = canvas(w, h);
  const g = c.getContext('2d');

  // Charcoal, not black: real grip in daylight still shows its texture.
  g.fillStyle = '#1a1d22';
  g.fillRect(0, 0, w, h);

  const rng = makeRng(7);
  const img = g.getImageData(0, 0, w, h);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = rng();
    // Sparse bright specks over the base: silicon carbide catching the light.
    const v = n > 0.978 ? 120 + n * 110 : 26 + n * 30;
    d[i] += v * 0.5;
    d[i + 1] += v * 0.5;
    d[i + 2] += v * 0.55;
  }
  g.putImageData(img, 0, 0);

  // Rail stripes. Toe side warm, heel side cool.
  const railW = w * 0.085;
  const toe = g.createLinearGradient(w - railW * 2, 0, w, 0);
  toe.addColorStop(0, 'rgba(255,93,58,0)');
  toe.addColorStop(1, 'rgba(255,110,64,0.95)');
  g.fillStyle = toe;
  g.fillRect(w - railW * 2, 0, railW * 2, h);

  const heel = g.createLinearGradient(railW * 2, 0, 0, 0);
  heel.addColorStop(0, 'rgba(58,169,255,0)');
  heel.addColorStop(1, 'rgba(80,190,255,0.95)');
  g.fillStyle = heel;
  g.fillRect(0, 0, railW * 2, h);

  // Nose marker: chevrons pointing out toward the nose tip, so the shove-it
  // half of a trick is as readable as the flip half. Canvas textures are
  // flipped on Y, so canvas-top is the nose end of the deck.
  g.strokeStyle = 'rgba(246,247,251,0.6)';
  g.lineWidth = w * 0.035;
  g.lineCap = 'round';
  for (let i = 0; i < 2; i++) {
    const y = h * (0.14 + i * 0.045);
    g.beginPath();
    g.moveTo(w * 0.28, y);
    g.lineTo(w * 0.5, y - h * 0.03);
    g.lineTo(w * 0.72, y);
    g.stroke();
  }
  // The tail gets a plain bar, so the two ends never read the same.
  g.fillStyle = 'rgba(246,247,251,0.42)';
  g.fillRect(w * 0.3, h * 0.9, w * 0.4, w * 0.035);

  return finish(c, { aniso: 16 });
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
 * Deck graphic. Original abstract artwork: a hard-edged chevron burst over a
 * two-tone field, the sort of thing a small board brand would print.
 */
export function deckGraphic(w = 512, h = 1024) {
  const c = canvas(w, h);
  const g = c.getContext('2d');

  const grad = g.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, '#12141c');
  grad.addColorStop(0.45, '#1d2233');
  grad.addColorStop(1, '#0d0f16');
  g.fillStyle = grad;
  g.fillRect(0, 0, w, h);

  // Chevron burst radiating from the centre.
  g.save();
  g.translate(w / 2, h / 2);
  const colors = ['#ff5d3a', '#ff8a3d', '#ffd23f', '#2ee6a8', '#3aa9ff'];
  for (let i = 0; i < 22; i++) {
    const a = (i / 22) * Math.PI * 2;
    g.save();
    g.rotate(a);
    g.fillStyle = colors[i % colors.length];
    g.globalAlpha = 0.5 - (i % 3) * 0.09;
    g.beginPath();
    g.moveTo(0, 0);
    g.lineTo(-46, -h);
    g.lineTo(46, -h);
    g.closePath();
    g.fill();
    g.restore();
  }
  g.restore();

  // Central band + a wordmark that is just the game's own name.
  g.globalAlpha = 0.92;
  g.fillStyle = '#0b0d13';
  g.fillRect(0, h * 0.42, w, h * 0.16);
  g.globalAlpha = 1;
  g.fillStyle = '#f6f7fb';
  g.font = `700 ${Math.round(w * 0.15)}px system-ui, -apple-system, sans-serif`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.letterSpacing = '6px';
  g.fillText('FINGER', w / 2, h * 0.47);
  g.fillStyle = '#ff5d3a';
  g.fillText('FLIP', w / 2, h * 0.535);

  return finish(c);
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
