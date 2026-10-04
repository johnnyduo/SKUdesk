// Emitted at build time as /sitemap.xml. Static routes come from the pages directory itself, so a new page is listed without edits.
// The few dynamic routes use the same sources their getStaticPaths use (the run's lot and opportunity ids, the SKU manifest).
import type { APIRoute } from 'astro';
import { SITE_ORIGIN, buildManifest } from '../lib/listing';
import { RUN } from '../lib/run';

const files = Object.keys(import.meta.glob('./**/*.astro'));

export function routes(): string[] {
  const out = new Set<string>();
  for (const f of files) {
    let p = f.replace(/^\.\//, '').replace(/\.astro$/, '').replace(/(^|\/)index$/, '');
    if (p === '404' || p.includes('[')) continue;
    out.add('/' + (p ? p + '/' : ''));
  }
  out.add(`/app/lots/${RUN.meta.lot}/`);
  out.add(`/app/opportunities/${RUN.meta.oppHash.slice(2, 10)}/`);
  for (const e of buildManifest().entries) out.add(e.path.endsWith('/') ? e.path : e.path + '/');
  return [...out].sort((a, b) => a.length - b.length || a.localeCompare(b));
}

export const GET: APIRoute = () => {
  const body = '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
    + routes().map((r) => `<url><loc>${SITE_ORIGIN}${r}</loc></url>`).join('\n') + '\n</urlset>\n';
  return new Response(body, { headers: { 'content-type': 'application/xml; charset=utf-8' } });
};
