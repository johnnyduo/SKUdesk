// Pure data: physical dimensions (mm) and camera layouts for each case. No three.js here, so the SVG fallback and SSR can use it.
// Coordinates: x to the right, y up, as seen looking at the BACK of the phone. z is thickness (back is +z).

export type Lens = { x: number; y: number; r: number; kind: 'main' | 'wide' | 'tele' };
export type Disc = { x: number; y: number; r: number };
export type RR = { cx: number; cy: number; w: number; h: number; r: number };
export type Btn = { side: 'L' | 'R'; y: number; len: number };
export type Layout = 'tripleSquare' | 'dualPill' | 's25' | 'pixelBar';

export type CaseSpec = {
  key: string; layout: Layout;
  W: number; H: number; T: number; r: number; sq: number; // body size, corner radius, squircle exponent (2 = circle)
  frame: string; glass: string; plateauCol: string;
  plateau?: RR; // raised camera block on the phone
  lenses: Lens[]; flash: Disc[]; lidar?: Disc; pill?: RR; // dark glass pill inside a bar
  cutouts: RR[]; // holes in the case back (also drive the guard rings)
  magsafe: boolean; buttons: Btn[]; usbc: boolean;
};

const rr = (cx: number, cy: number, w: number, h: number, r: number): RR => ({ cx, cy, w, h, r });
const grow = (a: RR, g: number): RR => ({ cx: a.cx, cy: a.cy, w: a.w + 2 * g, h: a.h + 2 * g, r: a.r + g });
const circ = (d: Disc, g: number): RR => rr(d.x, d.y, 2 * (d.r + g), 2 * (d.r + g), d.r + g);

function iphoneTriple(key: string, W: number, H: number, T: number, r: number, frame: string, glass: string, plateauCol: string, btnY: number[], magsafe: boolean): CaseSpec {
  const pw = 36.2, ph = 37.8;
  const cx = -W / 2 + 4.3 + pw / 2, cy = H / 2 - 4.3 - ph / 2;
  const plateau = rr(cx, cy, pw, ph, 9.8);
  const lenses: Lens[] = [
    { x: cx - 8.7, y: cy + 8.9, r: 6.8, kind: 'main' },
    { x: cx - 8.7, y: cy - 8.9, r: 6.8, kind: 'wide' },
    { x: cx + 8.7, y: cy + 0.2, r: 6.8, kind: 'tele' },
  ];
  const flash: Disc[] = [{ x: cx + 9.6, y: cy + 13.4, r: 2.3 }];
  const lidar: Disc = { x: cx + 9.6, y: cy - 12.6, r: 2.9 };
  return {
    key, layout: 'tripleSquare', W, H, T, r, sq: 2.9, frame, glass, plateauCol, plateau, lenses, flash, lidar,
    cutouts: [grow(plateau, 1.5)],
    magsafe, usbc: true,
    buttons: ([
      { side: 'R', y: btnY[0], len: 8 }, { side: 'R', y: btnY[1], len: 13 }, { side: 'R', y: btnY[2], len: 13 },
      { side: 'L', y: btnY[3], len: 22 }, { side: 'L', y: btnY[4], len: 11 },
    ] as Btn[]).filter((b) => Math.abs(b.y) < H / 2 - 8),
  };
}

