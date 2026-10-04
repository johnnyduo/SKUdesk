// Browser end-to-end checks against a running build. Usage: node scripts/e2e-browser.cjs http://127.0.0.1:4394
// Asserts, for every route at desktop and mobile widths: HTTP 200, no page or console errors, no horizontal overflow.
// Then: the Show plays to the end on real data, the Overview reads the live chain, and every simulator preset
// returns the expected verdict from the REAL deployed contract (eth_call).
const { chromium } = require('playwright');
const BASE = process.argv[2] || 'http://127.0.0.1:4394';
const RUN = JSON.parse(require('node:fs').readFileSync(require('node:path').join(__dirname, '../apps/web/src/data/run.json'), 'utf8'));
const REALIZED = ((Number(RUN.end.totalProceeds) - Number(RUN.end.totalPaidOut)) / 1e4 / 100).toLocaleString('en-US', { minimumFractionDigits: 2 });   // e.g. 913.50, from the run itself
const OPP_SLUG = RUN.meta.oppHash.slice(2, 10);   // the opportunity page is named after the committed opportunity of the run
const ROUTES = ['', 'show', 'deck', 'market', 'app/owner', 'app/create', 'app', 'app/agent', 'app/opportunities', `app/opportunities/${OPP_SLUG}`, 'app/radar', 'app/lots', 'app/lots/1', 'app/transactions', 'app/policies', 'app/deploy', 'app/analytics', 'app/integrations'];
const PRESETS = [['Honest (the real trade)', 'ACCEPTED', null], ['Inflate the profit', 'REVERTED', 'MathMismatch(390, 261, 2374, 2374)'], ['Overspend', 'REVERTED', 'SpendCap(263600, 250000)'], ['Stale quote', 'REVERTED', 'Stale('], ['Thin margin', 'REVERTED', 'MarginTooLow(911, 1800)'], ['Loss-making', 'REVERTED', 'NonPositiveNet(-8)']];
let failures = 0; const fail = (m) => { failures++; console.log('FAIL', m); };
(async () => {
  const b = await chromium.launch();
  for (const [w, h, tag] of [[1440, 900, 'desktop'], [390, 844, 'mobile']]) {
    for (const r of ROUTES) {
      const p = await b.newPage({ viewport: { width: w, height: h } }); const errs = [];
      // On static hosting (no Worker) the optional /api/* calls of the Dependencies page answer 404 and the page degrades honestly.
      // Tolerate exactly that: a console 'Failed to load resource' is excused only when a matching 404 from /api/* was observed.
      let apiMisses = 0; let resourceErrs = 0;
      p.on('response', (rs) => { try { if (rs.status() === 404 && new URL(rs.url()).pathname.startsWith('/api/')) apiMisses++; } catch { /* */ } });
      p.on('pageerror', (e) => errs.push(String(e).slice(0, 100)));
      p.on('console', (m) => { if (m.type() !== 'error') return; if (/Failed to load resource/.test(m.text())) { resourceErrs++; return; } errs.push(m.text().slice(0, 100)); });
      const res = await p.goto(`${BASE}/${r}${r ? '/' : ''}`, { waitUntil: 'networkidle', timeout: 45000 }); await p.waitForTimeout(900);
      if (resourceErrs > apiMisses) errs.push(`${resourceErrs - apiMisses} failed resource load(s) that are not /api/* 404s`);
      const overflow = await p.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
      if (res.status() !== 200 || overflow || errs.length) fail(`${tag} /${r} status=${res.status()} overflow=${overflow} errors=${errs.join(' | ')}`);
      await p.close();
    }
  }
  console.log(`routes: ${ROUTES.length * 2} loads checked`);
  const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
  await p.goto(`${BASE}/show/?autoplay=1&speed=4`, { waitUntil: 'networkidle' }); await p.waitForFunction(() => /\b(\d{2,3})\/\1\b/.test(document.body.innerText), null, { timeout: 120000 });
  const t = await p.evaluate(() => document.body.innerText);
  const done = t.match(/\b(\d{2,3})\/\1\b/); if (!done) fail('Show did not play every step to the end (N/N)'); if (/DEV FIXTURE/.test(t)) fail('Show shows the DEV FIXTURE banner'); if (!t.includes(REALIZED)) fail('Show missing realized P&L');
  console.log('show: played to the end on the run');
  await p.goto(`${BASE}/app/`, { waitUntil: 'networkidle' }); await p.waitForTimeout(3500);
  const o = await p.evaluate(() => document.body.innerText);
  if (!/LIVE from Robinhood Chain Testnet, block \d+/.test(o)) fail('Overview did not read the live chain'); else console.log('overview: live chain read OK (' + (o.match(/block \d+/) || [''])[0] + ')');
  await p.goto(`${BASE}/app/policies/`, { waitUntil: 'networkidle' });
  for (const [name, stamp, err] of PRESETS) {
    await p.getByRole('button', { name }).first().click(); await p.waitForTimeout(1500);
    // the verdict comes from an eth_call to the public RPC, which can take several seconds: wait until the page stops saying "updating" (max 25 s)
    const read = () => p.evaluate(() => { const x = document.body.innerText; const i = x.search(/ACCEPTED|REVERTED|NO ANSWER/); return i < 0 ? '' : x.slice(i, i + 220); });
    let s = await read(); for (let k = 0; k < 24 && (/updating/.test(s) || !s.startsWith(stamp) || (err && !s.includes(err))); k++) { await p.waitForTimeout(1000); s = await read(); }
    if (!s.startsWith(stamp) || (err && !s.includes(err))) fail(`simulator "${name}" expected ${stamp} ${err || ''} got: ${s.slice(0, 120).replace(/\n/g, ' ')}`);
  }
  console.log('simulator: all presets match the real contract');
  await b.close();
  if (failures) { console.log(`\n${failures} FAILURE(S)`); process.exit(1); }
  console.log('browser: all checks passed');
})().catch((e) => { console.error('E2E crashed:', e.message); process.exit(1); });
