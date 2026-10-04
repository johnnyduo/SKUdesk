// Assertions on the built site (run after `npm run build`).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

import { pathToFileURL } from 'node:url';
// DIST_DIR lets scripts/verify-all.sh test its own private build instead of apps/web/dist
const DIST_URL = process.env.DIST_DIR ? pathToFileURL(process.env.DIST_DIR.replace(/\/*$/, '/')) : new URL('../../dist/', import.meta.url);
const page = (p) => readFileSync(new URL(p, DIST_URL), 'utf8');
const island = (name) => new RegExp('component-url="/_astro/' + name + '\\.[^"]+\\.js"');
// Page ids come from the agent run (src/data/run.json): /app/lots/<meta.lot>/ and /app/opportunities/<oppHash[2..10]>/.
const RUN = JSON.parse(readFileSync(new URL('../../src/data/run.json', import.meta.url), 'utf8'));
const LOT_PAGE = 'app/lots/' + RUN.meta.lot + '/index.html';
const OPP_PAGE = 'app/opportunities/' + RUN.meta.oppHash.slice(2, 10) + '/index.html';

test('lot page hydrates PublishListing with the hero landing page, PNG and 1099 cents', () => {
  const html = page(LOT_PAGE);
  assert.match(html, island('PublishListing'));
  assert.match(html, /https:\/\/skudesk\.lol\/p\/CASE-IP16PRO-CLEAR-MAG-001\//);
  assert.match(html, /\/img\/cases-png\/iphone-16-pro_clear_mag_1\.png/);
  // priceCents is an exact serialized island prop (not a stray "1099" elsewhere on the page).
  assert.match(html, /&quot;priceCents&quot;:\[0,1099\]/);
});

test('lot page server-renders the dry-run panel with no operator-token input and keeps the LiveLot island', () => {
  const html = page(LOT_PAGE);
  assert.match(html, /Publish listing \(dry run\)/);
  assert.doesNotMatch(html, /type="password"/);
  assert.match(html, island('LiveLot'));
});

test('integrations page hydrates LiveConnectors and has a no-JavaScript fallback', () => {
  const html = page('app/integrations/index.html');
  assert.match(html, island('LiveConnectors'));
  assert.match(html, /<noscript><p[^>]*>Live status needs JavaScript/);
});

test('integrations page does not claim latency is never shown (the REAL row shows Worker-measured latency)', () => {
  const html = page('app/integrations/index.html');
  assert.doesNotMatch(html, /No latency figures or/);
  assert.doesNotMatch(html, /this site does not measure them/);
  assert.match(html, /Latency appears only in the live backend row, where the Worker measures it/);
});

test('the dependencies page no longer claims there is no backend, no live feed or no server', () => {
  const html = page('app/integrations/index.html');
  assert.doesNotMatch(html, /No backend or database/);
  assert.doesNotMatch(html, /There is no server behind the site/);
  assert.match(html, /only server code is the Cloudflare Worker behind \/api/);
});

test('radar and opportunity pages hydrate PriceCompare for the hero SKU', () => {
  for (const p of ['app/radar/index.html', OPP_PAGE]) {
    const html = page(p);
    assert.match(html, island('PriceCompare'), p);
    assert.match(html, /CASE-IP16PRO-CLEAR-MAG-001/, p);
  }
});

// The two live-panel islands are client-rendered, so their copy is asserted in the compiled bundles.
const bundle = (name) => {
  const f = readdirSync(new URL('_astro/', DIST_URL)).find((n) => n.startsWith(name + '.') && n.endsWith('.js'));
  assert.ok(f, name + ' bundle exists');
  return readFileSync(new URL('_astro/' + f, DIST_URL), 'utf8');
};

test('PriceCompare shows the provenance note when the SearchApi.io backup served, a dated Data column, and the 24 h footnote', () => {
  const js = bundle('PriceCompare');
  assert.match(js, /unavailable \(/);
  assert.match(js, /served by /);
  assert.match(js, /SerpApi and its SearchApi\.io backup up to 24 h/);
  assert.match(js, /eBay up to 6 h, Best Buy up to 72 h/);
  assert.doesNotMatch(js, /SerpApi up to 24 h/);
  assert.doesNotMatch(js, /\.slice\(11, ?19\)/); // the old time-of-day-only rendering
});

test('LiveConnectors renders the SerpApi backup (SearchApi.io) row from /api/prices/sources', () => {
  const js = bundle('LiveConnectors');
  assert.match(js, / backup \(/);
  assert.match(js, /SearchApi\.io/);
  assert.match(js, /standby \(used only if /);
  assert.match(js, /inactive: /);
  assert.match(js, / is not REAL, so this backup is never called\)/);
  assert.doesNotMatch(js, /failover only/);
});

test('LiveConnectors renders the Uniswap v4 pool row from /api/v4/pool', () => {
  const js = bundle('LiveConnectors');
  // the shared api client chunk (not the island) holds the path
  const chunks = readdirSync(new URL('_astro/', DIST_URL)).filter((n) => n.endsWith('.js'));
  assert.ok(chunks.some((n) => readFileSync(new URL('_astro/' + n, DIST_URL), 'utf8').includes('/api/v4/pool')), 'api client calls /api/v4/pool');
  assert.match(js, /Uniswap v4 pool \(test token pair\)/);
  assert.match(js, / per unit · liquidity in range /);
  assert.match(js, /stableSymbol/); // the stable token's symbol comes from the API (re-pool ready), not a hard-coded mUSDC
  assert.match(js, /secondary venue, not a hook/);
  assert.match(js, /PoolManager on the explorer/);
});

test('PriceCompare renders refresh_requires_operator as a neutral cached-only note, not as the raw error code', () => {
  const js = bundle('PriceCompare');
  assert.match(js, /refresh_requires_operator/);
  assert.match(js, /Cached data only\. Refreshing paid sources needs the operator\./);
  assert.match(js, /data-note":"cached-only"/);
});

// Cloudflare Workers Static Assets reads dist/_headers (copied from public/_headers) for every non-/api response.
const headerRules = () => {
  const text = readFileSync(new URL('_headers', DIST_URL), 'utf8');
  const rules = []; let cur = null;
  for (const l of text.split('\n')) {
    if (l.trim() === '' || l.trim().startsWith('#')) continue;
    if (!/^\s/.test(l)) { cur = { path: l.trim(), headers: {} }; rules.push(cur); continue; }
    const i = l.indexOf(':'); cur.headers[l.slice(0, i).trim().toLowerCase()] = l.slice(i + 1).trim();
  }
  return rules;
};
test('dist/_headers gives every static response the safe security headers and only the safe CSP subset', () => {
  const rules = headerRules();
  assert.equal(rules[0].path, '/*', 'one rule that matches every path');
  const headers = rules[0].headers;
  assert.equal(headers['x-content-type-options'], 'nosniff');
  assert.equal(headers['referrer-policy'], 'strict-origin-when-cross-origin');
  assert.equal(headers['x-frame-options'], 'DENY');
  assert.equal(headers['permissions-policy'], 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
  assert.equal(headers['strict-transport-security'], 'max-age=31536000');
  assert.equal(headers['content-security-policy'], "frame-ancestors 'none'; base-uri 'self'; object-src 'none'; form-action 'self'");
  // The site needs inline scripts and the public RPC: these directives would break it, so they must stay out.
  assert.doesNotMatch(headers['content-security-policy'], /default-src|script-src|connect-src|style-src|img-src/);
  assert.equal(Object.keys(headers).length, 6);
  assert.equal(headers['cache-control'], undefined, 'the catch-all rule must not cache HTML');
});

test('dist/_headers caches hashed build output and fonts for a year (immutable) and images for a week; nothing else', () => {
  const rules = headerRules(); const by = Object.fromEntries(rules.map((r) => [r.path, r.headers['cache-control']]));
  assert.equal(by['/_astro/*'], 'public, max-age=31536000, immutable');
  assert.equal(by['/fonts/*'], 'public, max-age=31536000, immutable');
  assert.equal(by['/img/*'], 'public, max-age=604800, stale-while-revalidate=86400');
  for (const r of rules) if (r.headers['cache-control']) assert.ok(r.path !== '/*' && !/\.(html|json|js)$/.test(r.path) || r.path.startsWith('/_astro/'), 'no long cache on ' + r.path);
});

test('fonts are self-hosted: no Google Fonts requests, and the three font files are preloaded', () => {
  const html = page('index.html');
  assert.doesNotMatch(html, /fonts\.googleapis\.com|fonts\.gstatic\.com/);
  for (const f of ['inter', 'instrument-serif', 'jetbrains-mono']) assert.match(html, new RegExp('rel="preload" href="/fonts/' + f + '\\.woff2" as="font"'));
});

// Wording: the pages never say "recorded", "recording" or "demo"; status pills (REAL, TEST DATA, DRY RUN, DEGRADED, NOT CONNECTED) stay.
const visibleText = (html) => html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ');
// Only <main> is checked: the shared shell chrome and the run.ts step text are owned by other files.
const mainText = (html) => visibleText(/<main[^>]*>([\s\S]*)<\/main>/.exec(html)[1]);
test('radar, opportunity and integrations pages use plain run wording (no "recorded", "recording" or "demo")', () => {
  for (const p of ['app/radar/index.html', OPP_PAGE, 'app/integrations/index.html']) {
    assert.doesNotMatch(mainText(page(p)), /recorded|recording|demo/i, p);
  }
});

test('lot page header says "in the run" and "the product", not "recorded"/"recording"', () => {
  const t = mainText(page(LOT_PAGE));
  assert.match(t, / in the run/);
  assert.doesNotMatch(t, /in the recording|the recorded product/);
});

test('radar page labels the snapshot as fixed, not as recorded, and keeps the not-a-live-feed disclosure', () => {
  const html = page('app/radar/index.html');
  assert.match(html, /<title>Market snapshot \| SKUdesk<\/title>/);
  assert.match(html, /Fixed snapshot, not a live feed/);
  assert.match(html, /<b>Fixed snapshot<\/b>/);
  assert.match(html, /verdicts from the run/);
});

test('integrations page: run files wording and the only-server-code sentence', () => {
  const html = page('app/integrations/index.html');
  assert.match(html, /No backend behind the run pages/);
  assert.match(html, /No live market feed in the run/);
  assert.match(html, /Run data files/);
  assert.match(html, /only server code is the Cloudflare Worker behind \/api/);
});

test('integrations page: wallet line states the truth (read without a wallet; only Owner console and Deploy your agent send transactions; /market sends nothing; confirm in wallet)', () => {
  const t = mainText(page('app/integrations/index.html')).replace(/\s+/g, ' ');
  assert.doesNotMatch(t, /Nothing on this site asks you to connect one/);
  assert.match(t, /Viewing pages needs no wallet/);
  assert.match(t, /Only the Owner console and Deploy your agent send transactions/);
  assert.doesNotMatch(t, /trading on \/market/);
  assert.match(t, /nothing is signed or sent without your confirmation in your wallet/);
});

test('opportunity page: on-chain wording and "From the run"', () => {
  const html = page(OPP_PAGE);
  assert.match(html, /matches the opportunity id on-chain/);
  assert.match(html, /From the run, before anything touched the chain/);
});

test('PriceCompare bundle says test-data sources and NOT CONNECTED, never DEMO', () => {
  const js = bundle('PriceCompare');
  assert.doesNotMatch(js, /DEMO|API OFFLINE/);
  assert.match(js, /"test-data"," sources"/);
  const labels = bundle('labels'); // modePill lives in the shared labels chunk
  assert.doesNotMatch(labels, /DEMO|API OFFLINE/);
  assert.match(labels, /API NOT CONNECTED/);
});

test('SealedBook bond is labelled mUSDG (the test USDG stand-in), not USDC', () => {
  // SealedBook is bundled into the Terminal island: scan every Terminal chunk.
  const files = readdirSync(new URL('_astro/', DIST_URL)).filter((n) => n.startsWith('Terminal.') && n.endsWith('.js'));
  const js = files.map((n) => readFileSync(new URL('_astro/' + n, DIST_URL), 'utf8')).join('\n');
  assert.match(js, /mUSDG bond forfeited to the treasury/);
  assert.match(js, /mUSDG each/);
  assert.doesNotMatch(js, /[ `}]USDC (bond|each)/);
});

test('guard copy on the policies and opportunities pages states what the contract does and does not guarantee', () => {
  // /app/policies lists every guard; /app/opportunities shows only the checks the committed opportunity passed
  // (replay and freshness), so the proceeds copy is asserted on /app/policies only.
  const common = [
    // Replay: the id is keccak256(productHash, quoteHash, snapshotHash); the agent supplies snapshotHash.
    /keccak256\(productHash, quoteHash, snapshotHash\)/,
    /a new snapshot hash is a new id/,
    /the caps, not the id, limit how often the same quote can be committed/,
    // TTL: the age check uses the agent-supplied observation time.
    /uses the observation time the agent supplies/,
    /not the real age of the source data/,
  ];
  const proceeds = [
    // Proceeds: real tokens pulled from the owner-approved payer; the reported price is not verified.
    /limited by the payer’s balance and allowance/,
    /not that the reported sale price is true/,
  ];
  const pages = { 'app/policies/index.html': [...common, ...proceeds], 'app/opportunities/index.html': common };
  for (const [p, wanted] of Object.entries(pages)) {
    const html = page(p);
    for (const re of wanted) assert.match(html, re, p);
    // The old overclaims are gone.
    assert.doesNotMatch(html, /cannot invent proceeds/, p);
    assert.doesNotMatch(html, /cannot be committed twice under a new id/, p);
    assert.doesNotMatch(html, /Prices expire\. An observation older/, p);
  }
});

// Proof findings (docs/proofs/FINDINGS.md): copy must say what the deployed contracts guarantee
const allJs = (prefix) => readdirSync(new URL('_astro/', DIST_URL)).filter((n) => n.startsWith(prefix) && n.endsWith('.js'))
  .map((n) => readFileSync(new URL('_astro/' + n, DIST_URL), 'utf8')).join('\n');

test('F-V1/F-V2: the daily cap is described as a cap on commitments, not on cash-out', () => {
  const pol = page('app/policies/index.html');
  assert.match(pol, /of new commitments per UTC day/);
  assert.match(pol, /limits new commitments, not cash-out/);
  assert.match(pol, /commitments do not expire/);
  assert.match(pol, /up to twice the cap can be committed within 24 hours/);
  assert.match(pol, /Cash-out is bounded by the vault’s free balance, and each purchase by the per-purchase cap/);
  assert.match(pol, /the agent cannot split a big purchase into many small ones to dodge it/);
  const deck = page('deck/index.html');
  assert.match(deck, /The daily cap limits commitments, not cash-out/);
  assert.match(deck, /per-UTC-day cap on new commitments/);
  const mandate = allJs('Mandate');
  assert.match(mandate, /limits commitments, not daily cash-out/);
  const live = allJs('LiveMandate');
  assert.match(live, /limits commitments, not daily cash-out/);
  for (const [name, html] of [['policies', pol], ['deck', deck], ['Mandate', mandate], ['LiveMandate', live], ['landing', page('index.html')]]) {
    assert.doesNotMatch(html, /however many purchases/, name);
    assert.doesNotMatch(html, /most it may spend in one UTC day/i, name);
    assert.doesNotMatch(html, /Spend caps per trade and per day/, name);
    assert.doesNotMatch(html, /[Mm]aximum loss/, name);
  }
  // The landing no longer carries the cap copy; the full disclosure lives on the pages below and must stay honest.
  const need = [/limits (new )?commitments, not (daily )?cash-out/, /(do not|never) expire/, /up to twice the cap can be committed within 24 hours/, /bounded by the vault(’s free)? balance(, and each (lot|purchase) by the per-(trade|purchase) cap|; each lot is at most the per-trade cap)/];
  const opps = page('app/opportunities/index.html');
  const runJs = allJs('run');
  for (const [name, html] of [['policies', pol], ['deck', deck], ['opportunities', opps], ['run guard text', runJs]]) {
    for (const re of need) assert.match(html, re, name + ' ' + re);
    // an overclaim ("cannot spend more than the daily cap per day", "daily limit on spending") must fail
    assert.doesNotMatch(html, /cannot (spend|cash out|pay out|lose) more than the (daily|per-day|day)/i, name);
    assert.doesNotMatch(html, /(spend|cash-?out|withdraw)\w* (is )?(capped|limited|bounded) (at|to|by) the daily cap/i, name);
  }
  assert.doesNotMatch(page('index.html'), /cannot spend more than the daily cap/i);
});

test('F-V3/F-V4/F-V5: replay, freshness and proceeds copy says the agent supplies those inputs', () => {
  const deck = page('deck/index.html');
  assert.match(deck, /Agent-supplied inputs/);
  assert.match(deck, /TTL on the agent-supplied observation time/);
  assert.match(deck, /one commit per quote-and-snapshot id/);
  assert.doesNotMatch(deck, /one commit per opportunity</);
  const pol = page('app/policies/index.html');
  assert.match(pol, /only accept quotes the agent dates as less than/);
  assert.doesNotMatch(pol, /only trust prices less than/);
  const live = allJs('LiveMandate');
  assert.match(live, /A price the agent dates as older than this is refused/);
  assert.doesNotMatch(live, /is stale and refused/);
});

test('F-B1/F-B3: the market explainer discloses the owner pause and unbacked unit issuance', () => {
  const js = allJs('Terminal');
  assert.match(js, /The market owner can pause trading/);
  assert.match(js, /forfeits the bond of every order not yet revealed to the owner’s treasury/);
  assert.match(js, /the market owner can issue new units/);
  assert.match(js, /not backed by on-chain collateral/);
  assert.match(js, /the test USDG token of this testnet build/);
  const deck = page('deck/index.html');
  assert.match(deck, /Owner powers on the BlindBook market/);
  assert.match(deck, /A pause that runs to the end of the reveal window forfeits the bond of every order not yet revealed to the owner(’|&rsquo;|&#8217;)s treasury/);
  assert.doesNotMatch(deck, /forfeits committed bonds/);
  assert.match(deck, /Units are warehouse receipts, not backed by on-chain collateral/);
});

test('owner-rule words stay out of the new visible copy', () => {
  for (const [name, text] of [['policies', page('app/policies/index.html')], ['deck', page('deck/index.html')], ['Terminal', allJs('Terminal')]]) {
    const visible = text.replace(/<(script|style)[\s\S]*?<\/\1>/g, ' ').replace(/<[^>]+>/g, ' '); // class names such as "demo" are not copy
    assert.doesNotMatch(name === 'Terminal' ? text : visible, /\b(recorded|recording|simulated|demo)\b/i, name);
  }
});

// Screen-reader and tooltip copy (aria-label, title, alt, placeholder) and warnings in the built show chunk
// must not use the words recorded / recording / demo / simulated. Class names are not attribute copy and are not scanned.
const OWNER_WORDS = /\b(recorded|recording|simulated|demo)\b/i;
const htmlFiles = (dir) => readdirSync(new URL('../../dist/' + dir, import.meta.url), { withFileTypes: true }).flatMap((e) =>
  e.isDirectory() ? htmlFiles(dir + e.name + '/') : e.name.endsWith('.html') ? [dir + e.name] : []);

test('no owner-rule word inside aria-label/title/alt/placeholder of any built page', () => {
  const bad = [];
  for (const f of htmlFiles('')) {
    const html = page(f).replace(/<(script|style)[\s\S]*?<\/\1>/g, ' ');
    for (const m of html.matchAll(/\b(aria-label|aria-description|title|alt|placeholder)="([^"]*)"/g)) {
      if (OWNER_WORDS.test(m[2])) bad.push(f + ' ' + m[1] + '="' + m[2] + '"');
    }
  }
  assert.deepEqual(bad, []);
});

test('no owner-rule word in aria-label/title/alt props or warning text of the built chunks', () => {
  const bad = [];
  for (const n of readdirSync(new URL('_astro/', DIST_URL)).filter((x) => x.endsWith('.js'))) {
    const js = readFileSync(new URL('_astro/' + n, DIST_URL), 'utf8');
    for (const m of js.matchAll(/["']?(aria-label|ariaLabel|aria-description|title|alt|placeholder)["']?\s*:\s*("(?:[^"\\]|\\.)*"|`[^`]*`)/g)) {
      if (OWNER_WORDS.test(m[2])) bad.push(n + ' ' + m[1] + ': ' + m[2].slice(0, 120));
    }
    for (const m of js.matchAll(/"WARNING[^"]*"/g)) if (OWNER_WORDS.test(m[0])) bad.push(n + ' ' + m[0].slice(0, 120));
  }
  assert.deepEqual(bad, []);
});

test('the show player warning says "this run", and the market tape label has no owner-rule word', () => {
  const player = allJs('Player');
  assert.match(player, /does not equal the contract-derived net in this run\./);
  assert.doesNotMatch(player, /in this recording/);
  assert.match(page('app/opportunities/index.html'), /aria-label="The 10 offers in the market snapshot and their identity-gate verdicts"/);
});

// Share / SEO polish: Open Graph, Twitter, canonical, icons, sitemap, robots, 404
const ORIGIN = 'https://skudesk.lol';
const countOf = (html, re) => (html.match(re) ?? []).length;
const metaContent = (html, attr, name) => {
  const m = html.match(new RegExp('<meta\\b[^>]*\\b' + attr + '="' + name + '"[^>]*>'));
  assert.ok(m, attr + '=' + name + ' present');
  return m[0].match(/\bcontent="([^"]*)"/)[1];
};
// show/ and deck/ write their own <head> (they do not use layouts/Base.astro), so the shared-head checks skip them.
const OWN_HEAD = ['show/index.html', 'deck/index.html', '404.html'];
const walkHtml = (dir, out = []) => {
  for (const e of readdirSync(new URL('../../dist/' + dir, import.meta.url), { withFileTypes: true })) {
    if (e.isDirectory()) { if (e.name !== '_astro') walkHtml(dir + e.name + '/', out); }
    else if (e.name.endsWith('.html')) out.push(dir + e.name);
  }
  return out;
};

test('head of / and /app/ carries each share tag exactly once, with absolute canonical and image URLs', () => {
  const expectCanon = { 'index.html': ORIGIN + '/', 'app/index.html': ORIGIN + '/app/' };
  for (const [file, canon] of Object.entries(expectCanon)) {
    const html = page(file);
    const head = html.slice(0, html.indexOf('</head>'));
    for (const re of [/<link rel="canonical"/g, /property="og:title"/g, /property="og:description"/g, /property="og:type"/g, /property="og:url"/g,
      /property="og:site_name"/g, /property="og:image"/g, /property="og:image:width"/g, /property="og:image:height"/g, /name="twitter:card"/g,
      /name="twitter:title"/g, /name="twitter:description"/g, /name="twitter:image"/g, /name="theme-color"/g, /name="description"/g,
      /rel="icon"/g, /rel="apple-touch-icon"/g]) {
      assert.equal(countOf(head, re), 1, file + ' ' + re);
    }
    // Two Google site-verification tokens are expected (the Merchant Center claim and the skudesk.lol property); each exactly once.
    for (const token of ['2Mm5OedqupMMGU177lAJ-geojDmE5iPnoxDO8UBX5uI', '2k9QAd73qjpTRRcUnBsw4qY5WX4I9VEY-p2f7RzceCg']) assert.equal(countOf(head, new RegExp('name="google-site-verification" content="' + token + '"', 'g')), 1, file + ' verification ' + token);
    assert.equal(countOf(head, /name="google-site-verification"/g), 2, file + ' verification tags');
    assert.match(head, new RegExp('<link rel="canonical" href="' + canon + '"'));
    assert.equal(metaContent(head, 'property', 'og:url'), canon);
    assert.equal(metaContent(head, 'property', 'og:type'), 'website');
    assert.equal(metaContent(head, 'property', 'og:site_name'), 'SKUdesk');
    assert.equal(metaContent(head, 'property', 'og:image'), ORIGIN + '/og.png');
    assert.equal(metaContent(head, 'property', 'og:image:width'), '1200');
    assert.equal(metaContent(head, 'property', 'og:image:height'), '630');
    assert.equal(metaContent(head, 'name', 'twitter:card'), 'summary_large_image');
    assert.equal(metaContent(head, 'name', 'twitter:image'), ORIGIN + '/og.png');
    assert.equal(metaContent(head, 'property', 'og:description'), metaContent(head, 'name', 'description'));
    assert.equal(metaContent(head, 'name', 'twitter:description'), metaContent(head, 'name', 'description'));
    assert.match(head, /<link rel="icon" href="\/favicon\.svg" type="image\/svg\+xml"/);
    assert.match(head, /<link rel="apple-touch-icon" href="\/apple-touch-icon\.png"/);
  }
});

test('every built page has exactly one canonical that matches its own path', () => {
  const bad = [];
  for (const f of walkHtml('')) {
    if (OWN_HEAD.includes(f)) continue;
    const html = page(f);
    const head = html.slice(0, html.indexOf('</head>'));
    const links = head.match(/<link rel="canonical" href="[^"]*"/g) ?? [];
    const want = ORIGIN + '/' + f.replace(/index\.html$/, '');
    if (links.length !== 1 || !links[0].endsWith('href="' + want + '"')) bad.push(f + ' -> ' + links.join('|'));
  }
  assert.deepEqual(bad, []);
});

test('app pages each have their own description, and no description or share text uses an owner-rule word', () => {
  const seen = new Map();
  const bad = [];
  for (const f of walkHtml('')) {
    if (OWN_HEAD.includes(f)) continue;
    const html = page(f);
    const head = html.slice(0, html.indexOf('</head>'));
    const d = metaContent(head, 'name', 'description');
    if (f.startsWith('app/') && !/^app\/(lots|opportunities)\/.+\//.test(f)) {
      if (seen.has(d)) bad.push(f + ' shares its description with ' + seen.get(d));
      seen.set(d, f);
    }
    for (const t of [d, metaContent(head, 'property', 'og:title')]) {
      if (/recorded|recording|demo|simulated|sample|usdg|usdc/i.test(t)) bad.push(f + ' owner-rule word in: ' + t);
    }
  }
  assert.deepEqual(bad, []);
});

test('sitemap.xml lists the static routes and every product page, all absolute with a trailing slash', () => {
  const xml = page('sitemap.xml');
  const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  for (const p of ['/', '/app/', '/show/', '/market/', '/deck/', '/app/policies/']) assert.ok(locs.includes(ORIGIN + p), p);
  const skus = JSON.parse(page('p/manifest.json')).entries.map((e) => e.sku);
  assert.ok(skus.length >= 100);
  for (const s of skus) assert.ok(locs.includes(ORIGIN + '/p/' + s + '/'), s);
  assert.equal(new Set(locs).size, locs.length, 'no duplicate urls');
  assert.ok(locs.every((l) => l.startsWith(ORIGIN + '/') && l.endsWith('/')));
  assert.ok(!locs.some((l) => /404/.test(l)));
});

test('robots.txt allows everything and points at the sitemap', () => {
  const txt = page('robots.txt');
  assert.match(txt, /^User-agent: \*\s*$/m);
  assert.match(txt, /^Allow: \/\s*$/m);
  assert.match(txt, new RegExp('^Sitemap: ' + ORIGIN.replace(/\./g, '\\.') + '/sitemap\\.xml\\s*$', 'm'));
});

test('404.html exists, is not indexed, and links to the main sections', () => {
  const html = page('404.html');
  assert.match(html, /<title>[^<]*Page not found[^<]*<\/title>/);
  assert.match(html, /name="robots" content="noindex"/);
  for (const h of ['/', '/show/', '/app/', '/market/', '/deck/']) assert.match(html, new RegExp('<a [^>]*href="' + h + '"'), h);
});

test('wrangler serves 404.html for unknown paths and still runs the Worker first for /api/*', () => {
  const cfg = JSON.parse(readFileSync(new URL('../../wrangler.jsonc', import.meta.url), 'utf8').replace(/^\s*\/\/.*$/gm, ''));
  assert.equal(cfg.assets.not_found_handling, '404-page');
  assert.deepEqual(cfg.assets.run_worker_first, ['/api/*']);
  assert.equal(cfg.assets.binding, 'ASSETS');
});

test('share image is 1200x630, the apple touch icon is 180x180, and the favicon is a real SVG', async () => {
  const sharp = (await import('sharp')).default;
  const og = await sharp(new URL('../../dist/og.png', import.meta.url).pathname).metadata();
  assert.deepEqual([og.format, og.width, og.height], ['png', 1200, 630]);
  const ti = await sharp(new URL('../../dist/apple-touch-icon.png', import.meta.url).pathname).metadata();
  assert.deepEqual([ti.format, ti.width, ti.height], ['png', 180, 180]);
  const svg = page('favicon.svg');
  assert.match(svg, /^<svg[^>]*xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
});

test('policies page points to `forge test` instead of a hard-coded suite count', () => {
  const pol = page('app/policies/index.html');
  assert.doesNotMatch(pol, /has 111/);
  assert.doesNotMatch(pol, /full Foundry suite, with the market and the proofs, has \d+/);
  assert.doesNotMatch(pol, /Foundry suite is \d+ tests/);
  assert.match(pol, /Foundry tests are in <span class="mono">packages\/contracts\/test<\/span>; run <span class="mono">forge test<\/span> in <span class="mono">packages\/contracts<\/span>/);
});

// The public UI never shows the words "mock" or "demo". Honesty is kept by relabeling:
// no credentials -> NOT CONNECTED ("no API key yet"); Worker-generated offers -> TEST DATA.
const WORDS = /\bmock|\bdemo/i;
const attrText = (html) => [...html.matchAll(/\b(?:title|alt|aria-label|placeholder|content)="([^"]*)"/g)].map((m) => m[1]).join(' ');
test('rendered pages show neither "mock" nor "demo" (text, title, meta description, attributes)', () => {
  for (const p of ['app/radar/index.html', 'app/integrations/index.html', OPP_PAGE, LOT_PAGE]) {
    const html = page(p);
    const head = /<head[^>]*>([\s\S]*?)<\/head>/.exec(html)[1];
    const text = visibleText(html.replace(/<head[\s\S]*?<\/head>/, ' ')) + ' ' + attrText(html.replace(/<astro-island[^>]*>/g, ' ')) + ' ' + (/<title>([^<]*)/.exec(head) || [])[1];
    const hit = WORDS.exec(text);
    assert.equal(hit, null, p + ': ' + (hit && text.slice(Math.max(0, hit.index - 40), hit.index + 40)));
  }
});

// Compiled island strings: every string literal that is rendered must be free of the words. The one allowed literal is the
// JSON enum value "MOCK" itself (a code comparison against the Worker's API, never rendered).
test('PriceCompare, LiveConnectors, PublishListing and labels bundles render no "mock"/"demo" string', () => {
  for (const name of ['PriceCompare', 'LiveConnectors', 'PublishListing', 'labels']) {
    const js = bundle(name);
    const lits = [...js.matchAll(/"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'|`((?:[^`\\]|\\.)*)`/g)].map((m) => m[1] ?? m[2] ?? m[3]);
    const bad = lits.filter((l) => WORDS.test(l) && l !== 'MOCK');
    assert.deepEqual(bad, [], name);
  }
  const labels = bundle('labels');
  assert.match(labels, /TEST DATA/);
  assert.match(labels, /NOT CONNECTED/);
});

test('deck: 11 slides, market slide, not-audited clause, shared-registry wording, live URL, net-of-fees proceeds', () => {
  const deck = page('deck/index.html');
  assert.equal((deck.match(/<section class="slide/g) ?? []).length, 11);
  assert.match(deck, /1 \/ 11/);
  assert.match(deck, /aria-label="Slide 9: The market, BlindBook"/);
  assert.match(deck, /<b>not<\/b> a Uniswap v4 hook/);
  assert.match(deck, /Contracts are not audited/);
  assert.match(deck, /id 119 in the ERC-8004 Identity Registry already deployed on Robinhood Chain Testnet/);
  assert.match(deck, /upgradeable, implementation source not verified/);
  assert.doesNotMatch(deck, /our own deployment/);
  assert.match(deck, /https:\/\/skudesk\.lol/);
  assert.match(deck, /Vault \(SKUdeskCore\)/);
  assert.match(deck, /Sale proceeds were \$3,220\.00: 350 units × \$9\.20/);
  assert.match(deck, /not 350 × \$10\.99/);
  assert.match(deck, /by construction in this run/);
  assert.doesNotMatch(deck.replace(/<script[\s\S]*?<\/script>/g, ''), /\$\d{4,}(\.\d+)?/);
  assert.match(page('app/deploy/index.html'), /Contracts are not audited/);
});

test('lot page: product name as subtitle, proceeds explained, one money format', () => {
  const html = page(LOT_PAGE);
  assert.match(html, /350 units of iPhone 16 Pro Clear MagSafe Case/);
  assert.match(html, /Sale proceeds were \$3,220\.00: 350 units × \$9\.20/);
  assert.match(html, /by construction in this run/);
  for (const f of ['app/policies/index.html', 'app/transactions/index.html', LOT_PAGE]) {
    assert.doesNotMatch(page(f).replace(/<script[\s\S]*?<\/script>/g, ''), /\$\d{4,}(\.\d+)?/, f);
  }
});
