// Time-to-ready probe for /market (Playwright from the repo-root node_modules, read-only; real public RPC for chain data; no Worker needed).
//
// "Ready" = the moment [data-testid=market-terminal] has data-ready="true" AND the first [data-testid=last-price] shows a real dollar price
// (the selected market is the default one: the first market that traded). It is measured IN the page from navigation start
// (performance.now()), by a MutationObserver installed before any page script runs. Alongside: eth_getLogs requests started by that moment,
// total RPC requests, bytes transferred (RPC responses + the snapshot body) and every console error / unhandled rejection.
//
// Three scenarios, each repeated --runs times (default 3), thresholds applied to the MEDIAN (and no run above 2x the target):
//   cold      empty IndexedDB, GET /api/market/snapshot answered by a Playwright route with a real MarketSnapshot   < 3000 ms, data-source=snapshot
//   warm      second visit in the SAME browser context after the app wrote its IndexedDB cache; the snapshot request is
//             held (the cache must not wait for the server)                                                           < 1500 ms, data-source=cache, <= 3 getLogs
//   fallback  snapshot route answers 503, indexedDB access throws (blocked storage), 390 px: baked history + chain tail  < 8000 ms, data-source=baked
// The static preview has no /api/market/snapshot (only the Worker has), so the snapshot body is built here, in-process, from the repo's own
// code: the baked history (src/data/blindbook-history.json) decoded with market-baked.bakedEvents, then the blocks above its head read from
// the real RPC (eth_getLogs, 5000-block chunks), decoded and folded with market-core.applyEvents, packed with market-snap.buildSnapshot and
// checked with validateSnapshot. It is the same content the Worker would serve (cursor = head - 20, complete) minus the D1 round trip.
// It is refreshed before every run (one getLogs request outside the page), so the page always has a small gap to read, like with the cron.
// The route answers instantly (no network latency for the snapshot); use --snapshot-delay MS to add the Worker's round trip.
//
// Then the real IndexedDB path (the repo's own market-cache.ts bundled with esbuild into a page on the same origin): the 'kv' object store
// is created on upgrade, 1 MB and 2.9 MB round trips, persistence across a page close/reopen, open+get+parse+validate within 800 ms,
// corrupt and foreign entries dropped, blocked storage / quota / aborted transaction / hung open all degrade silently.
//
//   node scripts/market-probe.cjs [BASE_URL] [--runs 3] [--report-only] [--snapshot-delay MS] [--profile] [--width 1440]
// --width sets the cold and warm viewport (fallback is always 390 px); the 3D stage is a big main-thread cost in headless Chromium (software GL), so a phone width shows the data path alone.
// Every run also prints busy=NNN ms, the main-thread long-task time before ready (where the time went); --profile adds a CDP cpu profile of the
// first run of each scenario (self time per script and function up to ready + settle).
// Without a BASE_URL it serves apps/web/dist on a free 127.0.0.1 port (npm run build first). Exit 0 all targets met, 1 any miss (0 with
// --report-only), 2 no build / server / RPC. The whole probe must finish in 4 minutes (a run that would exceed it is reported as a failure).
'use strict';
const { chromium } = require('playwright');
const { spawn } = require('node:child_process');
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');
const fs = require('node:fs'); const path = require('node:path');
const lib = require('./market-probe-lib.cjs');
const assets = require('./probe-assets-lib.cjs');

const ARGS = lib.parseArgs(process.argv.slice(2), process.env);
if (ARGS.help || ARGS.unknown.length) {
  console.log('usage: node scripts/market-probe.cjs [BASE_URL] [--runs N] [--report-only] [--snapshot-delay MS] [--profile] [--width PX]\n  no BASE_URL: serves apps/web/dist on a free port (npm run build first)');
  process.exit(ARGS.unknown.length ? 2 : 0);
}
const T0 = Date.now();
const WEB = path.join(__dirname, '../apps/web'); const DIST = path.join(WEB, 'dist');
const RPC = process.env.ROBINHOOD_RPC || 'https://rpc.testnet.chain.robinhood.com'; const RPC_HOST = new URL(RPC).host;
const DEP = JSON.parse(fs.readFileSync(path.join(WEB, 'src/data/blindbook.json'), 'utf8'));
const CATALOG = JSON.parse(fs.readFileSync(path.join(WEB, 'src/data/catalog.json'), 'utf8')).markets;
const ID = { chainId: DEP.chainId, book: DEP.book.toLowerCase(), deployBlock: DEP.deployBlock };
const GL_ARGS = ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist']; // as scripts/e2e-market.cjs
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const kb = (n) => `${Math.round(n / 1024)} KB`;
const log = (...a) => console.log(...a);

