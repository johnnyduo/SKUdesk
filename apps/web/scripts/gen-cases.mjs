// Generates transparent, consistently framed product renders (back view, phone + case)
// for every catalog combination: model x case colour x MagSafe x pack.
// Output: public/img/cases/<model>_<colour>_<mag|plain>_<1|2>.svg   (run: npm run gen:cases)
// Original vector artwork, no logos or third-party assets. Canvas 120x190, phone centred.
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'img', 'cases');
const W = 120, H = 190;

// w/h in px at ~1.08px per mm so relative sizes between models are true to scale.
export const MODELS = {
  'iphone-16-pro':     { w: 77, h: 162, body: ['#d3cdc1', '#a39c8f'], cam: 'pro', k: 1 },
  'iphone-16':         { w: 77, h: 159, body: ['#a9c7c3', '#7a9c98'], cam: 'pill', k: 1 },
  'iphone-16-pro-max': { w: 84, h: 176, body: ['#dcc4ad', '#b39780'], cam: 'pro', k: 1.09 },
  'galaxy-s25':        { w: 76, h: 159, body: ['#93a3c4', '#65769a'], cam: 'tri', k: 1 },
  'pixel-9':           { w: 78, h: 165, body: ['#ebe5db', '#cdc5b8'], cam: 'bar', k: 1 },
};
const CASES = {
  Black: { a: '#34373a', b: '#17181a', edge: 'rgba(255,255,255,.18)', ring: 'rgba(255,255,255,.34)', btn: '#101112' },
  White: { a: '#fbfbf9', b: '#d9dbd7', edge: 'rgba(0,0,0,.16)', ring: 'rgba(0,0,0,.28)', btn: '#c4c7c2' },
  Navy:  { a: '#2c4676', b: '#16264a', edge: 'rgba(255,255,255,.20)', ring: 'rgba(255,255,255,.34)', btn: '#101c38' },
};
const f = (n) => +n.toFixed(2);

function lens(cx, cy, r, id) {
  return `<circle cx="${f(cx)}" cy="${f(cy)}" r="${f(r)}" fill="#0b0c0e" stroke="url(#ring-${id})" stroke-width="1.3"/>`
    + `<circle cx="${f(cx)}" cy="${f(cy)}" r="${f(r * 0.66)}" fill="url(#lens-${id})"/>`
    + `<circle cx="${f(cx - r * 0.28)}" cy="${f(cy - r * 0.3)}" r="${f(r * 0.16)}" fill="#fff" opacity=".55"/>`;
}

// Camera artwork in phone-local coords (origin = phone top-left). Returns { svg, hole } (hole = case cutout rect).
function camera(m, id) {
  const { cam, w, k } = m;
  if (cam === 'pro') {
    const g = `<g transform="translate(7 7) scale(${k}) translate(-7 -7)">`
      + `<rect x="7" y="7" width="35" height="36" rx="9" fill="url(#glass-${id})" stroke="rgba(255,255,255,.16)"/>`
      + lens(16, 16.5, 7, id) + lens(16, 33.5, 7, id) + lens(30, 25, 7, id)
      + `<circle cx="33" cy="13" r="2.3" fill="#ece6c9"/><circle cx="33" cy="37.5" r="1.9" fill="#08090a"/></g>`;
    return { svg: g, hole: { x: 4.5, y: 4.5, w: 35 * k + 5, h: 36 * k + 5, r: 11 } };
  }
  if (cam === 'pill') {
    return { svg: `<rect x="8" y="8" width="27" height="45" rx="13.5" fill="url(#glass-${id})" stroke="rgba(255,255,255,.16)"/>`
      + lens(21.5, 22, 6.4, id) + lens(21.5, 39, 6.4, id) + `<circle cx="29.8" cy="30.5" r="1.7" fill="#ece6c9"/>`,
      hole: { x: 5.5, y: 5.5, w: 32, h: 50, r: 16 } };
  }
  if (cam === 'tri') {
    return { svg: lens(16, 14.5, 5.8, id) + lens(16, 30, 5.8, id) + lens(16, 45.5, 5.8, id) + `<circle cx="28" cy="13" r="2" fill="#ece6c9"/>`,
      hole: { x: 6.5, y: 6, w: 20, h: 52, r: 10 } };
  }
  // bar (Pixel)
  return { svg: `<rect x="0" y="17" width="${w}" height="25" fill="url(#glass-${id})"/>`
    + `<line x1="0" y1="17" x2="${w}" y2="17" stroke="rgba(255,255,255,.16)"/><line x1="0" y1="42" x2="${w}" y2="42" stroke="rgba(255,255,255,.1)"/>`
    + lens(22, 29.5, 7, id) + lens(42, 29.5, 6.2, id) + `<rect x="${w - 22}" y="25" width="12" height="9" rx="4.5" fill="#d9d4bd" opacity=".85"/>`,
    hole: { x: -3, y: 14.5, w: w + 6, h: 30, r: 0 } };
}