export function specFor(compat: string, name: string): CaseSpec {
  const mag = /magsafe/i.test(name);
  const c = compat.toLowerCase();
  if (c.includes('pro max')) return iphoneTriple('ip16pm', 77.6, 163, 8.25, 12.4, '#55575c', '#43454a', '#4a4c51', [57, 42, 25, 35, -24], mag);
  if (c.includes('15 pro')) return iphoneTriple('ip15p', 70.6, 146.6, 8.25, 10.8, '#7d8791', '#5b6672', '#66717d', [47, 31, 14, 25, -99], mag);
  if (c.includes('iphone 16 pro')) return iphoneTriple('ip16p', 71.5, 149.6, 8.25, 11.6, '#b8a999', '#c9b49a', '#bba68d', [51, 36, 19, 30, -22], mag);
  if (c.includes('iphone 16') || c.includes('iphone')) {
    const W = 71.6, H = 147.6, T = 7.8;
    const pill = rr(-W / 2 + 4.6 + 11, H / 2 - 4.8 - 20.5, 22, 41, 11);
    const lenses: Lens[] = [{ x: pill.cx, y: pill.cy + 9.6, r: 6.3, kind: 'main' }, { x: pill.cx, y: pill.cy - 9.6, r: 6.3, kind: 'wide' }];
    const flash: Disc[] = [{ x: pill.cx + 17.6, y: pill.cy + 15.6, r: 2.2 }];
    return {
      key: 'ip16', layout: 'dualPill', W, H, T, r: 11.2, sq: 2.9, frame: '#8d9be0', glass: '#7e8fe6', plateauCol: '#8696ea',
      plateau: pill, lenses, flash, cutouts: [grow(pill, 1.5), circ(flash[0], 1.5)], magsafe: mag, usbc: true,
      buttons: [{ side: 'R', y: 50, len: 8 }, { side: 'R', y: 35, len: 13 }, { side: 'R', y: 18, len: 13 }, { side: 'L', y: 30, len: 22 }, { side: 'L', y: -21, len: 11 }],
    };
  }
  if (c.includes('galaxy') || c.includes('s25')) {
    const W = 70.5, H = 146.9, T = 7.2, x = -W / 2 + 13.6;
    const lenses: Lens[] = [{ x, y: H / 2 - 13.2, r: 6.1, kind: 'main' }, { x, y: H / 2 - 30.4, r: 6.1, kind: 'wide' }, { x, y: H / 2 - 47.6, r: 6.1, kind: 'tele' }];
    const flash: Disc[] = [{ x: x + 12.8, y: lenses[0].y - 0.4, r: 1.7 }];
    return {
      key: 's25', layout: 's25', W, H, T, r: 8.6, sq: 2.3, frame: '#c3c8d0', glass: '#2f4166', plateauCol: '#2f4166',
      lenses, flash, cutouts: [...lenses.map((l) => circ(l, 1.5)), circ(flash[0], 1.6)], magsafe: mag, usbc: true,
      buttons: [{ side: 'L', y: 30, len: 20 }, { side: 'L', y: 3, len: 13 }],
    };
  }
  // Pixel 9 and anything unknown: horizontal camera bar
  const W = 72, H = 152.8, T = 8.5, by = H / 2 - 28;
  const bar = rr(0, by, W - 5.2, 21, 5);
  const pill = rr(-3, by, 50, 15.5, 7.75);
  const lenses: Lens[] = [{ x: -14, y: by, r: 6.4, kind: 'main' }, { x: 6.4, y: by, r: 5.2, kind: 'wide' }];
  const flash: Disc[] = [{ x: 28.6, y: by + 2.6, r: 2 }];
  return {
    key: 'px9', layout: 'pixelBar', W, H, T, r: 10.6, sq: 2.4, frame: '#d6a9b1', glass: '#e4b9c0', plateauCol: '#1c1e22',
    plateau: bar, pill, lenses, flash, cutouts: [grow(rr(0, by, W - 5.2, 21, 5), 1.4)], magsafe: mag, usbc: true,
    buttons: [{ side: 'L', y: 24, len: 20 }, { side: 'L', y: -1, len: 10 }],
  };
}

/** Case wall thickness and the back-plate / rim heights, shared by the 3D model and the SVG fallback. */
export const CASE_WALL = 1.6;

/** The six clear-case markets (category Accessories). specFor() above picks the body size and camera layout from the phone the case fits and from
 *  its name (a MagSafe ring is drawn only when the name says MagSafe), so each symbol maps to the inputs it had when the cases were the whole catalog. */
export const CASE_INPUT: Readonly<Record<string, { compat: string; name: string }>> = {
  'IP16P-CLR': { compat: 'iPhone 16 Pro', name: 'iPhone 16 Pro Clear MagSafe Case' },
  'IP16PM-CLR': { compat: 'iPhone 16 Pro Max', name: 'iPhone 16 Pro Max Clear MagSafe Case' },
  'IP15P-CLR': { compat: 'iPhone 15 Pro', name: 'iPhone 15 Pro Clear MagSafe Case' },
  'IP16-CLR': { compat: 'iPhone 16', name: 'iPhone 16 Clear MagSafe Case' },
  'S25-CLR': { compat: 'Galaxy S25', name: 'Galaxy S25 Clear Case' },
  'PX9-CLR': { compat: 'Pixel 9', name: 'Pixel 9 Clear Case' },
};
export const CASE_SYMBOLS: readonly string[] = Object.keys(CASE_INPUT);

/** Body size and camera layout of one case symbol (case and surrounding spaces ignored); an unknown symbol gets the Pixel layout, as before. */
export function caseSpecForSymbol(symbol: string | null | undefined): CaseSpec {
  const i = CASE_INPUT[String(symbol ?? '').trim().toUpperCase()];
  return i ? specFor(i.compat, i.name) : specFor('', '');
}
