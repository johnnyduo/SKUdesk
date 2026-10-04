import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadNodeModule } from './helpers/bundle.ts';

type Row = { id: string; name: string; mode: string; detail: string; creds: string };
type Mod = {
  merchantRow(r: unknown): Row;
  sourceRows(r: unknown): Row[];
  v4PoolRow(r: unknown): Row & { link?: { href: string; text: string } };
  render(rows: Row[]): string;
};
const mod = await loadNodeModule<Mod>(`
  import { createElement } from 'react';
  import { renderToStaticMarkup } from 'react-dom/server';
  import { ConnectorTable, merchantRow, sourceRows, v4PoolRow } from './src/components/integrations/LiveConnectors.tsx';
  export { merchantRow, sourceRows, v4PoolRow };
  export const render = (rows) => renderToStaticMarkup(createElement(ConnectorTable, { rows }));
`);
const ok = (data: unknown) => ({ ok: true, status: 200, data });
const REAL = { mode: 'REAL', configured: true, registered: true, checkedAt: 'x' };

test('merchant REAL without ids reads honestly: account connected, latency, data source set / not set', () => {
  assert.equal(mod.merchantRow(ok({ ...REAL, latencyMs: 42, hasDataSource: true })).detail, 'Merchant account connected · 42 ms · data source set');
  assert.equal(mod.merchantRow(ok({ ...REAL, latencyMs: 42, hasDataSource: false })).detail, 'Merchant account connected · 42 ms · data source not set');
  const row = mod.merchantRow(ok({ ...REAL, latencyMs: 7, hasDataSource: true }));
  assert.deepEqual([row.mode, row.creds], ['REAL', 'service account']);
});

test('merchant REAL tolerates an older/admin shape (ids and dataSource) without printing the ids', () => {
  const r = mod.merchantRow(ok({ ...REAL, accountId: '9876543210', accountName: 'Robinize Test Store', dataSource: 'accounts/9876543210/dataSources/1', latencyMs: 9 }));
  assert.equal(r.detail, 'Merchant account connected · 9 ms · data source set');
  assert.equal(mod.merchantRow(ok({ ...REAL, accountId: '9876543210', dataSource: null, latencyMs: 9 })).detail, 'Merchant account connected · 9 ms · data source not set');
});

test('merchant REAL with missing or non-numeric latencyMs omits the latency part (never "undefined ms")', () => {
  for (const latencyMs of [undefined, null, 'fast', Number.NaN, Infinity]) {
    const d = mod.merchantRow(ok({ ...REAL, latencyMs, hasDataSource: true })).detail;
    assert.equal(d, 'Merchant account connected · data source set', String(latencyMs));
    assert.ok(!/undefined|NaN|null|Infinity/.test(d));
  }
});

test('a source whose mode is not a string renders as DEGRADED, never an empty pill', () => {
  const rows = mod.sourceRows(ok({ sources: [
    { id: 'a', label: 'A', mode: undefined, configured: true, searchesByGtin: true, dailyBudget: 5, quotaRemaining: 1 },
    { id: 'b', label: 'B', mode: 7, configured: false, searchesByGtin: false, dailyBudget: 5, quotaRemaining: null },
    { id: 'c', label: 'C', mode: 'REAL', configured: true, searchesByGtin: true, dailyBudget: 5, quotaRemaining: null },
  ] }));
  assert.deepEqual(rows.map((r) => r.mode), ['DEGRADED', 'DEGRADED', 'REAL']);
  const html = mod.render(rows);
  assert.ok(!/<span class="pill [a-z]+"><\/span>/.test(html), html);
  assert.equal((html.match(/>DEGRADED</g) ?? []).length, 2);
});

