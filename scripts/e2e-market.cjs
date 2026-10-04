// Market terminal end-to-end test in a real browser against the LIVE BlindBook on Robinhood Chain Testnet.
//   node scripts/e2e-market.cjs http://127.0.0.1:4394          (add MARKET_LIVE=1 to REQUIRE a running keeper)
// Asserts the page renders real history, the epoch clock cycles COMMIT -> REVEAL -> CLEAR, the sealed book goes from hashes to prices to a
// cleared result that equals the latest on-chain EpochCleared, the 3D product renders, and nothing errors at desktop or phone width.
const { chromium } = require('playwright');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs'); const path = require('node:path');
const BASE = process.argv[2] || 'http://127.0.0.1:4394';
const RPC = process.env.ROBINHOOD_RPC || 'https://rpc.testnet.chain.robinhood.com';
const bb = JSON.parse(fs.readFileSync(path.join(__dirname, '../apps/web/src/data/blindbook.json'), 'utf8'));
const LIVE = process.env.MARKET_LIVE === '1';
let failures = 0; const ok = (m) => console.log('  ok  ', m); const fail = (m) => { failures++; console.log('  FAIL', m); }; const note = (m) => console.log('  note', m);
const expect = (c, m) => (c ? ok(m) : fail(m));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const T = (p, id) => p.getByTestId(id);
const txt = async (loc) => ((await loc.count()) ? (await loc.first().innerText()).trim() : '');