function unit(model, color, mag, id) {
  const m = MODELS[model], { w, h } = m, r = Math.round(w * 0.165), clear = color === 'Clear';
  const C = CASES[color], cam = camera(m, id), cx = w / 2, cy = h * 0.46;
  let s = '';
  const btn = clear ? 'rgba(255,255,255,.4)' : C.btn;
  // side buttons sit behind the body so they read as raised case buttons
  s += `<rect x="${w + 1.5}" y="${f(h * 0.27)}" width="2.6" height="${f(h * 0.13)}" rx="1.3" fill="${btn}"/>`
    + `<rect x="-4.1" y="${f(h * 0.2)}" width="2.6" height="${f(h * 0.075)}" rx="1.3" fill="${btn}"/>`
    + `<rect x="-4.1" y="${f(h * 0.31)}" width="2.6" height="${f(h * 0.1)}" rx="1.3" fill="${btn}"/>`;
  if (clear) {
    s += `<rect width="${w}" height="${h}" rx="${r}" fill="url(#body-${id})"/>`
      + `<rect width="${w}" height="${h}" rx="${r}" fill="url(#sheen-${id})"/>`;
  } else {
    s += `<rect x="-3" y="-3" width="${w + 6}" height="${h + 6}" rx="${r + 3}" fill="url(#case-${id})"/>`
      + `<rect x="-3" y="-3" width="${w + 6}" height="${h + 6}" rx="${r + 3}" fill="none" stroke="${C.edge}"/>`
      + `<rect x="-3" y="-3" width="${w + 6}" height="${h + 6}" rx="${r + 3}" fill="url(#sheen-${id})"/>`;
    s += `<rect x="${cam.hole.x}" y="${cam.hole.y}" width="${f(cam.hole.w)}" height="${f(cam.hole.h)}" rx="${cam.hole.r}" fill="#0c0d0e" stroke="${C.edge}" stroke-width="1.2"/>`;
  }
  if (mag) {
    const rr = w * 0.3, rc = clear ? 'rgba(255,255,255,.62)' : C.ring;
    s += `<circle cx="${f(cx)}" cy="${f(cy)}" r="${f(rr)}" fill="none" stroke="${rc}" stroke-width="1.6"/>`
      + `<circle cx="${f(cx)}" cy="${f(cy)}" r="${f(rr * 0.5)}" fill="none" stroke="${rc}" stroke-width=".8" opacity=".55"/>`;
  }
  s += cam.svg;
  if (clear) {
    s += `<rect x="-3" y="-3" width="${w + 6}" height="${h + 6}" rx="${r + 3}" fill="rgba(255,255,255,.05)" stroke="rgba(255,255,255,.62)" stroke-width="1.3"/>`
      + `<rect x="-.4" y="-.4" width="${w + .8}" height="${h + .8}" rx="${r}" fill="none" stroke="rgba(255,255,255,.22)"/>`
      + `<rect x="${cam.hole.x}" y="${cam.hole.y}" width="${f(cam.hole.w)}" height="${f(cam.hole.h)}" rx="${cam.hole.r}" fill="none" stroke="rgba(255,255,255,.5)" stroke-width="1"/>`;
  }
  return s;
}

function defs(model, color, id) {
  const m = MODELS[model], C = CASES[color];
  return `<defs>`
    + `<linearGradient id="body-${id}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${m.body[0]}"/><stop offset="1" stop-color="${m.body[1]}"/></linearGradient>`
    + (C ? `<linearGradient id="case-${id}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${C.a}"/><stop offset="1" stop-color="${C.b}"/></linearGradient>` : '')
    + `<linearGradient id="sheen-${id}" x1="0" y1="0" x2="1" y2="0.7"><stop offset="0" stop-color="#fff" stop-opacity=".22"/><stop offset=".42" stop-color="#fff" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".16"/></linearGradient>`
    + `<linearGradient id="glass-${id}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#34383c"/><stop offset="1" stop-color="#15171a"/></linearGradient>`
    + `<linearGradient id="ring-${id}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#8b9096"/><stop offset="1" stop-color="#3a3d42"/></linearGradient>`
    + `<radialGradient id="lens-${id}" cx=".4" cy=".35" r=".8"><stop offset="0" stop-color="#2a4670"/><stop offset=".55" stop-color="#0d1626"/><stop offset="1" stop-color="#030406"/></radialGradient>`
    + `</defs>`;
}

export function caseSvg(model, color, mag, pack) {
  const m = MODELS[model], id = 'c';
  const sc = pack === 2 ? 0.88 : 1;
  const ox = W / 2 - m.w / 2 - (pack === 2 ? 7 : 0), oy = H / 2 - m.h / 2;
  let body = '';
  if (pack === 2) body += `<g transform="translate(${f(ox + 15)} ${f(oy + 5)}) rotate(6 ${m.w / 2} ${m.h / 2})" opacity=".78">${unit(model, color, mag, id)}</g>`;
  body += `<g transform="translate(${f(ox)} ${f(oy)})">${unit(model, color, mag, id)}</g>`;
  const inner = pack === 2 ? `<g transform="translate(${W / 2} ${H / 2}) scale(${sc}) translate(${-W / 2} ${-H / 2})">${body}</g>` : body;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">${defs(model, color, id)}${inner}</svg>\n`;
}

export const fileName = (model, color, mag, pack) => `${model}_${color.toLowerCase()}_${mag ? 'mag' : 'plain'}_${pack}.svg`;

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  rmSync(OUT, { recursive: true, force: true }); mkdirSync(OUT, { recursive: true });
  let n = 0;
  for (const model of Object.keys(MODELS)) for (const color of ['Clear', ...Object.keys(CASES)]) for (const mag of [true, false]) for (const pack of [1, 2]) {
    writeFileSync(join(OUT, fileName(model, color, mag, pack)), caseSvg(model, color, mag, pack)); n++;
  }
  console.log(`wrote ${n} renders to ${OUT}`);
}