const src = (over: Record<string, unknown>, backup?: unknown) => ({ id: 'serpapi', label: 'SerpApi Google Shopping', mode: 'REAL', configured: true, searchesByGtin: false, dailyBudget: 8, quotaRemaining: 5, ...over, ...(backup === undefined ? {} : { backup }) });
const bk = (over: Record<string, unknown> = {}) => ({ id: 'searchapi', label: 'SearchApi.io Google Shopping', configured: true, quotaRemaining: 70, ...over });
const backupOf = (s: unknown) => mod.sourceRows(ok({ sources: [s] })).find((r) => r.id === 'serpapi-backup');

test('backup row: configured backup behind a REAL primary reads as standby, used only if SerpApi fails', () => {
  const r = backupOf(src({}, bk()))!;
  assert.equal(r.name, 'SerpApi backup (SearchApi.io)');
  assert.equal(r.detail, 'configured · standby (used only if SerpApi fails) · 70 calls left');
  assert.deepEqual([r.mode, r.creds], ['REAL', 'configured']);
  assert.equal(backupOf(src({}, bk({ quotaRemaining: null })))!.detail, 'configured · standby (used only if SerpApi fails)');
});

test('backup row: never claims REAL when the primary is not REAL or not configured (the backup is never called then)', () => {
  for (const over of [{ mode: 'MOCK', configured: false }, { mode: 'DEGRADED' }, { mode: 'MOCK', configured: true }, { mode: undefined }, { configured: false }]) {
    const r = backupOf(src(over, bk()))!;
    assert.notEqual(r.mode, 'REAL', JSON.stringify(over));
    assert.equal(r.mode, 'NOT_CONNECTED');
    assert.match(r.detail, /^configured · standby \(inactive: SerpApi is not REAL, so this backup is never called\)/);
    assert.equal(r.creds, 'configured');
  }
});

test('backup row: not configured reads as not configured, and a missing or odd backup adds no row (null-safe)', () => {
  const r = backupOf(src({}, bk({ configured: false })))!;
  assert.deepEqual([r.mode, r.detail, r.creds], ['NOT_CONNECTED', 'no API key yet · no backup if SerpApi is down', 'not configured']);
  for (const b of [undefined, null, 'x', 7]) assert.equal(mod.sourceRows(ok({ sources: [src({}, b)] })).length, 1, String(b));
  assert.doesNotThrow(() => mod.sourceRows(ok({ sources: [src({ id: undefined, label: undefined }, bk({ id: undefined, label: undefined }))] })));
});

test('connectors without credentials read NOT CONNECTED with "no API key yet", never mock/demo', () => {
  const m = mod.merchantRow(ok({ mode: 'MOCK', configured: false, missing: ['GOOGLE_SA_JSON', 'MERCHANT_ACCOUNT_ID'] }));
  assert.deepEqual([m.mode, m.detail, m.creds], ['NOT_CONNECTED', 'no API key yet · missing: GOOGLE_SA_JSON, MERCHANT_ACCOUNT_ID', 'not configured']);
  const rows = mod.sourceRows(ok({ sources: [
    { id: 'ebay', label: 'eBay', mode: 'MOCK', configured: false, searchesByGtin: true, dailyBudget: 1000, quotaRemaining: null },
    { id: 'serpapi', label: 'SerpApi', mode: 'REAL', configured: true, searchesByGtin: false, dailyBudget: 8, quotaRemaining: 5 },
  ] }));
  assert.deepEqual(rows.map((r) => r.mode), ['NOT_CONNECTED', 'REAL']);
  assert.equal(rows[0].detail, 'no API key yet · exact GTIN/UPC lookup');
  assert.doesNotMatch(rows[1].detail, /no API key yet/);
  const html = mod.render([m, ...rows]);
  assert.equal((html.match(/>NOT CONNECTED</g) ?? []).length, 2);
  assert.doesNotMatch(html, /mock|demo/i);
});

const PM = 'https://explorer.testnet.chain.robinhood.com/address/0x8366a39CC670B4001A1121B8F6A443A643e40951';
const pool = (over: Record<string, unknown> = {}) => ({ mode: 'REAL', priceMusdcPerUnit: '10.990000', stableSymbol: 'mUSDG', liquidity: '17851181514', inRange: true, blockNumber: 128214496, explorer: { poolManager: PM }, ...over });

