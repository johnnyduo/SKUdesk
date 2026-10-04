// One-time bulk seed of SerpApi Google Shopping prices for every catalog SKU, run locally with Node (runs TypeScript natively):
//   node --env-file=../../.env worker/scripts/seed-prices.ts            (dry run: prints the plan, spends nothing)
//   node --env-file=../../.env worker/scripts/seed-prices.ts --go       (spends one search per DISTINCT title)
//   --reserve N (non-negative integer, default 20) keeps that many searches unspent; --align-counter also writes the app's
//   monthly SerpApi counter from SerpApi's this_month_usage (off by default: its billing month may not be the UTC month).
// SKUs that share a title share one search. Raw responses are kept in .wrangler/seed-cache, so reruns and resumes cost 0.
// Outputs (never contain the API key): seed-out/serpapi-observations.sql (D1) and seed-out/serpapi-kv.json (KV feed cache).
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { feedCacheKey } from '../feeds/cache.ts';
import { canonFromEntry, gateOffer } from '../feeds/compare.ts';
import { monthlyQuotaKey, QUOTA_MONTH_TTL_SECONDS } from '../feeds/quota.ts';
import { parseSerpApi, serpapiFeed, serpapiSearchUrl } from '../feeds/serpapi.ts';
import { sha256Hex } from '../security.ts';
import { parseManifest } from '../manifest.ts';
import type { ManifestEntry } from '../manifest.ts';

export type SeedArgs = { manifest: string; go: boolean; reserve: number; cacheDir: string; out: string; alignCounter: boolean };

// Pure and exported so a test can exercise it. Throws a clear Error BEFORE any network call: a NaN reserve would silently
// disable the reserve guard (account.plan_searches_left - n < NaN is always false).
export function parseSeedArgs(argv: string[]): SeedArgs {
  const { values } = parseArgs({
    args: argv,
    options: {
      manifest: { type: 'string', default: 'dist/p/manifest.json' },
      go: { type: 'boolean', default: false },
      reserve: { type: 'string', default: '20' },
      'cache-dir': { type: 'string', default: '.wrangler/seed-cache' },
      out: { type: 'string', default: 'seed-out' },
      'align-counter': { type: 'boolean', default: false },
    },
  });
  const reserve = /^\d+$/.test(values.reserve!) ? Number(values.reserve) : Number.NaN;
  if (!Number.isSafeInteger(reserve)) throw new Error('--reserve must be a non-negative integer (got ' + JSON.stringify(values.reserve) + ')');
  return { manifest: values.manifest!, go: values.go!, reserve, cacheDir: values['cache-dir']!, out: values.out!, alignCounter: values['align-counter']! };
}

// SerpApi's account.json reports this_month_usage for ITS billing period, not necessarily the UTC calendar month the app's
// monthly counter (monthlyQuotaKey) is keyed on, and carries no period date to compare. So the counter is only overwritten on
// an explicit --align-counter, and only from a sane integer; otherwise it is left alone and a warning says why.
export function counterAlignment(flag: boolean, thisMonthUsage: unknown, spent: number): { write: boolean; value: number | null; warning: string } {
  if (!flag) return { write: false, value: null, warning: 'monthly counter NOT written: SerpApi reports usage for its own billing period, which may differ from the UTC calendar month the app counts in. Re-run with --align-counter to write it anyway.' };
  if (typeof thisMonthUsage !== 'number' || !Number.isSafeInteger(thisMonthUsage) || thisMonthUsage < 0) return { write: false, value: null, warning: 'monthly counter NOT written: SerpApi did not report a usable this_month_usage.' };
  return { write: true, value: thisMonthUsage + spent, warning: 'monthly counter written from SerpApi this_month_usage (billing period assumed to equal the current UTC month; check the account page if it renews mid-month).' };
}

