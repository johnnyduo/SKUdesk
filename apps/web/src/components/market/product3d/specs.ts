// Pure data and maths (no three.js, no DOM): which 3D model each market symbol gets, the common fit rule and the accent contrast rule.
// The viewer is keyed ONLY on the market symbol; the market name is just a label. Generic silhouettes only: no logos, no wordmarks.
// Every model is built centred on the origin with its front facing +z (a phone shows its BACK at +z, its screen at -z) and is then
// scaled so that its longest side equals FIT, so every product fills the stage the same way.
// Kind 'case' is the one accessory look (the six clear phone-case markets, category Accessories): a clear case with a lit phone inside.
// Its body size and camera layout live in casespec.ts (pure data) and the builder in case.ts.
import { CASE_INPUT, CASE_SYMBOLS } from './casespec.ts';

export const KINDS = ['phone', 'earbuds', 'headphones', 'handheld', 'vr', 'console', 'laptop', 'tablet', 'watch', 'case', 'generic'] as const;
export type Kind = (typeof KINDS)[number];
/** Camera layout of the phone builder: the four phones differ only by these parameters. */
export type PhoneVariant = 'dualPill' | 'triplePlateau' | 'tripleSeparate' | 'cameraBar';

export type Spec = {
  symbol: string; kind: Kind; variant?: PhoneVariant;
  /** generic words for the canvas label and the fallback art (never a brand) */
  noun: string;
  /** camera elevation in radians: flat things are seen from a little higher so their top face shows */
  elev: number;
};

const S = (symbol: string, kind: Kind, noun: string, elev = 0.16, variant?: PhoneVariant): Spec => ({ symbol, kind, noun, elev, ...(variant ? { variant } : {}) });

const TABLE: readonly Spec[] = [
  S('IP17', 'phone', 'smartphone with a flat aluminium frame and a vertical dual camera', 0.14, 'dualPill'),
  S('IP18P', 'phone', 'smartphone with a titanium-look frame and a triple camera plateau', 0.14, 'triplePlateau'),
  S('S26', 'phone', 'smartphone with a flat frame and three separate camera lenses', 0.14, 'tripleSeparate'),
  S('PX11', 'phone', 'smartphone with a horizontal camera bar', 0.14, 'cameraBar'),
  S('APP3', 'earbuds', 'wireless earbuds in an open charging case', 0.34),
  S('XM6', 'headphones', 'over-ear headphones with a headband and folding hinges', 0.14),
  S('NSW2', 'handheld', 'handheld game console with a tablet screen and two side controllers', 0.2),
  S('Q3S', 'vr', 'VR headset with a head strap', 0.22),
  S('PS5', 'console', 'home game console, a white vertical shell on a stand', 0.16),
  S('MBA13', 'laptop', 'thin laptop, open', 0.3),
  S('IPAD', 'tablet', 'tablet with a thin slab body', 0.16),
  S('AW12', 'watch', 'smartwatch with a rounded-square case, crown and band', 0.16),
];
// the six case markets, after the 12 products; each keeps the body size and camera layout it had before (casespec.ts)
const CASES: readonly Spec[] = CASE_SYMBOLS.map((sym) => S(sym, 'case', /magsafe/i.test(CASE_INPUT[sym].name) ? 'clear phone case with a MagSafe ring, shown with a phone inside' : 'clear phone case, shown with a phone inside', 0.16));
/** The 12 main products (viewer order). */
export const SYMBOLS: readonly string[] = TABLE.map((t) => t.symbol);
/** The six case symbols (category Accessories). */
export { CASE_SYMBOLS };
/** Every symbol that has its own model: the 12 products, then the 6 cases. */
export const ALL_SYMBOLS: readonly string[] = [...SYMBOLS, ...CASE_SYMBOLS];
const GENERIC: Spec = S('GENERIC', 'generic', 'consumer device', 0.2);

/** The spec of one market symbol (letter case and surrounding spaces ignored). Unknown or missing => a neutral generic device, never a case. */
export function specForSymbol(symbol: string | null | undefined): Spec {
  const k = String(symbol ?? '').trim().toUpperCase();
  return TABLE.find((t) => t.symbol === k) ?? CASES.find((t) => t.symbol === k) ?? GENERIC;
}

// fit

export const FIT = 150; // the longest side of every built model, in scene units

/** Scale and offset that centre a box on the origin and make its longest side FIT. offset is applied AFTER scaling. */
export function fitOf(min: readonly number[], max: readonly number[]): { scale: number; offset: [number, number, number]; size: [number, number, number] } {
  const sz = [0, 1, 2].map((i) => max[i] - min[i]), longest = Math.max(...sz);
  if (!(longest > 0) || !Number.isFinite(longest)) throw new Error('fitOf: empty or non-finite box');
  const scale = FIT / longest;
  return { scale, offset: [0, 1, 2].map((i) => -((min[i] + max[i]) / 2) * scale) as [number, number, number], size: sz.map((x) => x * scale) as [number, number, number] };
}

// accent on the dark stage

export const STAGE_BG = '#0a0b0a';
export const DEFAULT_ACCENT = '#ccff00';
const hex3 = (h: string) => { const m = /^#?([0-9a-f]{6})$/i.exec(h.trim()); if (!m) return null; const n = parseInt(m[1], 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
const lin = (v: number) => { const c = v / 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
const lum = (rgb: number[]) => 0.2126 * lin(rgb[0]) + 0.7152 * lin(rgb[1]) + 0.0722 * lin(rgb[2]);
/** WCAG contrast ratio of two #rrggbb colours (1..21). */
export function contrast(a: string, b: string): number {
  const x = hex3(a), y = hex3(b); if (!x || !y) return 1;
  const l1 = lum(x), l2 = lum(y); return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}
const toHex = (rgb: number[]) => '#' + rgb.map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('');
/** The accent as drawn on the dark stage: unchanged when it already has >= 4.5:1 contrast, otherwise mixed toward white until it has. A malformed accent => the default. */
export function accentOnDark(accent: string): string {
  const rgb = hex3(accent) ?? hex3(DEFAULT_ACCENT)!;
  for (let t = 0; t <= 1.0001; t += 0.02) { const c = rgb.map((v) => v + (255 - v) * t); if (contrast(toHex(c), STAGE_BG) >= 4.5) return toHex(c); }
  return '#ffffff';
}
