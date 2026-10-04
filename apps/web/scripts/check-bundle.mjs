// Usage: node scripts/check-bundle.mjs [--dist dist] [--base-dist /path/to/pre-hero/dist]
// Hero budgets (gzip):
//   • lazy 3D chunks (Three.js scene + optional GLTFLoader) ≤ 200 KB combined, and never loaded eagerly
//   • JS the landing page loads eagerly grew ≤ 10 KB vs the base build
// "Eager" = scripts referenced by index.html plus their static imports; dynamic import() chunks are lazy.
import { readdir, readFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; };
const dist = path.resolve(arg('--dist') ?? path.join(web, 'dist'));
const baseDist = arg('--base-dist') && path.resolve(arg('--base-dist'));
const kb = (n) => (n / 1024).toFixed(1) + ' KB';

async function measure(root) {
  const dir = path.join(root, '_astro');
  const bufs = {};
  for (const f of (await readdir(dir)).filter((f) => f.endsWith('.js'))) bufs[f] = await readFile(path.join(dir, f), 'utf8');
  const gz = (f) => gzipSync(Buffer.from(bufs[f])).length;

  const html = await readFile(path.join(root, 'index.html'), 'utf8');
  const eager = new Set();
  const visit = (f) => {
    if (!bufs[f] || eager.has(f)) return;
    eager.add(f);
    // static imports only: `from"./x.js"` / `import"./x.js"`; dynamic `import("./x.js")` has a paren
    for (const m of bufs[f].matchAll(/(?:from|import)\s*["']\.\/([^"']+\.js)["']/g)) visit(m[1]);
  };
  for (const m of html.matchAll(/\/_astro\/([^"'\s>]+\.js)/g)) visit(m[1]);

  const lazy3d = Object.keys(bufs).filter((f) => bufs[f].includes('WebGLRenderer') || /^GLTFLoader\./.test(f));
  return {
    eagerGz: [...eager].reduce((n, f) => n + gz(f), 0),
    eager: [...eager],
    lazy3d,
    lazy3dGz: lazy3d.reduce((n, f) => n + gz(f), 0),
    html,
  };
}

const m = await measure(dist);
console.log(`lazy 3D chunks: ${m.lazy3d.join(', ') || 'none'}  ${kb(m.lazy3dGz)} gzip`);
console.log(`eager JS on the landing page: ${kb(m.eagerGz)} gzip (${m.eager.length} files)`);

let failed = 0;
if (m.lazy3d.length === 0) { console.log('FAIL  no chunk contains Three.js'); failed++; }
else if (m.lazy3dGz > 200 * 1024) { console.log(`FAIL  lazy 3D chunks ${kb(m.lazy3dGz)} > 200 KB`); failed++; }
else console.log('PASS  lazy 3D chunks ≤ 200 KB gzip');

const leaked = m.lazy3d.filter((f) => m.eager.includes(f));
if (leaked.length) { console.log(`FAIL  3D chunk loaded eagerly: ${leaked.join(', ')}`); failed++; } else console.log('PASS  3D chunks are not loaded eagerly');
if (m.lazy3d.some((f) => new RegExp(`(modulepreload|rel="preload")[^>]*${f.replace(/\./g, '\\.')}`).test(m.html))) { console.log('FAIL  landing HTML preloads a 3D chunk'); failed++; }

if (baseDist) {
  const base = await measure(baseDist);
  const delta = m.eagerGz - base.eagerGz;
  console.log(`base eager JS: ${kb(base.eagerGz)} gzip → delta ${kb(delta)}`);
  if (delta > 10 * 1024) { console.log(`FAIL  eager JS grew ${kb(delta)} (> 10 KB)`); failed++; } else console.log('PASS  eager JS delta ≤ 10 KB');
} else console.log('SKIP  no --base-dist given for the 10 KB check');
process.exit(failed ? 1 : 0);
