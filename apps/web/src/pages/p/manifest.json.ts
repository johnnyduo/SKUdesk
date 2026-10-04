// Emitted at build time as /p/manifest.json. The Worker reads it through the ASSETS binding to refuse
// listings whose link, image or price do not match a real landing page.
import type { APIRoute } from 'astro';
import { buildManifest } from '../../lib/listing';

export const GET: APIRoute = () =>
  new Response(JSON.stringify(buildManifest()), { headers: { 'content-type': 'application/json; charset=utf-8' } });
