// 2D fallback art: one simple silhouette per kind on a 240 x 240 canvas, as plain data (rendered by DeviceArt.tsx, used when WebGL is
// unavailable). Colour roles only; the accent is the market's accent. No logos, no wordmarks.
import type { Kind } from './specs.ts';

/** The 2D art kinds: every kind except 'case', which has its own detailed illustration (CaseArt.tsx). */
export type ArtKind = Exclude<Kind, 'case'>;

export type Role = 'body' | 'trim' | 'dark' | 'accent';
export type Shape =
  | { t: 'rect'; x: number; y: number; w: number; h: number; r?: number; c: Role; o?: number }
  | { t: 'circle'; cx: number; cy: number; r: number; c: Role; o?: number }
  | { t: 'path'; d: string; c: Role; o?: number; stroke?: number };

const R = (x: number, y: number, w: number, h: number, r: number, c: Role, o?: number): Shape => ({ t: 'rect', x, y, w, h, r, c, o });
const C = (cx: number, cy: number, r: number, c: Role, o?: number): Shape => ({ t: 'circle', cx, cy, r, c, o });
const P = (d: string, c: Role, stroke?: number, o?: number): Shape => ({ t: 'path', d, c, stroke, o });

export const ART: Readonly<Record<ArtKind, readonly Shape[]>> = {
  phone: [
    R(82, 24, 76, 192, 16, 'body'), R(86, 28, 68, 184, 12, 'trim'), R(92, 34, 34, 44, 11, 'dark'), C(103, 46, 7, 'body'), C(103, 66, 7, 'body'),
    C(103, 46, 3.5, 'dark'), C(103, 66, 3.5, 'dark'), C(118, 40, 2.4, 'accent'), R(90, 190, 60, 3, 1.5, 'accent'),
  ],
  earbuds: [
    R(54, 112, 132, 78, 30, 'body'), R(54, 112, 132, 22, 11, 'trim'), P('M58 112 Q120 60 182 112 L182 120 L58 120 Z', 'trim'),
    R(84, 66, 24, 62, 12, 'body'), R(132, 66, 24, 62, 12, 'body'), C(96, 64, 16, 'body'), C(144, 64, 16, 'body'), C(120, 156, 5, 'accent'),
    R(58, 126, 124, 3, 1.5, 'accent'),
  ],
  headphones: [
    P('M50 140 Q50 36 120 36 Q190 36 190 140', 'trim', 12), P('M50 140 Q50 36 120 36 Q190 36 190 140', 'dark', 5),
    R(30, 112, 46, 86, 22, 'body'), R(164, 112, 46, 86, 22, 'body'), R(36, 120, 34, 70, 17, 'dark'), R(170, 120, 34, 70, 17, 'dark'),
    C(53, 155, 8, 'accent'), C(187, 155, 8, 'accent'),
  ],
  handheld: [
    R(20, 78, 36, 100, 16, 'dark'), R(184, 78, 36, 100, 16, 'dark'), R(54, 82, 132, 92, 8, 'body'), R(60, 88, 120, 80, 4, 'dark'),
    C(38, 104, 8, 'trim'), C(202, 142, 8, 'trim'), C(194, 106, 3, 'accent'), C(210, 106, 3, 'accent'), C(202, 98, 3, 'accent'), C(202, 114, 3, 'accent'),
    R(26, 150, 24, 3, 1.5, 'accent'),
  ],
  vr: [
    P('M30 96 Q18 176 120 190 Q222 176 210 96', 'trim', 14, 0.9), R(30, 70, 180, 90, 34, 'body'), R(42, 82, 156, 66, 24, 'dark'),
    C(80, 115, 8, 'trim'), C(120, 115, 8, 'trim'), C(160, 115, 8, 'trim'), R(46, 152, 148, 4, 2, 'accent'),
  ],
  console: [
    R(60, 190, 120, 14, 7, 'dark'), P('M84 30 Q70 30 70 50 L56 188 L184 188 L170 50 Q170 30 156 30 Z', 'body'),
    R(100, 40, 40, 150, 10, 'dark'), R(108, 56, 24, 3, 1.5, 'accent'), R(108, 66, 24, 3, 1.5, 'trim'),
  ],
  laptop: [
    R(48, 46, 144, 98, 8, 'body'), R(55, 53, 130, 84, 4, 'dark'), P('M26 150 L214 150 L226 176 Q226 184 216 184 L24 184 Q14 184 14 176 Z', 'body'),
    R(92, 172, 56, 5, 2.5, 'trim'), R(34, 156, 172, 12, 3, 'dark'), R(60, 128, 120, 3, 1.5, 'accent'),
  ],
  tablet: [
    R(30, 52, 180, 136, 14, 'body'), R(37, 59, 166, 122, 8, 'dark'), C(120, 55.5, 1.8, 'trim'), R(56, 168, 128, 3, 1.5, 'accent'),
  ],
  watch: [
    R(94, 8, 52, 70, 12, 'trim'), R(94, 162, 52, 70, 12, 'trim'), R(72, 66, 96, 108, 26, 'body'), R(80, 74, 80, 92, 20, 'dark'),
    R(168, 98, 8, 20, 4, 'trim'), R(172, 130, 4, 14, 2, 'trim'), R(88, 156, 64, 3, 1.5, 'accent'), C(120, 112, 14, 'trim', 0.55),
  ],
  generic: [
    R(48, 66, 144, 108, 24, 'body'), R(58, 76, 124, 88, 16, 'dark'), R(72, 158, 96, 3, 1.5, 'accent'), C(120, 120, 16, 'trim', 0.5),
  ],
};