test('v4 pool row: REAL reads price, liquidity in range, block, secondary venue, and links the PoolManager', () => {
  const r = mod.v4PoolRow(ok(pool()));
  assert.equal(r.name, 'Uniswap v4 pool (test token pair)');
  assert.deepEqual([r.mode, r.creds], ['REAL', 'public RPC']);
  assert.equal(r.detail, 'price 10.990000 mUSDG per unit · liquidity in range yes · block 128214496 · secondary venue, not a hook');
  assert.deepEqual(r.link, { href: PM, text: 'PoolManager on the explorer' });
  assert.match(mod.v4PoolRow(ok(pool({ inRange: false }))).detail, /liquidity in range no ·/);
  assert.match(mod.v4PoolRow(ok(pool({ liquidity: '0' }))).detail, /liquidity in range no ·/);
});

test('v4 pool row: the stable symbol comes from the API (re-pooled stable), and an absent or unsafe one reads "stable"', () => {
  assert.equal(mod.v4PoolRow(ok(pool({ stableSymbol: 'mUSDG' }))).detail, 'price 10.990000 mUSDG per unit · liquidity in range yes · block 128214496 · secondary venue, not a hook');
  for (const stableSymbol of [undefined, null, '', 7, '<img src=x>', 'x'.repeat(17)]) {
    assert.match(mod.v4PoolRow(ok(pool({ stableSymbol }))).detail, /^price 10\.990000 stable per unit · /, String(stableSymbol));
  }
});

test('v4 pool row: DEGRADED, offline and malformed answers never print undefined/null and never claim REAL', () => {
  const d = mod.v4PoolRow(ok({ mode: 'DEGRADED', error: { code: 'RPC_UNAVAILABLE' }, explorer: { poolManager: PM } }));
  assert.deepEqual([d.mode, d.detail], ['DEGRADED', 'chain read unavailable (RPC_UNAVAILABLE) · secondary venue, not a hook']);
  assert.equal(mod.v4PoolRow({ ok: false, status: 0, offline: true, error: { message: 'API unreachable' } }).mode, 'OFFLINE');
  assert.equal(mod.v4PoolRow({ ok: false, status: 429, offline: false, error: { message: 'rate limited' } }).mode, 'DEGRADED');
  for (const bad of [ok(null), ok({}), ok({ mode: 'REAL' }), ok({ mode: 'REAL', priceMusdcPerUnit: 7 }), ok({ mode: 'WAT' })]) {
    const r = mod.v4PoolRow(bad);
    assert.equal(r.mode, 'DEGRADED', JSON.stringify(bad));
    assert.doesNotMatch(r.detail, /undefined|null|NaN/);
  }
  // an explorer link that is not our explorer is dropped
  assert.equal(mod.v4PoolRow(ok(pool({ explorer: { poolManager: 'javascript:alert(1)' } }))).link, undefined);
  assert.equal(mod.v4PoolRow(ok(pool({ explorer: undefined }))).link, undefined);
  assert.doesNotThrow(() => mod.v4PoolRow(ok(pool({ blockNumber: undefined }))));
  assert.doesNotMatch(mod.v4PoolRow(ok(pool({ blockNumber: undefined }))).detail, /block|undefined/);
});

test('v4 pool row renders as a table row with a REAL pill and an explorer link; no mock/demo wording', () => {
  const html = mod.render([mod.v4PoolRow(ok(pool()))]);
  assert.match(html, /<span class="pill ok">REAL<\/span>/);
  assert.match(html, new RegExp('<a [^>]*href="' + PM + '"'));
  assert.match(html, /rel="noopener noreferrer"/);
  assert.doesNotMatch(html, /mock|demo|sample|simulated|recorded/i);
});
