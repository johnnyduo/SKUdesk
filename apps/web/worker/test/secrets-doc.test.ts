import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');

test('every secret in env.ts Secrets is in .dev.vars.example and has a wrangler secret put line in the runbook', () => {
  const envTs = read('../env.ts');
  const block = envTs.slice(envTs.indexOf('export type Secrets = {'), envTs.indexOf('};', envTs.indexOf('export type Secrets = {')));
  const names = [...block.matchAll(/^\s+([A-Z_]+)\?: string;/gm)].map((m) => m[1]).sort();
  assert.deepEqual(names, ['ADMIN_TOKEN', 'BESTBUY_API_KEY', 'EBAY_CLIENT_ID', 'EBAY_CLIENT_SECRET', 'GOOGLE_SA_JSON', 'MERCHANT_ACCOUNT_ID', 'MERCHANT_DATA_SOURCE_ID', 'SEARCH_API_KEY', 'SERPAPI_KEY']);
  const example = read('../../.dev.vars.example');
  const exampleKeys = [...example.matchAll(/^([A-Z_]+)=$/gm)].map((m) => m[1]).sort();
  assert.deepEqual(exampleKeys, names);
  const runbook = read('../../../../docs/runbooks/worker-backend.md');
  for (const n of names) assert.match(runbook, new RegExp('wrangler secret put ' + n + '\\b'), n);
});

test('wrangler.jsonc carries no secret values', () => {
  const cfg = read('../../wrangler.jsonc');
  for (const n of ['ADMIN_TOKEN', 'GOOGLE_SA_JSON', 'SERPAPI_KEY', 'SEARCH_API_KEY', 'EBAY_CLIENT_SECRET', 'BESTBUY_API_KEY', 'PRIVATE KEY']) assert.ok(!cfg.includes(n), n);
});

test('runbook says the public merchant status omits account ids and the admin token reveals them', () => {
  const runbook = read('../../../../docs/runbooks/worker-backend.md');
  assert.match(runbook, /omits the account identifiers \(`accountId`, `accountName`, `dataSource`\)/);
  assert.match(runbook, /hasDataSource/);
});
