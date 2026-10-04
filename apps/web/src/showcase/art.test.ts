import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { MARKET_PRODUCTS } from './market-products.ts';

const attr = (tag: string, name: string) => tag.match(new RegExp(`\\s${name}="([^"]*)"`))?.[1];

test('product art exists, has intrinsic size, no backdrop, at most 4 KB', () => {
  for (const e of MARKET_PRODUCTS) {
    const f = new URL(`../../public${e.art}`, import.meta.url);
    const svg = readFileSync(f, 'utf8');
    assert.ok(statSync(f).size <= 4096, `${e.art} is ${statSync(f).size} bytes`);

    // Root start tag only (so stroke-width etc. on children or the root can never satisfy these).
    const root = svg.match(/<svg\b[^>]*>/)?.[0] ?? '';
    assert.match(root, /\sxmlns="http:\/\/www\.w3\.org\/2000\/svg"/, `${e.art} xmlns`);
    assert.match(root, /\swidth="160"/, `${e.art} root width must be 160`);
    assert.match(root, /\sheight="200"/, `${e.art} root height must be 200`);
    assert.match(root, /\sviewBox="0 0 160 200"/, `${e.art} root viewBox must be 0 0 160 200`);

    // Backdrop as <rect>: width or height at full size, in either attribute order.
    for (const rect of svg.match(/<rect\b[^>]*>/g) ?? []) {
      const w = attr(rect, 'width'), h = attr(rect, 'height');
      assert.ok(!(w === '160' || w === '100%' || h === '200' || h === '100%'), `${e.art} has a full-size backdrop rect: ${rect}`);
    }
    // Backdrop as <path>: starts at a canvas corner (M0 0, M0,0, M160 0, M0 200, M160 200) and mentions both 160 and 200.
    // (A path that starts mid-canvas and then draws the full box is not caught.)
    for (const path of svg.match(/<path\b[^>]*>/g) ?? []) {
      const d = attr(path, 'd') ?? '';
      const corner = /^\s*M\s*(0|160)[\s,]+(0|200)(?![\d.])/i.test(d);
      assert.ok(!(corner && /(?<![\d.])160(?![\d.])/.test(d) && /(?<![\d.])200(?![\d.])/.test(d)), `${e.art} has a full-size backdrop path: ${d}`);
    }

    assert.doesNotMatch(svg, /<(text|image|script|foreignObject)\b/i, `${e.art} has text/image/script`);
  }
});
