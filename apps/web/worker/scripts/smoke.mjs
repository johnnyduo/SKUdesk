// Runtime smoke test against `wrangler dev` (local workerd, local KV/D1/rate limits). No credentials needed.
// Usage (from apps/web, after `npx astro build`):  node worker/scripts/smoke.mjs
// Refuses to run when apps/web/.dev.vars, .dev.vars.<env>, .env or .env.* exists (wrangler would load real secrets from them);
// the tracked templates .dev.vars.example and .env.example are exempt;
// set SMOKE_ALLOW_DEV_VARS=1 to override. Only the file NAMES are looked at, never their contents.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { startFakeRpc } from '../../test/market/helpers/fake-rpc.mjs';

// Ask the OS for a free port instead of assuming one: a stale wrangler on a fixed port would be smoke-tested by mistake.
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}
const PORT = await freePort();
const BASE = 'http://127.0.0.1:' + PORT;
// The tracked, value-free templates are NOT secret files; every other .dev.vars* / .env* name is.
const TEMPLATE_NAMES = new Set(['.dev.vars.example', '.env.example']);
const isSecretFile = (n) => !TEMPLATE_NAMES.has(n) && (n === '.dev.vars' || n.startsWith('.dev.vars.') || n === '.env' || n.startsWith('.env.'));
const secretFiles = readdirSync('.').filter(isSecretFile);
if (secretFiles.length && process.env.SMOKE_ALLOW_DEV_VARS !== '1') {
  console.error('apps/web has ' + secretFiles.join(', ') + ' (wrangler would load real secrets from it); move it aside or set SMOKE_ALLOW_DEV_VARS=1');
  process.exit(2);
}
if (!existsSync('dist/index.html')) {
  console.error('dist/ is missing; run `npx astro build` first');
  process.exit(2);
}

