// Regression guard: the built site (dist/) must never contain key material or token values.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIST = process.env.DIST_DIR ? process.env.DIST_DIR.replace(/\/*$/, '/') : fileURLToPath(new URL('../../dist/', import.meta.url));
const PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /"private_key"\s*:/,
  /ya29\.[A-Za-z0-9_-]{20,}/,
  /AIza[0-9A-Za-z_-]{35}/,
  /x-admin-token["']?\s*[:=]\s*["'][^"']{8,}/i,
  /[?&](api_key|apiKey)=[A-Za-z0-9]{16,}/,
];

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (/\.(html|js|mjs|json|css|txt|xml|map)$/.test(name)) yield p;
  }
}

test('dist/ contains no private keys, access tokens or API key values', () => {
  const hits = [];
  for (const file of walk(DIST)) {
    const text = readFileSync(file, 'utf8');
    for (const re of PATTERNS) if (re.test(text)) hits.push(file.slice(DIST.length) + ' ~ ' + re);
  }
  assert.deepEqual(hits, []);
});
