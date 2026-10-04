// Usage: node scripts/copy-lint.mjs [path/to/index.html]   (default: dist/index.html)
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { lintCopy } from './lib/copy-lint-core.mjs';

const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const file = process.argv[2] ?? path.join(web, 'dist/index.html');
const r = lintCopy(await readFile(file, 'utf8'));
console.log(`${r.ok ? 'PASS' : 'FAIL'}  landing copy: ${r.words} words`);
for (const p of r.problems) console.log('  - ' + p);
process.exit(r.ok ? 0 : 1);
