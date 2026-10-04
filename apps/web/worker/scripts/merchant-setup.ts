// One-time Merchant Center setup, run locally with Node 26 (runs TypeScript natively):
//   node worker/scripts/merchant-setup.ts --sa /secure/path/sa.json --account 123456789 --developer-email you@example.com --register
//   node worker/scripts/merchant-setup.ts --sa /secure/path/sa.json --account 123456789 --ensure-data-source
//   node worker/scripts/merchant-setup.ts --account 123456789 --developer-email you@example.com --plan   (no network, no key)
// Never writes secrets to disk and never prints key material. Prints the `wrangler secret put` commands to run.
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { getGoogleAccessToken } from '../google/auth.ts';
import { parseServiceAccount } from '../google/jwt.ts';
import { createMerchantClient } from '../google/merchantClient.ts';
import type { MerchantRequest } from '../google/merchantClient.ts';
import { createDataSourceRequest, dataSourceIdOf, findPrimaryApiDataSource, getRegistrationRequest, listDataSourcesRequest, registerGcpRequest } from '../google/setup.ts';
import type { FoundDataSource } from '../google/setup.ts';

const BASE = 'https://merchantapi.googleapis.com';
const TARGET = { language: 'en', feedLabel: 'US', countries: ['US'] };

const { values } = parseArgs({
  options: {
    sa: { type: 'string' },
    account: { type: 'string' },
    'developer-email': { type: 'string' },
    register: { type: 'boolean', default: false },
    'ensure-data-source': { type: 'boolean', default: false },
    plan: { type: 'boolean', default: false },
  },
});

function fail(msg: string): never {
  console.error('error: ' + msg);
  process.exit(1);
}

const account = values.account ?? fail('--account <numeric Merchant Center id> is required');
if (!/^\d+$/.test(account)) fail('--account must be numeric');

const show = (r: MerchantRequest) => console.log(r.method + ' ' + BASE + r.path + (r.query ? '?' + new URLSearchParams(r.query).toString() : '') + (r.body ? ' ' + JSON.stringify(r.body) : ''));

if (values.plan) {
  if (values['developer-email']) show(registerGcpRequest(account, values['developer-email']));
  show(getRegistrationRequest(account));
  show(listDataSourcesRequest(account));
  show(createDataSourceRequest(account, TARGET));
  process.exit(0);
}

const saPath = values.sa ?? fail('--sa <path to service-account JSON> is required (keep it outside the repo)');
const saJson = readFileSync(saPath, 'utf8');
const sa = parseServiceAccount(saJson);
const mem = new Map<string, string>();
const kv = {
  get: async (k: string) => mem.get(k) ?? null,
  put: async (k: string, v: string) => { mem.set(k, v); },
  delete: async (k: string) => { mem.delete(k); },
};
const clientOpts = {
  base: BASE,
  getToken: (force: boolean) => getGoogleAccessToken({ saJson, kv, fetch: (i, init) => fetch(i, init), nowMs: Date.now(), forceRefresh: force }),
  fetch: (i: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => fetch(i, init),
  sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
  random: Math.random,
  nowMs: Date.now,
};
const client = createMerchantClient(clientOpts);
// The data source create is not idempotent: the client's automatic POST retry on 5xx/network failure could
// create a duplicate if the first call succeeded but its response was lost. So the create is never auto-retried;
// on failure, re-run --ensure-data-source, which lists (and finds) any source that was in fact created.
const createClient = createMerchantClient({ ...clientOpts, maxRetries: 0 });
console.log('service account: ' + sa.client_email);

if (values.register) {
  const email = values['developer-email'] ?? fail('--developer-email <your Google account email> is required for --register');
  const r = await client.request<{ gcpIds?: string[] }>(registerGcpRequest(account, email));
  console.log('registered; gcpIds: ' + JSON.stringify(r.data.gcpIds ?? []));
  console.log('wait 5 minutes before calling other Merchant API methods.');
}

if (values['ensure-data-source']) {
  let found: FoundDataSource | null = null;
  let pageToken: string | undefined;
  do {
    const page = await client.request<{ dataSources?: unknown[]; nextPageToken?: string }>(listDataSourcesRequest(account, pageToken));
    found = findPrimaryApiDataSource(page.data, TARGET);
    pageToken = page.data.nextPageToken;
  } while (!found && pageToken);
  if (found) {
    console.log('existing API data source: ' + found.name);
  } else {
    const created = await createClient.request<{ name?: string; dataSourceId?: string }>(createDataSourceRequest(account, TARGET));
    const id = dataSourceIdOf(created.data) ?? fail('create returned no data source id');
    found = { name: 'accounts/' + account + '/dataSources/' + id, dataSourceId: id };
    console.log('created API data source: ' + found.name);
  }
  console.log('\nRun these from apps/web (values are typed at the prompt, never stored in the repo):');
  console.log('  npx wrangler secret put MERCHANT_ACCOUNT_ID        # enter: ' + account);
  console.log('  npx wrangler secret put MERCHANT_DATA_SOURCE_ID    # enter: ' + found.dataSourceId);
  console.log('  npx wrangler secret put GOOGLE_SA_JSON < ' + saPath);
}

if (!values.register && !values['ensure-data-source']) {
  const r = await client.request<{ gcpIds?: string[] }>(getRegistrationRequest(account));
  console.log('developer registration gcpIds: ' + JSON.stringify(r.data.gcpIds ?? []));
}