// static server (free port + identity check, as probe-assets.cjs)
const freePort = () => new Promise((res, rej) => { const srv = require('node:net').createServer(); srv.once('error', rej); srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => res(port)); }); });
async function startServer() {
  const index = path.join(DIST, 'market/index.html');
  if (!fs.existsSync(index)) { console.error(`no build at ${DIST}: run (cd apps/web && npm run -s build) first, or pass a BASE_URL`); process.exit(2); }
  const want = fs.readFileSync(index, 'utf8'); const port = await freePort();
  const child = spawn(process.execPath, [path.join(__dirname, 'static-server.cjs'), DIST, String(port)], { stdio: 'ignore' });
  for (let i = 0; i < 50; i++) { try { const r = await fetch(`http://127.0.0.1:${port}/market/`); if (r.ok && (await r.text()) === want) return { child, base: `http://127.0.0.1:${port}` }; } catch { /* not up yet */ } await sleep(100); }
  child.kill(); console.error('static server did not start (or served something else)'); process.exit(2);
}

// the snapshot, built from the repo's own code
const imp = (rel) => import(pathToFileURL(path.join(WEB, rel)).href);
async function createSnapshotBuilder() {
  const [core, snap, baked, abi] = await Promise.all([imp('src/lib/market-core.ts'), imp('src/lib/market-snap.ts'), imp('src/lib/market-baked.ts'), imp('src/lib/book-abi.ts')]);
  const viem = createRequire(path.join(WEB, 'package.json'))('viem');
  const chain = viem.defineChain({ id: ID.chainId, name: 'robinhood-testnet', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
  const client = viem.createPublicClient({ chain, transport: viem.http(RPC, { timeout: 20_000, retryCount: 3 }) });
  const read = (fn) => client.readContract({ address: DEP.book, abi: abi.BOOK_ABI, functionName: fn });
  const [t0, epochLen, commitEnd, revealEnd, bond] = await Promise.all(['t0', 'epochLen', 'commitEnd', 'revealEnd', 'bond'].map(read));
  const schedule = { t0: Number(t0), epochLen: Number(epochLen), commitEnd: Number(commitEnd), revealEnd: Number(revealEnd), bond: Number(bond) };
  const history = JSON.parse(fs.readFileSync(path.join(WEB, 'src/data/blindbook-history.json'), 'utf8'));
  const base = baked.bakedEvents(history, ID);
  if (!base) throw new Error('src/data/blindbook-history.json is not valid for this deployment (bakedEvents returned null)');
  const ledger = core.newLedger(); core.applyEvents(ledger, base.events, schedule);
  let cursor = base.head; let built = null; let tailEvents = 0; let tailRequests = 0;
  const hex = (n) => '0x' + n.toString(16);
  async function advance() {
    const head = Number(await client.getBlockNumber()); const to = head - 20;   // stay clear of the tip, like tools/market-snapshot.ts
    for (let from = cursor + 1; from <= to; from += 5000) {
      const r = { from, to: Math.min(to, from + 4999) };
      const logs = await client.request({ method: 'eth_getLogs', params: [{ address: DEP.book, fromBlock: hex(r.from), toBlock: hex(r.to), topics: [core.MARKET_TOPICS] }] });
      const events = core.decodeLogs(logs).filter((e) => e.block >= r.from && e.block <= r.to);
      core.applyEvents(ledger, events, schedule); tailEvents += events.length; tailRequests++;
    }
    if (to > cursor) cursor = to;
    const blk = await client.getBlock({ blockNumber: BigInt(head) });
    const s = snap.validateSnapshot(snap.buildSnapshot(ledger, { ...ID, cursor, head, headTime: Number(blk.timestamp), builtAt: Date.now(), complete: true }, schedule), ID);
    if (!s) throw new Error('the snapshot built from the baked history and the chain failed validateSnapshot');
    built = { snap: s, body: JSON.stringify(s), head };
    return built;
  }
  // the default market the page must open on (pickDefaultMarket: the first catalog market with a clearing price)
  function expectedSelected() {
    const pts = core.clearPoints(ledger);
    const opts = CATALOG.map((m) => ({ symbol: m.symbol, last: core.summarize(pts[viem.keccak256(viem.toHex(m.id)).toLowerCase()] ?? []).last }));
    return opts[assets.pickDefault(opts, '')].symbol;
  }
  return { advance, expectedSelected, info: () => ({ bakedHead: base.head, bakedEvents: base.events.length, tailEvents, tailRequests, cursor, schedule }) };
}

// one page visit
// Runs inside the page before any script: records the first moment the terminal is ready with a real price.
const READY_SCRIPT = `(() => {
  window.__lt = []; try { new PerformanceObserver((l) => l.getEntries().forEach((e) => window.__lt.push([e.startTime, e.duration]))).observe({ entryTypes: ['longtask'] }); } catch (e) { /* no longtask support */ }
  const RE = /^\\$\\d{1,3}(?:,\\d{3})*\\.\\d{2}$|^\\$\\d+\\.\\d{2}$/; let done = false;
  const check = () => {
    if (done) return;
    const t = document.querySelector('[data-testid="market-terminal"]'); if (!t || t.getAttribute('data-ready') !== 'true') return;
    const lp = document.querySelector('[data-testid="last-price"]'); const price = lp ? lp.textContent.trim() : '';
    if (!RE.test(price) || price === '$0.00') return;
    done = true; obs.disconnect();
    window.__ready = { ms: Math.round(performance.now()), source: t.getAttribute('data-source'), history: t.getAttribute('data-history'), selected: t.getAttribute('data-selected'), price };
    try { window.__probeReady(); } catch (e) { /* binding missing: the poller in the probe still sees __ready */ }
  };
  const obs = new MutationObserver(check); obs.observe(document, { subtree: true, childList: true, attributes: true, characterData: true }); check();
})();`;
const BLOCK_IDB_SCRIPT = `Object.defineProperty(window, 'indexedDB', { configurable: true, get() { throw new DOMException('storage blocked', 'SecurityError'); } });`;

/** mode: 'serve' (snapshot answered), 'hold' (snapshot request not answered for 6 s), 'fail' (503). */
async function visit(ctx, base, { snapshot, mode, blockIdb = false, delay = 0, settleMs = 800, profile = false }) {
  const rec = { rpcReqs: 0, getLogs: 0, rpcBytes: 0, snapBytes: 0, rpcFailed: 0, errors: [], atReady: null };
  const page = await ctx.newPage();
  page.on('pageerror', (e) => rec.errors.push(`pageerror: ${String(e).slice(0, 140)}`));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    if (lib.isExpectedConsoleError({ text: m.text(), url: m.location().url })) return;
    rec.errors.push(`console: ${m.text().slice(0, 140)}`);
  });
  page.on('request', (req) => { if (new URL(req.url()).host === RPC_HOST) { rec.rpcReqs++; rec.getLogs += lib.countGetLogs(req.postData()); } });
  page.on('requestfinished', async (req) => { if (new URL(req.url()).host !== RPC_HOST) return; try { const s = await req.sizes(); rec.rpcBytes += s.responseBodySize + s.responseHeadersSize; } catch { /* page closed */ } });
  page.on('requestfailed', (req) => { if (new URL(req.url()).host === RPC_HOST) rec.rpcFailed++; });
  await page.exposeFunction('__probeReady', () => { rec.atReady = { rpcReqs: rec.rpcReqs, getLogs: rec.getLogs }; });
  await page.route('**/api/market/snapshot*', async (route) => {
    try {
      if (mode === 'serve') { if (delay) await sleep(delay); rec.snapBytes += snapshot.body.length; await route.fulfill({ status: 200, contentType: 'application/json', body: snapshot.body }); }
      else if (mode === 'hold') { await sleep(6000); await route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"held"}' }); }
      else await route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"unavailable"}' });
    } catch { /* page closed while the route was waiting */ }
  });
  await page.route('**/api/market/ping', (route) => route.fulfill({ status: 204 }));   // the Worker answers the keeper-bots ping; the static preview has no such route
  if (blockIdb) await page.addInitScript(BLOCK_IDB_SCRIPT);
  await page.addInitScript(READY_SCRIPT);
  let cdp = null; if (profile) { cdp = await ctx.newCDPSession(page); await cdp.send('Profiler.enable'); await cdp.send('Profiler.setSamplingInterval', { interval: 250 }); await cdp.send('Profiler.start'); }
  await page.goto(`${base}/market/`, { waitUntil: 'commit', timeout: 30_000 });
  await page.waitForFunction(() => !!window.__ready, null, { timeout: 40_000, polling: 25 });
  const ready = await page.evaluate(() => window.__ready);
  const at = rec.atReady ?? { rpcReqs: rec.rpcReqs, getLogs: rec.getLogs };
  await sleep(settleMs);   // let the requests that follow ready (the poll, the rest of the backfill) show up in the totals
  const longTasks = await page.evaluate(() => window.__lt).catch(() => []);
  const prof = cdp ? lib.selfTimeTop((await cdp.send('Profiler.stop')).profile, 6) : null;
  return { page, rec, prof, run: { ms: ready.ms, busy: Math.round(lib.busyBefore(longTasks, ready.ms)), source: ready.source, history: ready.history, selected: ready.selected, price: ready.price, getLogsAtReady: at.getLogs, rpcAtReady: at.rpcReqs, getLogsTotal: rec.getLogs, rpcTotal: rec.rpcReqs, rpcBytes: rec.rpcBytes, snapBytes: rec.snapBytes, rpcFailed: rec.rpcFailed, errors: rec.errors } };
}