// Strips // and /* */ comments outside string literals (JSONC), and trailing commas.
function parseJsonc(src) {
  let out = ''; let i = 0; let inStr = false;
  while (i < src.length) {
    const c = src[i], n = src[i + 1];
    if (inStr) { out += c; if (c === '\\') { out += n ?? ''; i += 2; continue; } if (c === '"') inStr = false; i++; continue; }
    if (c === '"') { inStr = true; out += c; i++; continue; }
    if (c === '/' && n === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '/' && n === '*') { i += 2; while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++; i += 2; continue; }
    out += c; i++;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}
// The site origin is PUBLIC_SITE_ORIGIN of wrangler.jsonc (listing links have to be on it); it is also passed to wrangler dev via --var below.
const SITE = parseJsonc(readFileSync('wrangler.jsonc', 'utf8')).vars?.PUBLIC_SITE_ORIGIN;
if (typeof SITE !== 'string' || !/^https:\/\/[^/]+$/.test(SITE)) { console.error('wrangler.jsonc vars.PUBLIC_SITE_ORIGIN is missing or not an https origin'); process.exit(2); }
const TOKEN = randomBytes(24).toString('hex');
const HERO = {
  lotId: 'LOT-1842',
  title: 'iPhone 16 Pro Clear MagSafe Case',
  link: SITE + '/p/CASE-IP16PRO-CLEAR-MAG-001/',
  imageLink: SITE + '/img/cases-png/iphone-16-pro_clear_mag_1.png',
  priceCents: 1099,
};

// Prefer the locally installed wrangler (root node_modules in this npm workspace); fall back to npx.
function findWrangler() {
  let dir = process.cwd();
  for (let i = 0; i < 5; i++) {
    const bin = join(dir, 'node_modules', '.bin', 'wrangler');
    if (existsSync(bin)) return { cmd: bin, pre: [] };
    dir = dirname(dir);
  }
  return { cmd: 'npx', pre: ['wrangler'] };
}
const W = findWrangler();

// Market ingest runs against a local fake JSON-RPC that serves captured public chain logs: no network, deterministic.
// The fixture was captured from the OLD BlindBook, so the smoke overrides ALL FOUR MARKET_* vars of wrangler.jsonc (which carry the
// real redeployed values) with the fixture's deployment; otherwise the route would answer 503 for a foreign deployment.
// worker/test/smoke-market.test.ts pins these constants to the unit-test fixture and derives MARKET_EXPECT from an in-process ingest.
const MARKET_BOOK = '0x2BA62631d74827aBF2f7467B20370dC2DC59aa11';
const MARKET_CHAIN_ID = 46630;
const MARKET_DEPLOY_BLOCK = 127948000;
const MARKET_HEAD = 127999300;
const MARKET_EXPECT = { cursor: 127999288, hotBooks: 18, maxRuns: 10 };
const MARKET_LOGS = JSON.parse(readFileSync(new URL('../../test/market/fixtures/chain-logs.json', import.meta.url), 'utf8')).logs;
const marketRpc = await startFakeRpc({ logs: MARKET_LOGS, head: MARKET_HEAD });
const persist = mkdtempSync(join(tmpdir(), 'robinize-smoke-'));
const mig = spawnSync(W.cmd, [...W.pre, 'd1', 'migrations', 'apply', 'robinize', '--local', '--persist-to', persist], { encoding: 'utf8', input: 'y\n', timeout: 120_000 });
if (mig.error || mig.status !== 0) {
  console.error(mig.error ? String(mig.error) : mig.stdout + mig.stderr);
  rmSync(persist, { recursive: true, force: true });
  process.exit(1);
}

const dev = spawn(W.cmd, [...W.pre, 'dev', '--port', String(PORT), '--ip', '127.0.0.1', '--persist-to', persist, '--test-scheduled', '--var', 'ADMIN_TOKEN:' + TOKEN,
  '--var', 'MARKET_RPC_URL:' + marketRpc.url, '--var', 'MARKET_BOOK:' + MARKET_BOOK, '--var', 'MARKET_CHAIN_ID:' + MARKET_CHAIN_ID, '--var', 'MARKET_DEPLOY_BLOCK:' + MARKET_DEPLOY_BLOCK, '--var', 'PUBLIC_SITE_ORIGIN:' + SITE], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
let devLog = '';
let devExited = false;
let spawnError = null;
dev.stdout.on('data', (d) => { devLog += d; });
dev.stderr.on('data', (d) => { devLog += d; });
dev.on('error', (err) => { spawnError = err; devExited = true; }); // e.g. ENOENT: the child never started
dev.on('exit', () => { devExited = true; });

// Stop the wrangler process group (SIGTERM, then SIGKILL after 5 s), wait for it to exit, then remove the temp dir.
// Memoized: the signal handlers and the main `finally` share ONE run, and every caller awaits the same promise,
// so the process only exits after the temp dir is gone.
let cleanupP;
const cleanup = () => (cleanupP ??= (async () => {
  if (!devExited && dev.pid) {
    try { process.kill(-dev.pid, 'SIGTERM'); } catch { /* already gone */ }
    for (let i = 0; i < 50 && !devExited; i++) await new Promise((r) => setTimeout(r, 100));
    if (!devExited) {
      try { process.kill(-dev.pid, 'SIGKILL'); } catch { /* already gone */ }
      for (let i = 0; i < 20 && !devExited; i++) await new Promise((r) => setTimeout(r, 100));
    }
  }
  rmSync(persist, { recursive: true, force: true });
  await marketRpc.close();
})());
for (const [sig, code] of [['SIGINT', 130], ['SIGTERM', 143]]) {
  process.on(sig, () => { cleanup().finally(() => process.exit(code)); });
}

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : '  ' + detail));
}
async function req(path, init = {}) {
  const res = await fetch(BASE + path, { ...init, signal: AbortSignal.timeout(15_000) });
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { body = null; }
  return { status: res.status, headers: res.headers, text, body };
}
const postListing = (body, headers = {}) => req('/api/merchant/listing', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

async function waitReady() {
  for (let i = 0; i < 60 && !devExited; i++) {
    try { const r = await fetch(BASE + '/api/health', { signal: AbortSignal.timeout(5_000) }); if (r.ok) return true; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

try {
  if (!(await waitReady())) throw new Error((spawnError ? 'could not start wrangler: ' + spawnError.code : devExited ? 'wrangler dev exited early' : 'wrangler dev did not start') + ':\n' + devLog);

  const home = await req('/');
  check('static / served from assets', home.status === 200 && home.text.includes('<html'), String(home.status));
  const integ = await req('/app/integrations/');
  check('static /app/integrations/ served', integ.status === 200, String(integ.status));
  const manifest = await req('/p/manifest.json');
  check('build manifest present', manifest.status === 200 && manifest.body?.version === 1, String(manifest.status));

  const health = await req('/api/health');
  check('GET /api/health ok + x-request-id', health.status === 200 && health.body?.ok === true && Boolean(health.headers.get('x-request-id')));
  const nf = await req('/api/nope');
  check('unknown /api route -> 404 envelope', nf.status === 404 && nf.body?.error?.code === 'NOT_FOUND');

  const st = await req('/api/merchant/status');
  check('merchant status MOCK without secrets', st.status === 200 && st.body?.mode === 'MOCK', st.text);

  const dry = await postListing(HERO);
  check('publish defaults to DRY_RUN', dry.status === 200 && dry.body?.mode === 'DRY_RUN', dry.text);
  const noTok = await postListing({ ...HERO, dryRun: false });
  check('live publish without token -> 401', noTok.status === 401 && noTok.body?.error?.code === 'UNAUTHORIZED', noTok.text);
  const tokNoCfg = await postListing({ ...HERO, dryRun: false }, { 'x-admin-token': TOKEN });
  check('live publish with token but no merchant secrets -> 503', tokNoCfg.status === 503 && tokNoCfg.body?.error?.code === 'NOT_CONFIGURED', tokNoCfg.text);
  const xo = await postListing(HERO, { origin: 'https://evil.test' });
  check('cross-origin publish -> 403', xo.status === 403 && xo.body?.error?.code === 'FORBIDDEN_ORIGIN', xo.text);

  const src = await req('/api/prices/sources');
  check('price sources all MOCK without keys', src.status === 200 && src.body?.sources?.length === 3 && src.body.sources.every((s) => s.mode === 'MOCK'), src.text);
  const cmp = await req('/api/prices/compare?sku=CASE-IP16PRO-CLEAR-MAG-001');
  check('compare works without credentials (all_mock)', cmp.status === 200 && cmp.body?.flags?.includes('all_mock'), cmp.text);
  const badCmp = await req('/api/prices/compare?gtin=850063102441');
  check('compare rejects bad GTIN checksum', badCmp.status === 400 && badCmp.body?.error?.code === 'BAD_REQUEST', badCmp.text);

  const cron = await req('/cdn-cgi/handler/scheduled?cron=*/15+*+*+*+*');
  check('scheduled handler runs', cron.status === 200, cron.text);

  // Market snapshot: nothing is built before the first ingest run.
  const notYet = await req('/api/market/snapshot');
  check('market snapshot 503 before the first ingest', notYet.status === 503 && notYet.body?.error?.code === 'SNAPSHOT_UNAVAILABLE', notYet.text);
  // The every-minute trigger runs the market ingest except at minutes 0/15/30/45 (reconcile). Minute 1 plus multiples of 3 minutes is
  // never a quarter hour. The requests are sequential and each run releases its lease, so none answers 'busy'. Catch-up needs 7 runs
  // (51k blocks at a bounded window per run); extra runs after it are no-ops that only refresh the cursor row.
  const ingestAt = (i) => Date.UTC(2026, 9, 3, 12, 1, 0) + i * 3 * 60_000;
  let ingestOk = true;
  for (let i = 0; i < MARKET_EXPECT.maxRuns; i++) ingestOk = (await req('/cdn-cgi/handler/scheduled?cron=*+*+*+*+*&time=' + ingestAt(i))).status === 200 && ingestOk;
  check('market ingest scheduled runs answered 200', ingestOk);
  const snap = await req('/api/market/snapshot');
  check('market snapshot served after ingest (complete, cacheable, hot books)', snap.status === 200 && snap.body?.v === 1 && snap.body?.complete === true && snap.body?.cursor === MARKET_EXPECT.cursor && snap.body?.hot?.books?.length === MARKET_EXPECT.hotBooks && /s-maxage=30/.test(snap.headers.get('cache-control') ?? ''), snap.text.slice(0, 300));
  const etag = snap.headers.get('etag') ?? '';
  const cond = await req('/api/market/snapshot', { headers: { 'if-none-match': etag } });
  check('market snapshot ETag -> 304', etag.length > 0 && cond.status === 304, String(cond.status));
  check('market ingest used only the local fake RPC', marketRpc.calls.includes('eth_getLogs') && marketRpc.logRanges.length > 0);

  let limited = false;
  for (let i = 0; i < 8 && !limited; i++) limited = (await postListing(HERO)).status === 429;
  check('RL_WRITE returns 429 after the limit', limited);

  // Caveat: wrangler dev redacts/does not echo --var values, so this check cannot fail in every configuration.
  // It only proves the token did not leak through our own logging into the dev process output.
  check('no admin token in dev output', !devLog.includes(TOKEN));
} catch (err) {
  check('smoke run', false, String(err));
} finally {
  await cleanup();
}

const failed = results.filter((r) => !r.ok).length;
console.log(failed ? failed + ' smoke check(s) FAILED' : 'all ' + results.length + ' smoke checks passed');
process.exit(failed ? 1 : 0);
