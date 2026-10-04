// Test helper: bundles a TSX island with esbuild (React included) so tests can render or drive the REAL component.
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url));

export async function bundle(contents: string, format: 'esm' | 'iife', platform: 'node' | 'browser'): Promise<string> {
  const out = await build({
    stdin: { contents, resolveDir: root, loader: 'tsx', sourcefile: 'entry.tsx' },
    bundle: true, write: false, format, platform, jsx: 'automatic', target: 'es2022', logLevel: 'silent', loader: { '.css': 'empty' },
    banner: platform === 'node' ? { js: "import { createRequire as __cr } from 'node:module'; const require = __cr('file:///x.mjs');" } : {},
    define: { 'process.env.NODE_ENV': '"production"' },
  });
  return out.outputFiles[0].text;
}

// Renders the exports of a component module in Node: `mod` is a bundled ES module, imported via a data: URL.
export async function loadNodeModule<T>(entry: string): Promise<T> {
  const code = await bundle(entry, 'esm', 'node');
  return (await import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'))) as T;
}
