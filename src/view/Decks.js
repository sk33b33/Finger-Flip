import { CanvasTexture, ClampToEdgeWrapping, SRGBColorSpace, LinearFilter } from 'three';

/**
 * Deck graphics, drawn rather than downloaded.
 *
 * The default deck is the imported artwork in public/. Everything else here is
 * generated on a canvas at runtime, same as every other texture in the project
 * — which is what makes a set of unlockable boards cost kilobytes of code
 * rather than megabytes of art.
 *
 * The UV layout they have to match is the one in view/BoardMesh.js: planar,
 * running the length of the deck, with v from tail (0) to nose (1) and u across
 * it. So these draw TALL — a portrait canvas, nose at the top — and every
 * design is composed about the long axis.
 *
 * None of them is the grip side. The grip is black and gritty on every board
 * ever made, and the one in public/ already is.
 */

const W = 384;
const H = 1536;

/** @typedef {{id:string, name:string, blurb:string, draw:(g:CanvasRenderingContext2D)=>void}} DeckDesign */

/**
 * The stock deck: the imported artwork, not a drawing.
 * `draw: null` means BoardMesh keeps the texture it loaded.
 */
export const STOCK = 'stock';

/** @type {DeckDesign[]} */
export const DECKS = [
  {
    id: STOCK,
    name: 'Finger Flip',
    blurb: 'The one it comes with.',
    draw: null,
  },

  {
    id: 'acid',
    name: 'Acid Drop',
    blurb: 'A gradient and one stripe. It does not need to be more than that.',
    draw: (g) => {
      const grad = g.createLinearGradient(0, 0, W, H);
      grad.addColorStop(0, '#d7f23a');
      grad.addColorStop(0.55, '#36c98a');
      grad.addColorStop(1, '#0d2b4a');
      g.fillStyle = grad;
      g.fillRect(0, 0, W, H);

      g.fillStyle = 'rgba(9, 11, 16, 0.9)';
      g.fillRect(W * 0.42, 0, W * 0.16, H);

      g.fillStyle = 'rgba(255, 255, 255, 0.85)';
      g.fillRect(W * 0.46, H * 0.06, W * 0.08, H * 0.88);
    },
  },

  {
    id: 'grid',
    name: 'Blueprint',
    blurb: 'Drawn to the measurements the mesh is built from.',
    draw: (g) => {
      g.fillStyle = '#0d2342';
      g.fillRect(0, 0, W, H);

      g.strokeStyle = 'rgba(150, 200, 255, 0.30)';
      g.lineWidth = 2;
      const step = W / 8;
      for (let x = 0; x <= W; x += step) line(g, x, 0, x, H);
      for (let y = 0; y <= H; y += step) line(g, 0, y, W, y);

      // The truck centres, at the measured 23.2% and 75.8%.
      g.strokeStyle = 'rgba(255, 255, 255, 0.85)';
      g.lineWidth = 5;
      for (const at of [0.232, 0.758]) {
        line(g, 0, H * at, W, H * at);
        circle(g, W / 2, H * at, W * 0.12);
      }

      g.strokeStyle = 'rgba(215, 242, 58, 0.9)';
      g.lineWidth = 4;
      line(g, W / 2, 0, W / 2, H);
    },
  },

  {
    id: 'flare',
    name: 'Sunstrike',
    blurb: 'Rays off the nose. Reads from the chase camera, which is the test.',
    draw: (g) => {
      g.fillStyle = '#17060c';
      g.fillRect(0, 0, W, H);

      const cx = W / 2;
      const cy = H * 0.78;
      const RAYS = 18;
      for (let i = 0; i < RAYS; i++) {
        if (i % 2) continue;
        g.fillStyle = i % 4 === 0 ? '#ff6a3d' : '#ffb03a';
        g.beginPath();
        g.moveTo(cx, cy);
        const a0 = (i / RAYS) * Math.PI * 2;
        const a1 = ((i + 1) / RAYS) * Math.PI * 2;
        g.lineTo(cx + Math.cos(a0) * H, cy + Math.sin(a0) * H);
        g.lineTo(cx + Math.cos(a1) * H, cy + Math.sin(a1) * H);
        g.closePath();
        g.fill();
      }

      const glow = g.createRadialGradient(cx, cy, 0, cx, cy, W * 0.6);
      glow.addColorStop(0, 'rgba(255, 240, 200, 1)');
      glow.addColorStop(0.5, 'rgba(255, 150, 60, 0.5)');
      glow.addColorStop(1, 'rgba(255, 110, 40, 0)');
      g.fillStyle = glow;
      g.fillRect(0, 0, W, H);
    },
  },

  {
    id: 'mono',
    name: 'Letters',
    blurb: 'Five of them. You know which five.',
    draw: (g) => {
      g.fillStyle = '#f2f1ec';
      g.fillRect(0, 0, W, H);
      g.fillStyle = '#121318';
      g.fillRect(0, H * 0.04, W, H * 0.92);

      g.fillStyle = '#f2f1ec';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      const letters = ['S', 'K', 'A', 'T', 'E'];
      g.font = `700 ${Math.round(W * 0.52)}px ui-sans-serif, system-ui, sans-serif`;
      letters.forEach((ch, i) => {
        const y = H * (0.16 + (i / (letters.length - 1)) * 0.68);
        g.fillText(ch, W / 2, y);
      });

      // Rules top and tail rather than through the middle: a stripe across
      // the centre lands on the A and reads as crossing it out.
      g.strokeStyle = '#ff5d3a';
      g.lineWidth = 7;
      line(g, W * 0.12, H * 0.1, W * 0.88, H * 0.1);
      line(g, W * 0.12, H * 0.9, W * 0.88, H * 0.9);
    },
  },
];

const BY_ID = new Map(DECKS.map((d) => [d.id, d]));

export function findDeck(id) {
  return BY_ID.get(id) || BY_ID.get(STOCK);
}

/** Just what the picker needs. */
export function listDecks() {
  return DECKS.map(({ id, name, blurb }) => ({ id, name, blurb }));
}

const _cache = new Map();

/**
 * The graphic for a deck, or null for the stock one (whose texture is the
 * imported file BoardMesh already holds).
 *
 * Cached: a player flicking through the picker should not be re-rasterising a
 * 384x1536 canvas every time, and these never change once drawn.
 *
 * @returns {CanvasTexture|null}
 */
export function deckGraphic(id) {
  const design = findDeck(id);
  if (!design.draw) return null;
  if (_cache.has(design.id)) return _cache.get(design.id);

  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d');
  design.draw(g);

  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  // Same as the imported art: the graphic is cropped to the board, so anything
  // sampled past the edge is a rounding error and should keep the edge rather
  // than wrap the far side around onto it.
  t.wrapS = ClampToEdgeWrapping;
  t.wrapT = ClampToEdgeWrapping;
  t.anisotropy = 8;
  t.minFilter = LinearFilter;
  t.needsUpdate = true;
  _cache.set(design.id, t);
  return t;
}

function line(g, x0, y0, x1, y1) {
  g.beginPath();
  g.moveTo(x0, y0);
  g.lineTo(x1, y1);
  g.stroke();
}

function circle(g, x, y, r) {
  g.beginPath();
  g.arc(x, y, r, 0, Math.PI * 2);
  g.stroke();
}
