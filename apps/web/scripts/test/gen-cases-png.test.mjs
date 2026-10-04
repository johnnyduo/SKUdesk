import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { OUT_DIR, SIZE, SRC_DIR, pngName, renderPng } from '../gen-cases-png.mjs';

test('pngName maps .svg to .png', () => {
  assert.equal(pngName('iphone-16-pro_clear_mag_1.svg'), 'iphone-16-pro_clear_mag_1.png');
});

test('renderPng produces a 1000x1000 opaque PNG (>= 500x500 Merchant minimum)', async () => {
  const png = await renderPng(readFileSync(join(SRC_DIR, 'iphone-16-pro_clear_mag_1.svg')));
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const meta = await sharp(png).metadata();
  assert.equal(meta.format, 'png');
  assert.equal(meta.width, SIZE);
  assert.equal(meta.height, SIZE);
  assert.ok(png.length < 16 * 1024 * 1024);
});

test('every SVG render has a committed PNG twin', () => {
  const svgs = readdirSync(SRC_DIR).filter((f) => f.endsWith('.svg'));
  assert.ok(svgs.length >= 80);
  const missing = svgs.map(pngName).filter((p) => !existsSync(join(OUT_DIR, p)));
  assert.deepEqual(missing, []);
});
