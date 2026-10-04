import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.json': 'application/json', '.woff2': 'font/woff2', '.glb': 'model/gltf-binary' };

/** Serve one or more directories (first match wins). `/x/` falls back to `/x/index.html`. */
export async function serve(dirs, port = 0) {
  const roots = Array.isArray(dirs) ? dirs : [dirs];
  const server = http.createServer(async (req, res) => {
    const url = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    for (const root of roots) {
      let file = path.join(root, url);
      if (!file.startsWith(root)) continue;
      try {
        const st = await stat(file);
        if (st.isDirectory()) file = path.join(file, 'index.html');
        const body = await readFile(file);
        res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream' });
        return res.end(body);
      } catch { /* try next root */ }
    }
    res.writeHead(404); res.end('not found');
  });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
}
