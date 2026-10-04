// The four phones: ONE builder, the camera layout is the parameter (spec.variant). Millimetres, back (camera side) at +z, screen at -z.
// Generic silhouettes: no logos, no wordmarks. The market accent is a thin line around the frame.
import type { Ctx } from './build.ts';
import type { PhoneVariant } from './specs.ts';
import { rbox, plate, ring } from './geo.ts';

type Look = { W: number; H: number; T: number; r: number; frame: string; frameRough: number; back: string; plateau: string; buttons: [number, number, number][] };
// buttons: [side (+1 right, -1 left), y, length]
const LOOK: Record<PhoneVariant, Look> = {
  dualPill: { W: 71.6, H: 149.6, T: 7.8, r: 11, frame: '#c7cad0', frameRough: 0.3, back: '#e3e5ea', plateau: '#d3d6dc', buttons: [[1, 40, 14], [-1, 44, 8], [-1, 28, 12], [-1, 12, 12]] },
  triplePlateau: { W: 72.4, H: 150.4, T: 8.4, r: 11.5, frame: '#8d8a84', frameRough: 0.38, back: '#a3a09a', plateau: '#b4b1ab', buttons: [[1, 40, 14], [1, -20, 18], [-1, 40, 8], [-1, 22, 12]] },
  tripleSeparate: { W: 70.6, H: 149, T: 7.2, r: 8.5, frame: '#4a5060', frameRough: 0.28, back: '#2c3446', plateau: '#2c3446', buttons: [[1, 34, 12], [1, 8, 22]] },
  cameraBar: { W: 72, H: 152.8, T: 8.6, r: 10.5, frame: '#d8d4cd', frameRough: 0.34, back: '#e8e5df', plateau: '#17191d', buttons: [[1, 36, 12], [1, 14, 20]] },
};

export function buildPhone(c: Ctx) {
  const { T, add, m, spec } = c, v = spec.variant ?? 'dualPill', L = LOOK[v], { W, H, T: TH } = L, h = TH / 2;
  const frameMat = m.metal(L.frame, L.frameRough), backMat = m.paint(L.back, 0.2), lensRing = m.metal('#c9ccd2', 0.25);

  add(rbox(T, W, H, TH, L.r, 1.1), frameMat);                                                    // aluminium / titanium frame
  add(plate(T, W - 2.2, H - 2.2, L.r - 1.1, 0.3), backMat, 0, 0, h - 0.12);                      // back glass
  add(plate(T, W - 2.2, H - 2.2, L.r - 1.1, 0.3), m.glass, 0, 0, -h + 0.12).rotation.y = Math.PI; // front glass (screen off, black)
  add(new T.CircleGeometry(1.6, 16), m.paint('#262b33', 0.2), 0, H / 2 - 7, -h - 0.2).rotation.y = Math.PI; // selfie camera dot
  add(ring(T, W + 0.5, H + 0.5, L.r + 0.25, 0.9, 1.1), m.accent, 0, 0, -0.55);                    // accent line around the frame
  for (const [side, y, len] of L.buttons) add(new T.BoxGeometry(1.4, len, 2.4), frameMat, side * (W / 2 + 0.1), y, 0.4);
  add(new T.BoxGeometry(12, 1.2, 1.4), m.dark, 0, -H / 2 - 0.05, 0);                              // USB-C port

  const top = h + 0.18;
  const lens = (x: number, y: number, R: number, z: number) => {
    const cyl = (r: number, ht: number) => { const g = new T.CylinderGeometry(r, r, ht, 28); g.rotateX(Math.PI / 2); return g; };
    add(cyl(R, 1.4), lensRing, x, y, z + 0.7); add(cyl(R * 0.74, 0.5), m.glass, x, y, z + 1.45);
    add(cyl(R * 0.3, 0.3), m.paint('#1a2250', 0.15), x, y, z + 1.75);
  };
  const flash = (x: number, y: number, r: number, z: number) => { const g = new T.CylinderGeometry(r, r, 0.6, 20); g.rotateX(Math.PI / 2); add(g, m.paint('#f1e6c8', 0.3), x, y, z + 0.3); };
  const sensor = (x: number, y: number, r: number, z: number) => { const g = new T.CylinderGeometry(r, r, 0.6, 20); g.rotateX(Math.PI / 2); add(g, m.glass, x, y, z + 0.3); };

  if (v === 'dualPill') {
    const pw = 22, ph = 42, cx = -W / 2 + 4.8 + pw / 2, cy = H / 2 - 4.8 - ph / 2;
    add(plate(T, pw, ph, 11, 1.0, cx, cy), m.paint(L.plateau, 0.25), 0, 0, top - 0.05);
    lens(cx, cy + 9.6, 6.4, top + 0.95); lens(cx, cy - 9.6, 6.4, top + 0.95); flash(cx + 17.8, cy + 15, 2.1, top);
  } else if (v === 'triplePlateau') {
    const pw = 37, ph = 38.5, cx = -W / 2 + 4.4 + pw / 2, cy = H / 2 - 4.4 - ph / 2;
    add(plate(T, pw, ph, 9.5, 1.1, cx, cy), m.metal(L.plateau, 0.3), 0, 0, top - 0.05);
    lens(cx - 8.6, cy + 9, 6.9, top + 1.05); lens(cx - 8.6, cy - 9, 6.9, top + 1.05); lens(cx + 8.6, cy, 6.9, top + 1.05);
    flash(cx + 10, cy + 14, 2.2, top + 1.0); sensor(cx + 10, cy - 13.5, 2.8, top + 1.0);
  } else if (v === 'tripleSeparate') {
    const x = -W / 2 + 13.8, y0 = H / 2 - 13.6;
    lens(x, y0, 6.2, top); lens(x, y0 - 17.6, 6.2, top); lens(x, y0 - 35.2, 6.2, top); flash(x + 13, y0 - 2, 1.7, top); sensor(x + 13, y0 - 12, 1.5, top);
  } else {
    const by = H / 2 - 29, bw = W - 0.6, bh = 21;
    add(plate(T, bw, bh, 5, 1.1, 0, by), m.paint(L.plateau, 0.2), 0, 0, top - 0.05);          // dark camera bar, edge to edge
    add(plate(T, 51, 15, 7.5, 0.3, -3, by), m.paint('#0b0c0f', 0.15), 0, 0, top + 1.0);
    lens(-14, by, 6.6, top + 1.2); lens(7, by, 5.4, top + 1.2); flash(28.5, by + 2.5, 2, top + 1.0);
  }
}
