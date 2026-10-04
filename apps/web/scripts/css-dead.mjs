// Usage: node scripts/css-dead.mjs   → lists class names in landing.css that no .astro/.tsx/.ts file mentions.
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
async function* walk(dir) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (/\.(astro|tsx|ts|html)$/.test(e.name)) yield p;
  }
}
let src = '';
for await (const f of walk(path.join(web, 'src'))) if (!f.endsWith('landing.css')) src += (await readFile(f, 'utf8')) + '\n';
const css = await readFile(path.join(web, 'src/styles/landing.css'), 'utf8');
const classes = [...new Set([...css.matchAll(/\.([a-zA-Z][\w-]*)/g)].map((m) => m[1]))].filter((c) => !/^\d/.test(c));
const dead = classes.filter((c) => !new RegExp(`(^|[^\\w-])${c}([^\\w-]|$)`).test(src));
console.log(dead.length ? dead.join('\n') : '(none)');
