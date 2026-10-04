// Usage: node scripts/lab.mjs tile   → .shots/tile-1..5.png and tile-broken.png
//        node scripts/lab.mjs ring   → .shots/ring-pos-{0,1,2.5,4}.png
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from './lib/serve.mjs';

const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(web, '.shots'); await mkdir(out, { recursive: true });
const labDir = path.join(out, 'lab'); await mkdir(labDir, { recursive: true });
const mode = process.argv[2] ?? 'tile';

await build({ entryPoints: [path.join(web, 'src/showcase/lab.ts')], bundle: true, format: 'esm', splitting: true, outdir: labDir, logLevel: 'warning' });
await writeFile(path.join(labDir, 'index.html'), '<!doctype html><meta charset="utf-8"><body style="margin:0;background:#222"><script type="module" src="/lab.js"></script>');
const srv = await serve([labDir, path.join(web, 'public')]);
const args = ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'];
const browser = await chromium.launch({ args }).catch(() => chromium.launch({ channel: 'chrome', args }));
const errors = [];

if (mode === 'tile') {
  const page = await browser.newPage({ viewport: { width: 384, height: 480 }, deviceScaleFactor: 2 });
  page.on('pageerror', (e) => errors.push(e.message));
  const shots = [0, 1, 2, 3, 4].map((i) => [`tile-${i + 1}.png`, `?mode=tile&i=${i}`]).concat([['tile-broken.png', '?mode=tile&i=0&broken=1']]);
  for (const [name, qs] of shots) {
    await page.goto(srv.url + '/' + qs);
    await page.waitForSelector('html[data-ready]');
    await page.screenshot({ path: path.join(out, name) });
    console.log('wrote', name);
  }
}
if (mode === 'ring') {
  const page = await browser.newPage({ viewport: { width: 1100, height: 700 } });
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  for (const pos of [0, 1, 2.5, 4]) {
    await page.goto(`${srv.url}/?mode=ring&pos=${pos}`);
    await page.waitForSelector('html[data-ready]', { timeout: 20000 });
    await page.screenshot({ path: path.join(out, `ring-pos-${pos}.png`) });
    console.log('wrote', `ring-pos-${pos}.png`);
  }
}
if (mode === 'art') {
  const page = await browser.newPage({ viewport: { width: 384, height: 480 }, deviceScaleFactor: 2 });
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('requestfailed', (r) => errors.push('failed: ' + r.url()));
  page.on('response', (r) => { if (r.status() >= 400) errors.push(`${r.status()} ${r.url()}`); });
  const slugs = ['headphones', 'charger', 'mouse', 'bulbs', 'tumbler', 'hub'];
  for (const [i, slug] of slugs.entries()) {
    await page.goto(`${srv.url}/?mode=tile&src=/img/showcase/${slug}.svg&rank=${i + 2}`);
    await page.waitForSelector('html[data-ready]');
    await page.screenshot({ path: path.join(out, `art-${slug}.png`) });
    console.log('wrote', `art-${slug}.png`);
  }
}
await browser.close(); await srv.close();
if (errors.length) { console.log('ERRORS:', errors); process.exit(1); }
