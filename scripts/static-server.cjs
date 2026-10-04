// Tiny static file server for the built site (used by the verification scripts). Usage: node scripts/static-server.cjs <dir> <port>
const http = require('http'), fs = require('fs'), path = require('path');
const root = path.resolve(process.argv[2]), port = Number(process.argv[3]);
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.txt': 'text/plain', '.xml': 'application/xml', '.map': 'application/json', '.webmanifest': 'application/manifest+json', '.glb': 'model/gltf-binary' };
http.createServer((req, res) => {
  let p; try { p = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch { res.writeHead(400); return res.end('bad request'); }   // a malformed %-escape must not crash the server
  let f = path.join(root, p);
  if (f !== root && !f.startsWith(root + path.sep)) { res.writeHead(403); return res.end(); }                                                 // never leave the root (also not via a sibling like dist-evil)
  try { if (fs.statSync(f).isDirectory()) { if (!p.endsWith('/')) { res.writeHead(301, { Location: p + '/' }); return res.end(); } f = path.join(f, 'index.html'); } } catch { res.writeHead(404); return res.end('not found'); }
  fs.readFile(f, (e, d) => { if (e) { res.writeHead(404); return res.end('not found'); } res.writeHead(200, { 'content-type': types[path.extname(f)] || 'application/octet-stream', 'cache-control': 'no-store' }); res.end(d); });
}).listen(port, '127.0.0.1', () => console.log('serving', root, port));