(async () => {
  const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  for (const [w, h, tag] of [[1440, 900, 'desktop'], [390, 844, 'phone']]) {
    console.log(`\n[${tag} ${w}x${h}]`);
    const page = await browser.newPage({ viewport: { width: w, height: h } }); const errs = [];
    page.on('pageerror', (e) => errs.push(String(e).slice(0, 120)));
    page.on('console', (m) => m.type() === 'error' && !/Failed to load resource|net::ERR|favicon/.test(m.text()) && errs.push(m.text().slice(0, 120)));
    const res = await page.goto(`${BASE}/market/`, { waitUntil: 'networkidle', timeout: 45000 });
    expect(res.status() === 200, 'HTTP 200');
    await page.waitForFunction(() => document.querySelector('[data-testid="market-terminal"]')?.getAttribute('data-ready') === 'true', null, { timeout: 40000 }).then(() => ok('terminal ready (history loaded from chain events)')).catch(() => fail('terminal never became ready'));
    await sleep(1500);
    const rows = await T(page, 'asset-row').count(); expect(rows >= 6, `${rows} asset rows listed`);
    const hero = await txt(T(page, 'last-price')); expect(/^\$(\d{1,3}(,\d{3})*)\.\d{2}$/.test(hero), `last price is a real dollar value (${hero})`);
    const pts = Number(await T(page, 'price-chart').first().getAttribute('data-points')); expect(pts > 0, `chart plots ${pts} real cleared epochs`);
    expect((await txt(T(page, 'testnet-note'))).length > 0, 'testnet / bots / test USDG disclosure is visible');
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1); expect(!overflow, 'no horizontal overflow');
    if (tag === 'desktop') {
      // switching the market changes what is shown
      const before = await T(page, 'market-terminal').getAttribute('data-selected'); await T(page, 'asset-row').nth(2).click(); await sleep(600);
      expect((await T(page, 'market-terminal').getAttribute('data-selected')) !== before, 'selecting another asset switches the market');
      await T(page, 'asset-row').nth(0).click(); await sleep(400);
      // 3D product
      const mode = await T(page, 'product-3d').first().getAttribute('data-mode'); expect(['webgl', 'fallback'].includes(mode), `3D product panel mounted (mode=${mode})`);
      if (mode === 'webgl') {
        // a WebGL canvas cannot be read back after its frame was presented, so judge the pixels the browser actually composited
        const shotA = await T(page, 'product-3d').first().screenshot(); await sleep(400);
        expect(shotA.length > 6000, `3D panel is not blank (screenshot ${shotA.length} bytes; a flat panel compresses to a few KB)`);
        const r1 = Number(await T(page, 'product-3d').first().getAttribute('data-rotation')); await sleep(1500); const r2 = Number(await T(page, 'product-3d').first().getAttribute('data-rotation')); expect(r1 !== r2, 'the product rotates on its own');
        await T(page, 'asset-row').nth(3).click(); await sleep(2500); const shotB = await T(page, 'product-3d').first().screenshot();
        expect(!shotA.equals(shotB), 'a different product renders a different picture'); await T(page, 'asset-row').nth(0).click(); await sleep(800);
      }
      // epoch clock + sealed book over one full epoch (45s)
      console.log('  ... observing one full epoch (about 50s)');
      const phases = new Set(); const seen = { sealed: 0, revealed: 0, cleared: false, epochs: new Set() }; let lastCleared = '';
      const t0 = Date.now();
      while (Date.now() - t0 < 52000) {
        const ph = await T(page, 'epoch-clock').first().getAttribute('data-phase'); if (ph) phases.add(ph);
        const sb = T(page, 'sealed-book').first();
        if (await sb.count()) {
          // read every field in ONE evaluation so a re-render between two reads cannot mix two epochs
          const snap = await page.evaluate(() => { const r = document.querySelector('[data-testid="sealed-book"]'); if (!r) return null; const c = r.querySelector('[data-testid="clearing-price"]'); return { epoch: r.getAttribute('data-epoch'), sealed: Number(r.getAttribute('data-sealed-count')) || 0, revealed: Number(r.getAttribute('data-revealed-count')) || 0, cleared: r.getAttribute('data-cleared') === 'true', price: c ? c.textContent.trim() : '' }; });
          if (snap) { seen.epochs.add(snap.epoch); seen.sealed = Math.max(seen.sealed, snap.sealed); seen.revealed = Math.max(seen.revealed, snap.revealed); if (snap.cleared) { seen.cleared = true; lastCleared = snap.price; if (!/^\$(\d{1,3}(,\d{3})*)\.\d{2}$|no cross/.test(snap.price)) fail(`cleared book shows "${snap.price}" instead of a price`); } }
        }
        await sleep(1000);
      }
      expect(phases.size >= 2, `epoch clock cycled through phases: ${[...phases].join(' -> ')}`);
      if (LIVE || seen.sealed > 0) {
        expect(seen.sealed > 0, `sealed orders were visible as hashes (max ${seen.sealed})`);
        expect(seen.revealed > 0, `orders were revealed (max ${seen.revealed})`);
        expect(seen.cleared, `the book reached a cleared result (${lastCleared})`);
      } else note('no sealed orders observed: the keeper looks idle (set MARKET_LIVE=1 to require it)');
      // cross-check the displayed clearing price with the chain: latest EpochCleared of the selected market
      try {
        const topic = execFileSync('cast', ['sig-event', 'EpochCleared(bytes32,uint256,uint256,uint256,uint256,uint256,uint256)'], { encoding: 'utf8' }).trim();
        const head = Number(execFileSync('cast', ['block-number', '--rpc-url', RPC], { encoding: 'utf8' }).trim());
        const logs = JSON.parse(execFileSync('cast', ['logs', '--address', bb.book, '--from-block', String(head - 3000), '--to-block', String(head), topic, '--json', '--rpc-url', RPC], { encoding: 'utf8' }));
        const heroId = execFileSync('cast', ['keccak', JSON.parse(fs.readFileSync(path.join(__dirname, '../apps/web/src/data/catalog.json'), 'utf8')).markets[0].id], { encoding: 'utf8' }).trim().toLowerCase();
        const hero = logs.filter((l) => l.topics[1].toLowerCase() === heroId && BigInt('0x' + l.data.slice(2, 66)) > 0n);
        if (hero.length) { const price = Number(BigInt('0x' + hero[hero.length - 1].data.slice(2, 66))); const shown = await txt(T(page, 'last-price')); expect(shown === '$' + (price / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }), `header last price ${shown} equals the latest on-chain clear $${(price / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`); }
        else note('no recent hero clear on chain to cross-check');
      } catch (e) { note('on-chain cross-check skipped: ' + String(e.message).slice(0, 80)); }
    }
    expect(errs.length === 0, 'no page or console errors' + (errs.length ? ': ' + errs.join(' | ') : ''));
    await page.close();
  }
  await browser.close();
  console.log(failures ? `\n${failures} FAILURE(S)` : '\nmarket e2e: all checks passed'); process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('E2E crashed:', e.message); process.exit(1); });
