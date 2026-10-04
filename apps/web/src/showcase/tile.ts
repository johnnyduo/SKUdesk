export const TILE_W = 768;
export const TILE_H = 960;

export type TileSpec = { src: string; rank: number };

const C = { bg1: '#161916', bg2: '#0B0C0B', line: 'rgba(255,255,255,.14)', txt: '#F5F6F2', neon: '#CCFF00', teal: '#10E1FF' };
const MONO = '"JetBrains Mono", ui-monospace, Menlo, monospace';
const CASE_RATIO = 120 / 190; // width / height of the case renders in public/img/cases

function paint(c: CanvasRenderingContext2D, spec: TileSpec, img: HTMLImageElement | null) {
  const g = c.createLinearGradient(0, 0, 0, TILE_H);
  g.addColorStop(0, C.bg1); g.addColorStop(1, C.bg2);
  c.fillStyle = g; c.fillRect(0, 0, TILE_W, TILE_H);

  const glow = c.createRadialGradient(TILE_W / 2, TILE_H * 0.5, 0, TILE_W / 2, TILE_H * 0.5, TILE_W * 0.62);
  glow.addColorStop(0, 'rgba(16,225,255,.20)'); glow.addColorStop(0.6, 'rgba(204,255,0,.05)'); glow.addColorStop(1, 'rgba(0,0,0,0)');
  c.fillStyle = glow; c.fillRect(0, 0, TILE_W, TILE_H);

  // product: fit inside a 520 × 700 box, centred
  const boxW = 520, boxH = 700, cx = TILE_W / 2, cy = TILE_H * 0.53;
  const ratio = img && img.naturalWidth > 0 ? img.naturalWidth / img.naturalHeight : CASE_RATIO;
  let w = boxH * ratio, h = boxH;
  if (w > boxW) { w = boxW; h = boxW / ratio; }
  if (img && img.complete && img.naturalWidth > 0) {
    c.drawImage(img, cx - w / 2, cy - h / 2, w, h);
  } else {
    // placeholder so a failed/slow image never leaves a blank tile
    c.beginPath(); c.roundRect(cx - w / 2, cy - h / 2, w, h, 56);
    c.fillStyle = 'rgba(255,255,255,.05)'; c.fill(); c.lineWidth = 2; c.strokeStyle = C.line; c.stroke();
  }

  // rank pill
  c.beginPath(); c.roundRect(44, 44, 170, 92, 46); c.fillStyle = 'rgba(8,9,8,.75)'; c.fill();
  c.lineWidth = 2; c.strokeStyle = C.line; c.stroke();
  c.font = `700 52px ${MONO}`; c.fillStyle = C.neon; c.textAlign = 'center'; c.textBaseline = 'middle';
  c.fillText(`#${spec.rank}`, 129, 92);

  // hairline frame
  c.beginPath(); c.roundRect(1, 1, TILE_W - 2, TILE_H - 2, 40); c.lineWidth = 2; c.strokeStyle = C.line; c.stroke();
}

/** scale < 1 paints a smaller canvas (less memory and texture upload on phones); drawing code keeps using TILE_W x TILE_H units. */
export function createTile(spec: TileSpec, onChange?: () => void, scale = 1): { canvas: HTMLCanvasElement; ready: Promise<void> } {
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(TILE_W * scale); canvas.height = Math.round(TILE_H * scale);
  const c = canvas.getContext('2d')!;
  const draw = (img: HTMLImageElement | null) => { c.setTransform(scale, 0, 0, scale, 0, 0); paint(c, spec, img); };
  draw(null); // cheap placeholder, so a tile is never blank if its image is slow
  // The art is painted once, after the image settles: one texture upload per tile instead of two.
  const ready = new Promise<void>((resolve) => {
    const im = new Image(); im.decoding = 'async';
    im.onload = () => { draw(im); onChange?.(); resolve(); };
    im.onerror = () => { draw(null); onChange?.(); resolve(); };
    im.src = spec.src;
  });
  return { canvas, ready };
}