async function main(): Promise<void> {
const args = parseSeedArgs(process.argv.slice(2)); // validated first: nothing below runs on a bad argument
const key = process.env.SERPAPI_KEY;
if (!key) throw new Error('SERPAPI_KEY is not set (use --env-file=../../.env)');
const manifest = parseManifest(JSON.parse(readFileSync(args.manifest, 'utf8')));
if (!manifest) throw new Error('manifest is invalid: ' + args.manifest);

// One search per distinct title (case/space-insensitive); the first SKU of a group is its canon for identity gating.
const groups = new Map<string, ManifestEntry[]>();
for (const e of manifest.entries) {
  const k = e.title.trim().toLowerCase().replace(/\s+/g, ' ');
  groups.set(k, [...(groups.get(k) ?? []), e]);
}
const cacheDir = args.cacheDir;
mkdirSync(cacheDir, { recursive: true });
const cachePath = async (k: string) => cacheDir + '/' + (await sha256Hex(k)).slice(0, 24) + '.json';

const account = await (await fetch('https://serpapi.com/account.json?api_key=' + encodeURIComponent(key))).json() as { plan_searches_left?: number; this_month_usage?: number; error?: string };
if (account.error || typeof account.plan_searches_left !== 'number') throw new Error('account check failed: ' + (account.error ?? 'no plan_searches_left'));
const todo: string[] = [];
for (const k of groups.keys()) if (!existsSync(await cachePath(k))) todo.push(k);
const reserve = args.reserve;
const monthlyCap = serpapiFeed.monthlyBudget!({} as never);
console.log(`SKUs: ${manifest.entries.length} | distinct titles: ${groups.size} | already saved: ${groups.size - todo.length} | searches needed: ${todo.length}`);
console.log(`SerpApi searches left this month: ${account.plan_searches_left} (used ${account.this_month_usage}) | after seed: ${account.plan_searches_left - todo.length} | reserve kept: ${reserve} | app monthly cap: ${monthlyCap}`);
if (todo.length > 0 && account.plan_searches_left - todo.length < reserve) throw new Error('refusing: seed would leave fewer than ' + reserve + ' searches (use --reserve to change)');
if (todo.length > 0 && !args.go) console.log('dry run: nothing spent. Re-run with --go to spend ' + todo.length + ' searches.');

let spent = 0;
if (args.go) {
  for (const k of todo) {
    const title = groups.get(k)![0].title;
    const res = await fetch(serpapiSearchUrl({ gtin: null, query: title, country: 'US' }, key), { headers: { accept: 'application/json' } });
    let body: unknown;
    try { body = await res.json(); } catch { throw new Error('stopped after ' + spent + ' searches: non-JSON answer (HTTP ' + res.status + ')'); }
    if (!res.ok && res.status !== 404) throw new Error('stopped after ' + spent + ' searches: HTTP ' + res.status);
    parseSerpApi(body, 'x'); // throws on error bodies other than "no results" and on a "Processing"/unrecognised shape: never save a failed response
    writeFileSync(await cachePath(k), JSON.stringify(body));
    spent++;
    process.stdout.write(`\r${spent}/${todo.length} ${title.slice(0, 50).padEnd(50)}`);
    await new Promise((r) => setTimeout(r, 400));
  }
  console.log('\nspent ' + spent + ' searches');
}

// Build outputs from whatever is saved (a partial run still produces a valid, smaller seed).
// Every row and cache entry is stamped with the time its search was ACTUALLY made (the saved file's mtime), never "now":
// a rerun days later must not make old prices look fresh. Entries already past the feed's maxStaleMs are not emitted.
const nowMs = Date.now();
const q = (s: string | null) => (s === null ? 'NULL' : "'" + s.replace(/'/g, "''") + "'");
const sql: string[] = [];
const kv: { key: string; value: string; expiration_ttl: number }[] = [];
let rowCount = 0;
let covered = 0;
let expired = 0;
let badSaved = 0;
for (const [k, entries] of groups) {
  if (!existsSync(await cachePath(k))) continue;
  const fetchedAtMs = Math.floor(statSync(await cachePath(k)).mtimeMs);
  const ageMs = nowMs - fetchedAtMs;
  if (ageMs > serpapiFeed.maxStaleMs) { expired++; continue; }
  const title = entries[0].title;
  let offers: ReturnType<typeof parseSerpApi>;
  try {
    offers = parseSerpApi(JSON.parse(readFileSync(await cachePath(k), 'utf8')), new Date(fetchedAtMs).toISOString());
  } catch {
    badSaved++; // a body saved by an older version of this script, or hand-edited: skip it, never turn it into an empty REAL answer
    continue;
  }
  const query = { gtin: null, query: title, country: 'US' as const };
  kv.push({ key: await feedCacheKey('serpapi', query), value: JSON.stringify({ fetchedAtMs, offers }), expiration_ttl: Math.max(60, Math.ceil((serpapiFeed.maxStaleMs - ageMs) / 1000)) });
  sql.push(`DELETE FROM price_observations WHERE source = 'serpapi' AND gtin IS NULL AND query = ${q(title)};`);
  const canon = canonFromEntry(entries[0]);
  for (const o of offers) {
    const g = gateOffer(canon, query, o);
    sql.push(`INSERT INTO price_observations (source, gtin, query, price_cents, currency, locked, title, url, observed_at) VALUES ('serpapi', NULL, ${q(title)}, ${g.totalCents}, 'USD', ${g.locked ? 1 : 0}, ${q(o.title.slice(0, 200))}, ${q(o.url)}, ${fetchedAtMs});`);
    rowCount++;
  }
  covered += entries.length;
}
if (expired) console.log(`skipped ${expired} saved searches older than ${serpapiFeed.maxStaleMs / 3600000} h (rerun with --go to refresh them)`);
if (badSaved) console.log(`skipped ${badSaved} saved searches that are not a valid SerpApi answer (delete those files in ${cacheDir} and rerun with --go)`);
// Optionally align the app's monthly counter with what SerpApi says was really used, so the app cap cannot overshoot the real plan.
// Opt-in only (--align-counter): SerpApi's billing month may not be the UTC month the counter is keyed on.
const cacheEntries = kv.length;
const align = counterAlignment(args.alignCounter, account.this_month_usage, spent);
console.log(align.warning);
if (align.write) kv.push({ key: monthlyQuotaKey('serpapi', nowMs), value: String(align.value), expiration_ttl: QUOTA_MONTH_TTL_SECONDS });
mkdirSync(args.out, { recursive: true });
writeFileSync(args.out + '/serpapi-observations.sql', sql.join('\n') + '\n');
writeFileSync(args.out + '/serpapi-kv.json', JSON.stringify(kv));
console.log(`wrote ${args.out}/serpapi-observations.sql (${rowCount} rows) and serpapi-kv.json (${cacheEntries} cache entries${align.write ? ' + monthly counter' : ''}) covering ${covered}/${manifest.entries.length} SKUs`);
}

// Run only as a script (node worker/scripts/seed-prices.ts), never when a test imports the helpers above.
const isMain = (() => { try { return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } })();
if (isMain) {
  main().catch((e: unknown) => {
    console.error('\nseed-prices: ' + (e instanceof Error ? e.message : 'failed')); // messages never include the API key
    process.exitCode = 1;
  });
}
