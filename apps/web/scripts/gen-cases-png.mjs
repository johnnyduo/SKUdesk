// Rasterizes the SVG case renders (public/img/cases/*.svg) to 1000x1000 PNG on a white background in
// public/img/cases-png/. Google Merchant Center does not accept SVG for imageLink and requires >= 500x500 px.
// Uses `sharp`, which is already installed as Astro's image dependency (no new package).
// Run: npm run gen:png   (re-run after `npm run gen:cases`)
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const SRC_DIR = join(ROOT, 'public', 'img', 'cases');
export const OUT_DIR = join(ROOT, 'public', 'img', 'cases-png');
export const SIZE = 1000;

export const pngName = (svgName) => svgName.replace(/\.svg$/, '.png');

async function loadSharp() {
  try {
    return (await import('sharp')).default;
  } catch {
    throw new Error('sharp is not installed (it ships with Astro). Run `npm install` in apps/web without adding packages.');
  }
}

export async function renderPng(svgBuffer) {
  const sharp = await loadSharp();
  // density 600 rasterizes the 120x190 viewBox at ~5x so the 1000 px output is sharp, not upscaled.
  return sharp(svgBuffer, { density: 600 })
    .resize({ width: SIZE, height: SIZE, fit: 'contain', background: '#ffffff' })
    .flatten({ background: '#ffffff' })
    .png({ compressionLevel: 9, palette: true, quality: 90 })
    .toBuffer();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  rmSync(OUT_DIR, { recursive: true, force: true });
  mkdirSync(OUT_DIR, { recursive: true });
  const files = readdirSync(SRC_DIR).filter((f) => f.endsWith('.svg')).sort();
  for (const f of files) writeFileSync(join(OUT_DIR, pngName(f)), await renderPng(readFileSync(join(SRC_DIR, f))));
  console.log('wrote ' + files.length + ' PNG renders to ' + OUT_DIR);
}