/** Waits until the app's own IndexedDB cache entry exists in this context (the write happens when the page is idle after the gap is loaded). */
async function waitForCacheEntry(page, timeout = 30_000) {
  try {
    await page.waitForFunction(async () => {
      const dbs = await indexedDB.databases(); if (!dbs.some((d) => d.name === 'skudesk-market')) return false;   // never open a DB that does not exist yet: that would create it without its store
      return new Promise((resolve) => {
        const req = indexedDB.open('skudesk-market');
        req.onerror = () => resolve(false);
        req.onsuccess = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains('kv')) { db.close(); resolve(false); return; }
          const g = db.transaction('kv', 'readonly').objectStore('kv').get('market-snapshot');
          g.onsuccess = () => { db.close(); resolve(typeof g.result === 'string' && g.result.length > 0 ? g.result.length : false); };
          g.onerror = () => { db.close(); resolve(false); };
        };
      });
    }, null, { timeout, polling: 250 });
    return true;
  } catch { return false; }
}

// real IndexedDB path
const CACHE_BUNDLE_SRC = `
import { indexedDbKV, readCache, writeCache, cacheId, CACHE_KEY, CACHE_MAX_BYTES, CACHE_READ_TIMEOUT_MS } from './src/lib/market-cache.ts';
import { validateSnapshot } from './src/lib/market-snap.ts';
window.__mc = { indexedDbKV, readCache, writeCache, cacheId, CACHE_KEY, CACHE_MAX_BYTES, CACHE_READ_TIMEOUT_MS, validateSnapshot };`;
function bundleCache() {
  const esbuild = require('esbuild');
  const r = esbuild.buildSync({ stdin: { contents: CACHE_BUNDLE_SRC, resolveDir: WEB, loader: 'ts', sourcefile: 'cache-entry.ts' }, bundle: true, format: 'iife', platform: 'browser', target: 'es2022', write: false, logLevel: 'silent' });
  return r.outputFiles[0].text;
}
async function probePage(ctx, base, bundle, errs) {
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errs.push(`pageerror: ${String(e).slice(0, 140)}`));
  page.on('console', (m) => { if (m.type() === 'error') errs.push(`console: ${m.text().slice(0, 140)}`); });
  await page.route(`${base}/__probe/blank`, (r) => r.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>probe</title>' }));
  await page.goto(`${base}/__probe/blank`, { waitUntil: 'domcontentloaded' });
  await page.addScriptTag({ content: bundle });
  return page;
}
async function idbChecks(browser, base) {
  const bundle = bundleCache(); const checks = []; const errs = [];
  const add = (cs) => checks.push(...cs);
  const small = lib.syntheticSnapshot(ID, 1_000_000), big = lib.syntheticSnapshot(ID, 2_900_000), tooBig = lib.syntheticSnapshot(ID, 3_200_000);
  const foreign = lib.syntheticSnapshot({ ...ID, deployBlock: ID.deployBlock + 1 }, 1_000_000);
  const sizes = { small: JSON.stringify(small).length, big: JSON.stringify(big).length };

  // A: a fresh profile: store creation, round trips, persistence across a closed page
  const ctxA = await browser.newContext(); const pa = await probePage(ctxA, base, bundle, errs);
  add(await pa.evaluate(async ({ ID, small, big, tooBig }) => {
    const mc = window.__mc; const out = []; const rec = (key, ok, detail, ms) => out.push({ key, ok, detail, ms });
    const rawOpen = () => new Promise((res, rej) => { const q = indexedDB.open('skudesk-market'); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
    const before = (await indexedDB.databases()).some((d) => d.name === 'skudesk-market');
    const kv = mc.indexedDbKV(); const miss = await kv.get('absent');
    const db = await rawOpen(); const stores = [...db.objectStoreNames]; const version = db.version; db.close();
    rec('kv-store-created-on-upgrade', !before && miss === undefined && version === 1 && stores.length === 1 && stores[0] === 'kv', `db existed before: ${before}, version ${version}, stores [${stores}]`);
    for (const [name, snap] of [['1MB', small], ['2.9MB', big]]) {
      const now = Date.now(); const wrote = await mc.writeCache(kv, ID, snap, now);
      const t = performance.now(); const back = await mc.readCache(mc.indexedDbKV(), ID, now + 1000); const ms = Math.round(performance.now() - t);   // a fresh handle: includes the open
      const same = !!back && back.cursor === snap.cursor && back.hot.books.length === snap.hot.books.length && JSON.stringify(back).length === JSON.stringify(snap).length;
      rec(`roundtrip-${name}`, wrote === true && same, `write ${wrote}, ${JSON.stringify(snap).length} bytes, read back identical: ${same}`);
      rec(`read-${name}-within-800ms`, ms < 800, `open+get+parse+validate ${ms} ms`, ms);
    }
    const capWrote = await mc.writeCache(kv, ID, tooBig, Date.now());
    rec('over-cap-write-refused', capWrote === false && (await mc.readCache(kv, ID, Date.now())) !== null, `a ${JSON.stringify(tooBig).length}-char snapshot: write ${capWrote}; the 2.9MB entry is still readable`);
    // leaves the 2.9 MB entry behind for the reopened page below
    await mc.writeCache(kv, ID, big, Date.now());
    return out;
  }, { ID, small, big, tooBig }));
  await pa.close();
  const pb = await probePage(ctxA, base, bundle, errs);   // a new page (new JS realm, new DB connection) in the same profile
  add(await pb.evaluate(async ({ ID, big, foreign }) => {
    const mc = window.__mc; const out = []; const rec = (key, ok, detail, ms) => out.push({ key, ok, detail, ms });
    const t = performance.now(); const back = await mc.readCache(mc.indexedDbKV(), ID, Date.now() + 1000); const ms = Math.round(performance.now() - t);
    rec('persists-across-reopen', !!back && back.hot.books.length === big.hot.books.length && back.cursor === big.cursor, `2.9MB entry read after the page was closed and reopened: ${back ? 'valid' : 'missing'}`);
    rec('read-after-reopen-within-800ms', ms < 800, `open+get+parse+validate ${ms} ms`, ms);
    const kv = mc.indexedDbKV();
    // a corrupt entry reads as no cache and is deleted
    await new Promise((res, rej) => { const q = indexedDB.open('skudesk-market'); q.onsuccess = () => { const db = q.result; const tx = db.transaction('kv', 'readwrite'); tx.objectStore('kv').put('{not json', mc.CACHE_KEY); tx.oncomplete = () => { db.close(); res(); }; tx.onerror = () => rej(tx.error); }; q.onerror = () => rej(q.error); });
    const corrupt = await mc.readCache(kv, ID, Date.now()); await new Promise((r) => setTimeout(r, 300)); const left = await kv.get(mc.CACHE_KEY);
    rec('corrupt-entry-dropped', corrupt === null && left === undefined, `read ${corrupt === null ? 'null' : 'a snapshot'}, entry afterwards ${left === undefined ? 'deleted' : 'still there'}`);
    // an entry of another deployment reads as no cache and is deleted
    await mc.writeCache(kv, { ...ID, deployBlock: ID.deployBlock + 1 }, foreign, Date.now());
    const other = await mc.readCache(kv, ID, Date.now()); await new Promise((r) => setTimeout(r, 300)); const left2 = await kv.get(mc.CACHE_KEY);
    rec('foreign-deployment-entry-dropped', other === null && left2 === undefined, `read ${other === null ? 'null' : 'a snapshot'}, entry afterwards ${left2 === undefined ? 'deleted' : 'still there'}`);
    return out;
  }, { ID, big, foreign }));
  await pb.close(); await ctxA.close();

  // B: blocked storage (the indexedDB getter throws SecurityError)
  const ctxB = await browser.newContext(); await ctxB.addInitScript(BLOCK_IDB_SCRIPT); const pbl = await probePage(ctxB, base, bundle, errs);
  add(await pbl.evaluate(async ({ ID, small }) => {
    const mc = window.__mc; const out = []; const rec = (key, ok, detail, ms) => out.push({ key, ok, detail, ms });
    let threw = false; try { void indexedDB; } catch { threw = true; }
    const kv = mc.indexedDbKV(); const t = performance.now(); let r = 'x', w = 'x', thrown = null;
    try { r = await mc.readCache(kv, ID, Date.now()); w = await mc.writeCache(kv, ID, small, Date.now()); } catch (e) { thrown = String(e); }
    const ms = Math.round(performance.now() - t);
    rec('blocked-storage-degrades-silently', threw && thrown === null && r === null && w === false, `the indexedDB getter throws: ${threw}; readCache ${r === null ? 'null' : r}, writeCache ${w}, thrown ${thrown}`, ms);
    return out;
  }, { ID, small }));
  await ctxB.close();

  // C: quota error, aborted transaction, hung open (patched at run time in a fresh profile)
  const ctxC = await browser.newContext(); const pc = await probePage(ctxC, base, bundle, errs);
  add(await pc.evaluate(async ({ ID, small }) => {
    const mc = window.__mc; const out = []; const rec = (key, ok, detail, ms) => out.push({ key, ok, detail, ms });
    const proto = IDBObjectStore.prototype; const put = proto.put;
    proto.put = function () { throw new DOMException('quota', 'QuotaExceededError'); };
    let w1 = 'x', t1 = null; try { w1 = await mc.writeCache(mc.indexedDbKV(), ID, small, Date.now()); } catch (e) { t1 = String(e); }
    proto.put = function (...a) { const r = put.apply(this, a); this.transaction.abort(); return r; };
    let w2 = 'x', t2 = null; try { w2 = await mc.writeCache(mc.indexedDbKV(), ID, small, Date.now()); } catch (e) { t2 = String(e); }
    proto.put = put;
    const none = await mc.readCache(mc.indexedDbKV(), ID, Date.now());
    rec('quota-error-degrades-silently', w1 === false && t1 === null, `put throws QuotaExceededError: writeCache ${w1}, thrown ${t1}`);
    rec('aborted-transaction-degrades-silently', w2 === false && t2 === null && none === null, `transaction aborted after put: writeCache ${w2}, thrown ${t2}, nothing stored: ${none === null}`);
    const open = indexedDB.open; indexedDB.open = function () { return {}; };   // a request that never answers
    const t = performance.now(); let h = 'x', t3 = null; try { h = await mc.readCache(mc.indexedDbKV(), ID, Date.now()); } catch (e) { t3 = String(e); }
    const ms = Math.round(performance.now() - t); indexedDB.open = open;
    rec('hung-open-gives-up-at-the-read-timeout', h === null && t3 === null && ms >= mc.CACHE_READ_TIMEOUT_MS - 50 && ms < mc.CACHE_READ_TIMEOUT_MS + 700, `a hung open returned null after ${ms} ms (timeout ${mc.CACHE_READ_TIMEOUT_MS} ms)`, ms);
    return out;
  }, { ID, small }));
  await ctxC.close();
  checks.push({ key: 'no-page-errors', ok: errs.length === 0, detail: errs.length ? errs.slice(0, 3).join(' | ') : 'no console errors or unhandled rejections' });
  return { checks, sizes };
}

// main
(async () => {
  let server = null, browser = null; let failures = 0; let exit = 0;
  try {
    server = ARGS.base ? null : await startServer(); const BASE = ARGS.base ?? server.base;
    log(`market-probe: ${BASE}  runs ${ARGS.runs}  rpc ${RPC_HOST}  snapshot delay ${ARGS.snapshotDelay} ms`);
    let builder;
    try { builder = await createSnapshotBuilder(); await builder.advance(); }
    catch (e) { console.error(`cannot build the snapshot from the baked history and the chain: ${e.message}`); exit = 2; return; }
    const i0 = builder.info(); const expectedSelected = builder.expectedSelected();
    log(`snapshot: baked history to block ${i0.bakedHead} (${i0.bakedEvents} events) + ${i0.tailEvents} chain events in ${i0.tailRequests} getLogs -> cursor ${i0.cursor}; default market ${expectedSelected}`);
    browser = await chromium.launch({ args: GL_ARGS });
    const runs = { cold: [], warm: [], fallback: [] }; let aborted = null;
    const showProf = (name, p) => { if (!p) return; log(`  cpu self time (${name}, navigation to ready + settle): scripts ${p.byScript.map((x) => `${x.key} ${x.ms}`).join(', ')}`); log(`    functions ${p.byFunction.map((x) => `${x.key} ${x.ms}`).join(' | ')}`); };
    for (let i = 0; i < ARGS.runs; i++) {
      if (lib.overBudget(T0, Date.now() + 40_000)) { aborted = `stopped before run ${i + 1}: the 4 minute budget would be exceeded`; break; }
      const snapshot = await builder.advance();
      const fmt = (name, r) => log(`${name.padEnd(8)} run ${i + 1}: ${String(r.ms).padStart(5)} ms  source=${r.source}  ${r.selected}=${r.price}  getLogs@ready=${r.getLogsAtReady}  rpc@ready=${r.rpcAtReady}  busy=${r.busy} ms  total getLogs=${r.getLogsTotal} rpc=${r.rpcTotal}  ${kb(r.rpcBytes)} rpc + ${kb(r.snapBytes)} snapshot${r.rpcFailed ? `  rpc failed=${r.rpcFailed}` : ''}${r.errors.length ? `  ERRORS ${r.errors.length}` : ''}`);
      // cold, then warm in the same context (same IndexedDB)
      const ctx = await browser.newContext({ viewport: { width: ARGS.width, height: 900 } });
      const prof = ARGS.profile && i === 0; const cold = await visit(ctx, BASE, { snapshot, mode: 'serve', delay: ARGS.snapshotDelay, profile: prof }); runs.cold.push(cold.run); fmt('cold', cold.run); showProf('cold', cold.prof);
      const cached = await waitForCacheEntry(cold.page); if (!cached) log('  note: the app did not write its IndexedDB cache within 30 s');
      await cold.page.close();
      const warm = await visit(ctx, BASE, { snapshot, mode: 'hold', profile: prof }); runs.warm.push(warm.run); fmt('warm', warm.run); showProf('warm', warm.prof);
      await warm.page.close(); await ctx.close();
      // fallback: no snapshot, storage blocked, phone width
      const fctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
      const fb = await visit(fctx, BASE, { snapshot, mode: 'fail', blockIdb: true, profile: prof }); runs.fallback.push(fb.run); fmt('fallback', fb.run); showProf('fallback', fb.prof);
      await fb.page.close(); await fctx.close();
    }
    const verdicts = ['cold', 'warm', 'fallback'].map((n) => lib.judgeScenario(n, runs[n], { selected: expectedSelected }));
    log('\n' + lib.formatTable(verdicts, runs));
    failures += verdicts.filter((v) => !v.ok).length;
    if (aborted) { log(`  FAIL ${aborted}`); failures++; }

    log('\nreal IndexedDB path (the repo\'s own market-cache.ts in Chromium):');
    const idb = await idbChecks(browser, BASE);
    for (const c of idb.checks) log(`${c.ok ? 'ok  ' : 'FAIL'} ${c.key.padEnd(40)} ${c.detail ?? ''}`);
    const iv = lib.judgeIdb(idb.checks); if (!iv.ok) failures++;

    const secs = Math.round((Date.now() - T0) / 1000);
    log(`\nmarket-probe: ${failures ? `${failures} failing part(s)` : 'all targets met'} in ${secs} s${secs * 1000 > lib.TOTAL_BUDGET_MS ? ' (OVER the 4 minute budget)' : ''}`);
    if (secs * 1000 > lib.TOTAL_BUDGET_MS) failures++;
    if (failures && !ARGS.reportOnly) exit = 1;
  } catch (e) { console.error('probe crashed:', e && e.stack ? e.stack : e); exit = 2; }
  finally { try { if (browser) await browser.close(); } catch { /* closed */ } if (server) server.child.kill(); process.exitCode = exit; }
})();
