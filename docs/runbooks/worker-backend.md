# Runbook: Robinize Worker backend (Google Merchant + price feeds)

Scope: everything the operator does by hand: credentials, Cloudflare resources, first deploy, live smoke, rollback.
- **Where to run:** all commands run from `apps/web`.
- **Secrets:** they are typed at Wrangler prompts or piped from files outside the repo. Never paste them into chat, commit them or put them in `wrangler.jsonc`.
- **Market:** US / English / USD only.
- **Status of this document:** the backend code is tested offline. Facts about the repo are stated plainly; every fact about the live Worker is an operator check to repeat, not something this runbook guarantees.
- **In the repo (verifiable):**
  - `apps/web/wrangler.jsonc` pins the KV namespace (binding `CACHE`) and the D1 database (binding `DB`, database `robinize`) by their real ids.
  - `apps/web/public/_headers` carries the static-page security headers (§6b).
  - The agent is registered in the ERC-8004 Identity Registry on Robinhood Chain Testnet as agent id **119** (`docs/agent-identity.md`).
  - Paid price sources (SerpApi, and its SearchApi.io backup) are spent only by a request with a valid `x-admin-token` and by the cron hero warm-up (§6a). Anonymous visitors read the cache only.
- **Deployment state (2026-10-03), to confirm with the commands shown:**
  - A Worker answers on `/api/*` at `https://skudesk.lol` with the KV and D1 ids pinned and the remote D1 migration applied. Confirm with `npx wrangler deployments list` and `npx wrangler d1 migrations list robinize --remote`.
  - Google Merchant: **REAL** on the live Worker. `/api/merchant/status` reads `mode: REAL`, registered, with a data source, and the Merchant secrets are set. Confirm with L2.
  - SerpApi and its SearchApi.io backup: **REAL**. The backup is a failover only. Confirm with `/api/prices/sources`.
  - eBay and Best Buy: still **NOT CONNECTED** in the UI (their keys are not set; the compare panel shows TEST DATA; the raw API enum stays `MOCK`).
  - **Nothing has been exercised live for publishing to Google Merchant, and none of the live checks below (§3 and L2–L13) has been run by this runbook.** They stay open operator steps: no live insert, read-back or delete has been verified.

## 0. Prerequisites checklist

| Item | Where | Notes |
|---|---|---|
| Cloudflare account logged in | `npx wrangler login`, `npx wrangler whoami` | Same account that hosts `robinize.agent-dong.workers.dev` |
| Google Merchant Center **production** account | merchants.google.com | Test accounts cannot register a GCP project |
| Website verified **and** claimed for `https://skudesk.lol` | Merchant Center → Business info → Website | Required for `link` and for developer registration |
| Return policy and contact set in Merchant Center, and on the landing pages | `apps/web/src/lib/listing.ts` → `STORE_POLICY` | Listings are disapproved without them (Google Shopping surfaces require a legitimate purchasable offer, a return and contact policy and business info). `STORE_POLICY` is currently `{returnsUrl: null, contactEmail: null}`; setting real values is a code change that needs a rebuild and a redeploy **before any live listing** |
| GCP project with **Merchant API** enabled | console.cloud.google.com → APIs & Services | Dedicated project recommended |
| Service account + JSON key | IAM → Service accounts → Keys → Add key (JSON) | Store the file **outside** the repo, e.g. `~/secure/robinize-sa.json` |
| Service-account email added as a Merchant Center user with **Admin** access | Merchant Center → Settings → People and access | — |
| eBay developer keyset (production) | developer.ebay.com → Application Keys | Also opt out of Marketplace Account Deletion ("not persisting eBay data"). Browse in production is "intended for eBay partners": if production calls fail, use sandbox (§4) |
| Best Buy API key | developer.bestbuy.com | A business email may be required. Not issued yet; Best Buy stays NOT CONNECTED (API mode `MOCK`) until it is set (L7) |
| SerpApi key | serpapi.com → Dashboard | Free plan: 250 searches/month. The Worker caps itself at 8/day (`QUOTA_SERPAPI_DAILY`) and 240/month (`QUOTA_SERPAPI_MONTHLY`). Only the operator (valid `x-admin-token`) and the cron hero warm-up (about 2 calls/day) can spend it; anonymous visitors read the cache only (§6a) |
| SearchApi.io key | searchapi.io → Dashboard | Free plan: **100 credits in total, they never refill** (`GET /api/v1/me` shows credits left and is free). It is only SerpApi's failover backup, and only for a real outage: it is called after SerpApi's **upstream failure** (HTTP error, timeout or bad response) when no cached copy exists. SerpApi's own brakes (`quota_exhausted` daily or monthly, `quota_unavailable`) never trigger it. The Worker caps it at 3/day (`QUOTA_SEARCHAPI_DAILY`) and 90 calls for the whole plan (`QUOTA_SEARCHAPI_TOTAL`): a lifetime counter in KV key `quota:v1t:searchapi` with no expiry, failing closed if KV cannot be read or written. It starts at 0 on the first deploy of this version, so seed it with the credits already used (operator step, §4a). Reset it only by deleting that key after a plan change. Data is cached and shown for at most 24 h, like SerpApi's. **Terms: REVIEWED 2026-10-03 (ToS last updated 2026-04-11)**, `https://www.searchapi.io/legal/terms`: caching, storage, retention and rate limits are not mentioned; display is covered only by the general clause against reproducing, copying, selling, reselling or exploiting the Services without written permission; altering, removing or concealing proprietary notices on the Data is prohibited, so keep the "Prices from Google Shopping via SearchApi.io" attribution; reselling or redistributing the Service itself to a third party needs prior written consent (we expose no raw API responses or API proxy, the Worker returns derived, gated offers; our reading, not legal advice); the free plan carries no stated commercial-use restriction; Google's own terms are not addressed. Our use (24 h cache, 30-day observation rows, public display with attribution, failover-only) is not prohibited by the stated terms. **Open item for the owner:** whether republishing Google Shopping-derived data is acceptable under Google's content terms is not settled by this ToS and needs the owner's judgement. The cap is an app-side brake: `GET /api/v1/me` is the truth |

## 1. Cloudflare resources (already pinned) and the remote schema

The KV namespace and the D1 database already exist on the account, and their real ids are already pinned in `wrangler.jsonc`:
- `kv_namespaces`: binding `CACHE`.
- `d1_databases`: binding `DB`, database `robinize`, `migrations_dir` `worker/migrations`.

Do **not** create them again. `wrangler kv namespace create` / `wrangler d1 create` would mint new, unpinned resources.

The remote schema: the migration is already applied to the **remote** D1 database. Confirm it before relying on it (until it is applied, listing and observation writes fail on the deployed Worker):

```bash
npx wrangler d1 migrations list robinize --remote     # should list 0001_init.sql as applied
npx wrangler d1 migrations apply robinize --remote    # only if it is not
```

- [ ] Remote D1 migration `0001_init.sql` confirmed applied

## 2. Secrets

The Worker reads exactly nine secrets. They are all optional at runtime: a missing one keeps that integration on test data, reported as NOT CONNECTED (API mode `MOCK`), or `NOT_CONFIGURED` for a live write. Reported state on the live Worker: the Merchant secrets and the SerpApi key are set; `EBAY_CLIENT_ID`, `EBAY_CLIENT_SECRET` and `BESTBUY_API_KEY` are not, so eBay and Best Buy read NOT CONNECTED. Check names only with `npx wrangler secret list`. Each command prompts for the value. Nothing is echoed or stored in the repo.

```bash
npx wrangler secret put ADMIN_TOKEN            # >= 32 random chars, e.g. from: openssl rand -hex 24
npx wrangler secret put GOOGLE_SA_JSON < ~/secure/robinize-sa.json
npx wrangler secret put MERCHANT_ACCOUNT_ID    # numeric Merchant Center id
npx wrangler secret put MERCHANT_DATA_SOURCE_ID  # from step 3 below
npx wrangler secret put EBAY_CLIENT_ID
npx wrangler secret put EBAY_CLIENT_SECRET
npx wrangler secret put BESTBUY_API_KEY
npx wrangler secret put SERPAPI_KEY
npx wrangler secret put SEARCH_API_KEY          # SearchApi.io, SerpApi's backup (100 credits in total)
npx wrangler secret list                       # names only
```

The test `worker/test/secrets-doc.test.ts` keeps three things in lockstep: the `Secrets` type in `worker/env.ts`, `apps/web/.dev.vars.example`, and the `wrangler secret put` lines above. Adding a secret to `env.ts` fails that test until the other two are updated.

**Local runs:**
1. Copy `.dev.vars.example` to `.dev.vars`. It is git-ignored; never commit it.
2. Fill in only what you need.
3. `npm run smoke:worker` (the offline smoke against local `wrangler dev`) **refuses to run** while a real `apps/web/.dev.vars`, `.dev.vars.<env>`, `.env` or `.env.*` exists, because wrangler would load real secrets from them. The tracked, value-free templates `.dev.vars.example` and `.env.example` no longer block it. Move the real file aside before running the smoke, or set `SMOKE_ALLOW_DEV_VARS=1` if you really mean it.

## 3. One-time Merchant setup

Registration and the API data source are done (`/api/merchant/status` reads REAL with a data source). Repeat the checks below before relying on them.

```bash
node worker/scripts/merchant-setup.ts --account <MERCHANT_ACCOUNT_ID> --developer-email <your Google account email> --plan   # prints requests, no network
node worker/scripts/merchant-setup.ts --sa ~/secure/robinize-sa.json --account <MERCHANT_ACCOUNT_ID> --developer-email <your email> --register
# wait 5 minutes
node worker/scripts/merchant-setup.ts --sa ~/secure/robinize-sa.json --account <MERCHANT_ACCOUNT_ID> --ensure-data-source
```

**What each run does:**
- **`--register`** prints the registered `gcpIds`.
- **`--ensure-data-source`** reuses an existing API primary source for `en`/`US`, or creates "Robinize API" with countries `["US"]`.
  - Destinations are left unset, so they are inherited from the account.
  - It then prints the `wrangler secret put` commands, including the data source id.

- [ ] GCP project registered (`--register`)
- [ ] API data source exists and `MERCHANT_DATA_SOURCE_ID` is set

## 4. eBay sandbox fallback

If production Browse calls return 403 or 401 for your keyset:
1. Set the var `EBAY_API_BASE` to `https://api.sandbox.ebay.com` in `wrangler.jsonc`.
2. Use sandbox keys to verify the wiring. Sandbox data is fake.
3. Keep the source labeled honestly: sandbox prices must never be used for decisions.

## 4a. One-time price seed (operator only) and the SearchApi.io counter

**`worker/scripts/seed-prices.ts`** pre-fills SerpApi prices for every catalog SKU so the first visitors do not each spend a search. It is a one-time operator CLI: it is never run by CI, `npm run build` or `wrangler deploy`, and nobody but the operator should run it, because it spends the metered SerpApi plan. It runs from `apps/web` and reads `SERPAPI_KEY` from the git-ignored `../../.env` (the key is never printed or written to the outputs):

```bash
node --env-file=../../.env worker/scripts/seed-prices.ts                 # dry run: prints the plan, spends nothing
node --env-file=../../.env worker/scripts/seed-prices.ts --go            # spends one search per DISTINCT SKU title
```

- **`--go` is required to spend.** Without it nothing is searched: the script only prints how many searches it would make.
- **Reserve guard.** It reads SerpApi's free `account.json` and refuses to start when the run would leave fewer than `--reserve` searches this month (default 20). `--reserve` must be a non-negative integer; anything else aborts before any network call.
- **Safe to rerun.** Raw answers are kept in `.wrangler/seed-cache` (git-ignored), so reruns cost 0 for titles already saved. A "Processing", error or unrecognised answer is never saved.
- **Outputs** go to `seed-out/` (git-ignored): `serpapi-observations.sql` (D1 price observations) and `serpapi-kv.json` (KV feed-cache entries, stamped with the time of the real search, so old prices never look fresh). Review them, then import them yourself (`wrangler d1 execute` and `wrangler kv bulk put`); the script never writes to Cloudflare.
- **KV counters.** The app counts SerpApi searches itself in `quota:v1m:serpapi:<YYYY-MM>` (UTC month). By default the script leaves that counter alone. `--align-counter` also writes `this_month_usage + spent` from SerpApi into the bulk file, but SerpApi's billing month may not be the UTC calendar month, so use it only after checking the account page, and only when the plan renews on the 1st.
- **Mid-month renewal: seed the counter by hand (operator step, not automated, not run by the script).** If the SerpApi plan renews on any other day, do not use `--align-counter`. Instead read `plan_searches_left` from the free `account.json` and set `quota:v1m:serpapi:<YYYY-MM>` (the current UTC month) to your plan's total searches minus `plan_searches_left` (e.g. `250 − plan_searches_left` on a 250-search plan). The app's cap is `QUOTA_SERPAPI_MONTHLY` (240 by default), so keep the result at or below the cap:

  ```bash
  npx wrangler kv key put --binding CACHE --remote "quota:v1m:serpapi:<YYYY-MM>" "<n>"   # n = plan total - plan_searches_left, at most the cap
  ```

**SearchApi.io lifetime counter (operator step, not automated).** The backup's cap is the lifetime KV counter `quota:v1t:searchapi`. It starts at **0 on the first deploy of this version**, even if some of the 100 free credits are already spent. Before relying on the cap, read the credits **left** from the free `GET https://www.searchapi.io/api/v1/me` (see L13 for the Bearer header; the key stays in a shell variable) and seed the counter with the credits already **used**, which is `100 − credits left`. Example: `/me` reports 72 credits left, so seed 28. **Do not seed the credits-left number**: seeding 72 would make the app believe 72 of its 90 calls are spent and would wrongly disable the backup early.

```bash
npx wrangler kv key put --binding CACHE --remote "quota:v1t:searchapi" "<100 minus credits left>"   # e.g. "28" when 72 are left
```

Do not delete it afterwards except after a plan change (§0).

## 5. Deploy

**What is live today.** A Worker is already deployed at `https://skudesk.lol` (confirm with `npx wrangler deployments list`). It serves `/api/*` and the static assets. Google Merchant and SerpApi read REAL, eBay and Best Buy read NOT CONNECTED (API mode `MOCK`). Secrets live on the Worker and are not changed by a deploy. A new `wrangler deploy` replaces that version, so:
- Build and deploy from `main`, so `/market`, `/app/owner`, `/show` and `/deck` stay in the asset bundle (a build from an older branch would drop them).
- Check `git status` is clean for `apps/web/src`, and `git log -1` is the commit you intend to ship.
- After deploy, open the four pages above and the landing page before running the smoke checklist.

```bash
npm run test:worker && npm run test:site && npm run check:worker && npm run check:site
npm run build && npm run test:built
npx wrangler deploy --dry-run
npx wrangler deploy
```

- [ ] Deployed from `main`; `/market`, `/app/owner`, `/show`, `/deck` still load

## 6. Live smoke checklist (run once after deploy)

`BASE=https://skudesk.lol`, `TOKEN=<ADMIN_TOKEN>` (shell variable only; do not save it in history files you share).

Behaviours the checklist relies on:
- `GET /api/merchant/status`, `/api/prices/sources` and `/api/prices/compare` are **public**; they reveal modes and counts, never secrets. The merchant status omits the account identifiers (`accountId`, `accountName`, `dataSource`) and `GET /api/merchant/listing/:offerId` omits `productName`; both are shown only to a caller that sends a valid `x-admin-token`. Public REAL status carries `hasDataSource` instead.
- A listing POST is a **dry run by default**. A live write needs a valid `x-admin-token` **and** the JSON boolean `"dryRun": false`. A live request without a valid token returns `401 UNAUTHORIZED`; it never silently succeeds.
- The API is same-origin only. `curl` sends no `Origin`, which is allowed; a foreign `Origin` on a state-changing request gets `403`.
- Rate limits: write 5/60 s, read 30/60 s, compare 10/60 s. Space the calls out if you see `RATE_LIMITED`.
- Source freshness limits: SerpApi data, and the SearchApi.io backup's, are shown for at most 24 h (SerpApi 8 searches/day and 240/month; SearchApi.io 3/day and 90 in total), eBay for at most 6 h and Best Buy for at most 72 h (with "Best Buy" attribution). The SerpApi 24 h is a **display** freshness limit only: its D1 observation rows persist for 30 days. Only eBay (6 h) and Best Buy (72 h) rows have a shorter purge, which the cron applies.

| # | Command | Expect |
|---|---|---|
| L1 | `curl -s $BASE/api/health` | `{"ok":true,…}` |
| L2 | `curl -s $BASE/api/merchant/status` (public: no ids), then `curl -s -H "x-admin-token: $TOKEN" $BASE/api/merchant/status` | public: `"mode":"REAL"`, `"hasDataSource":true`, and **no** `accountId`/`accountName`/`dataSource`; with the token: your `accountId`, `accountName` and `dataSource` as well. If `DEGRADED` + `MERCHANT_NOT_REGISTERED`, redo §3 and wait 5 minutes. The response is KV-cached for its `STATUS_TTL` (60 s), so a `DEGRADED` result may persist briefly after you fix the registration; re-run after a minute |
| L3 | `curl -s -X POST $BASE/api/merchant/listing -H 'content-type: application/json' -d '{"lotId":"SMOKE-TEST-1","title":"iPhone 16 Pro Clear MagSafe Case","link":"https://skudesk.lol/p/CASE-IP16PRO-CLEAR-MAG-001/","imageLink":"https://skudesk.lol/img/cases-png/iphone-16-pro_clear_mag_1.png","priceCents":1099,"brand":"Robinize"}'` | `"mode":"DRY_RUN"`, `wouldSend.body.productAttributes.price.amountMicros` = `"10990000"` |
| L4 | Same as L3 plus `,"dryRun":false` in the body and `-H "x-admin-token: $TOKEN"` (first run it **without** the header and expect `401`) | First publish: `201`, `"mode":"REAL"`, `"status":"SUBMITTED"`, `name` ends with `en~US~SMOKE-TEST-1`. Repeating the identical request returns `200` with `"idempotent":true` |
| L5 | After 5–15 minutes: `curl -s $BASE/api/merchant/listing/SMOKE-TEST-1` | `status` becomes `PROCESSING`, `APPROVED` or `DISAPPROVED`, with `issues[]`. **VERIFY:** `identifierExists:false` is accepted for a GTIN-less product (no `identifierExists` error in `issues`) |
| L6 | `curl -s "$BASE/api/prices/compare?gtin=<a real 12-digit UPC of a product sold on eBay>"` | the `ebay` source has `"mode":"REAL"`, `offers > 0`. **VERIFY:** production Browse access, `gtin=` results, token obtained (the OAuth token is cached in KV for `expires_in` minus 5 minutes; a second compare after the cache window must still be `REAL`) |
| L7 | Same URL | the `bestbuy` source has `"mode":"REAL"` (it may be 0 offers if Best Buy does not carry it; try a UPC Best Buy sells). **VERIFY:** the API key was issued and a `upc=` lookup returns a hit |
| L8 | `curl -s -H "x-admin-token: $TOKEN" "$BASE/api/prices/compare?sku=CASE-IP16PRO-CLEAR-MAG-001"` (the token is required for a **paid** refresh: without it SerpApi answers from the cache only, see §6a) | the `serpapi` source has `"mode":"REAL"`. **VERIFY:** SerpApi field names `product_link` and `extracted_price` still parse (`offers > 0`). Each live SerpApi call spends one of the 8 daily / 240 monthly slots. The Data column shows the UTC date and time of the observation |
| L13 | **SearchApi.io backup (costs 1 of the 100 credits per search; use your own key from a shell variable, never in the URL).** `curl -s -H "Authorization: Bearer $SEARCH_API_KEY" https://www.searchapi.io/api/v1/me` (free) then `curl -s -H "Authorization: Bearer $SEARCH_API_KEY" "https://www.searchapi.io/api/v1/search?engine=google_shopping&q=iPhone+16+Pro+Clear+MagSafe+Case&gl=us&hl=en"` | `/me` shows the credits left (HTTP 200, not 401: Bearer auth works). In the search, **VERIFY** `shopping_results[]` carries `delivery` (a shipping cost like "$5.99 delivery") and, for pre-owned listings, `durability` (e.g. "Pre-owned"); neither was seen in the one earlier live response, so the shipping and used-item mappings are docs-only. Until verified, the Worker also treats the titles "used", "refurbished", "pre-owned", "renewed" and "open box" as non-NEW. To see the backup serve end to end, set a deliberately wrong `SERPAPI_KEY` for one compare (SerpApi then fails upstream): the `searchapi` source answers with `fallbackFor: "serpapi"` and the compare panel notes "SerpApi unavailable (FEED_UPSTREAM) — served by SearchApi.io". Restore the real key afterwards |
| L9 | A compare with ≥ 2 REAL sources having `bestCents` | `spread.basis` = `"REAL"`, `spread.sources ≥ 2` (the done-criterion: at least two REAL sources agree on a spread) |
| L10 | `curl -s -X DELETE $BASE/api/merchant/listing/SMOKE-TEST-1 -H "x-admin-token: $TOKEN"` | `"status":"DELETED"`. Confirm in Merchant Center that the product is gone |
| L11 | `npx wrangler tail --format json` during L1–L10 | one JSON line per request; no token, key, or SA material appears |
| L12 | Cron (`* * * * *`, reconcile job at minutes 0/15/30/45 UTC): after ≥ 15 minutes, look for `"event":"cron"` in Workers Logs | `checked`/`updated` counts |

Compare identity note: a keyword-sourced offer (SerpApi or SearchApi.io, no exact GTIN) is only `locked` when its title shows positive colour evidence (for a clear canonical product: clear, transparent, translucent, crystal or see-through) and none of the form-factor words hard-shell, silicone, leather, wallet, folio, battery, kickstand, rugged, armor, glitter or liquid, or the grip/accessory words popsockets, popcase, popgrip, pop socket, grip, ring holder, stand, lanyard, strap, charm and customiz* (customizable, customized), or a leading "Package" bundle marker (a mid-title "Retail Package" is not penalised), unless the canonical title has the same word; the rest stay in the response with `locked:false` and a `rejectReasons` entry. `locked` is still a title-based match for those offers, not GTIN-verified.

### Operator sign-off (all open; mark only after you ran it and saw the result)

Things that **can only be verified live**, which no offline test can close:
- [ ] Production eBay Browse access with this keyset, token TTL behaviour, and real `gtin=` hits (L6)
- [ ] Best Buy API key issued and a `upc=` hit (L7)
- [ ] SerpApi live field names `product_link` / `extracted_price` parse (L8)
- [ ] SearchApi.io Bearer auth, `delivery` and `durability` fields verified live, and the backup serves when SerpApi fails (L13)
- [ ] Merchant registration and the API data source (§3, L2)
- [ ] First dry run (L3), then ONE live test lot published (L4) and deleted (L10)
- [ ] Google processing status for that lot, including the `identifierExists:false` acceptance (L5)
- [ ] Two REAL sources produce a REAL spread (L9)
- [ ] Logs are clean of secrets (L11) and the cron reports (L12)

## 6a. Paid sources: who may spend them, and the budget math

SerpApi and its SearchApi.io backup are metered, so `GET /api/prices/compare` is **public for reading but never public for spending**:

- A request **without a valid `x-admin-token`** (same constant-time check as publish; wrong, short or empty tokens count as no token) is answered for a paid source from the KV cache only: a fresh copy is a `HIT`; a copy older than the source's fresh window but within 24 h is served as `STALE`; otherwise the source comes back `mode: "REAL"`, `cache: "NONE"`, `offers: []`, `error: "refresh_requires_operator"`. No upstream call is made, no quota counter is read for spending or written, and SearchApi.io is **not** triggered by this condition. eBay and Best Buy are not paid sources and behave as before for everyone.
- A request **with a valid `x-admin-token`** may refresh a paid source under the normal budget and fail-closed rules (8/day and 240/month for SerpApi, 3/day and 90 in total for the backup). The compare rate limit is keyed by the verified admin token hash for such a request and by client IP otherwise.
- The compare panel shows the neutral note "Cached data only. Refreshing paid sources needs the operator." for `refresh_requires_operator` (it is not an error).

**Cron warm-up.** So the public still sees fresh data, each quarter-hour tick (minutes 0/15/30/45) checks the hero SKU (`CASE-IP16PRO-CLEAR-MAG-001`) SerpApi cache entry. If it is missing or at least 12 h old, the cron runs exactly one paid refresh through the normal path (daily and monthly caps, fail-closed on KV errors). Never more than one paid call per tick, never another SKU, never SearchApi.io (the backup is detached for the warm-up, so an outage cannot make one tick two paid calls). It is skipped when SerpApi is unconfigured (API mode `MOCK`) or the quota is exhausted; the log line is `{"event":"cron_warm","code":"<code>"}` with `refreshed`, `fresh`, `quota_exhausted`, `quota_unavailable`, `unconfigured`, `no_hero`, `cooldown`, `daily_cap` or an upstream code, never any upstream text. After a failed refresh (for example `FEED_UPSTREAM`, or a revoked key) the warm-up backs off exponentially: 1 h, 2 h, 4 h, 8 h, then 12 h for every further consecutive failure (KV key `warm:v1:serpapi:retry`, value `{"n":<consecutive failures>,"until":<epoch ms>}`, TTL 2 days; a success deletes it). On top of that it makes at most **3 failed attempts per UTC day** (counter key `warm:v1:serpapi:fail:<YYYY-MM-DD>`, TTL 2 days); after the third the warm-up stays silent (`daily_cap`) until the next UTC day. An unparsable backoff or counter value is treated as the worst case and skips the tick (`cooldown` / `daily_cap`). If KV cannot be read, the warm keys are ignored and the quota counters still fail closed. To restart a warm-up that is stuck in backoff after fixing the key, delete the retry key (`npx wrangler kv key delete warm:v1:serpapi:retry --binding CACHE --remote`).

**Budget math (SerpApi, 250/month plan).** A successful refresh rewrites the entry with a 24 h life, and the next one happens when it is 12 h old: **about 2 paid calls/day for the hero warm-up, about 60 per month**, which leaves roughly 180 of the 240 monthly slots for the operator (manual refreshes, `seed-prices`). A sustained outage or a revoked key costs at most **3 failed warm-up calls per UTC day** (a 7-day continuous 503 replayed in a test makes at most 21, in practice fewer because the 8 h and 12 h backoffs spread the attempts out), so it can no longer drain the 240/month cap; the 8/day cap is shared with operator refreshes. Healthy steady state is about 2 paid calls/day. SearchApi.io is spent only by an operator-triggered compare whose SerpApi call failed upstream with nothing cached.

## 6b. Security headers on static pages

`apps/web/public/_headers` is copied to `dist/_headers` by `npm run build` and read by Workers Static Assets (the `ASSETS` binding serves every non-`/api/` path, so the `/*` rule covers HTML, JS, CSS and images). `/api/*` is answered by the Worker first and keeps its own headers (`no-store`, `nosniff`). The rule sets `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `X-Frame-Options: DENY`, a `Permissions-Policy` disabling camera, microphone, geolocation, payment and usb, `Strict-Transport-Security: max-age=31536000`, and a CSP limited to `frame-ancestors 'none'; base-uri 'self'; object-src 'none'; form-action 'self'`. There is deliberately no `default-src`, `script-src` or `connect-src`: the site uses inline Astro island bootstraps, viem calls the public chain RPC and the Google site-verification meta must keep working. `test/built/pages.test.mjs` asserts the built file. After the next deploy check it live: `curl -sI "$BASE/" | grep -iE 'x-frame|content-security|strict-transport|referrer|permissions|nosniff'`, and confirm `curl -sI "$BASE/api/health"` still shows only the API headers.

## 6c. Uniswap v4 reference pool read (`GET /api/v4/pool`)

A public, read-only route that reads the current mUSDG / tIP16P pool (`docs/v4-pool.md`; mUSDG is a test token with no value) from the Robinhood Chain Testnet RPC. It spends nothing, needs no secret and sends no transaction. The earlier tIP16P / mUSDC pool (`0xb18fd8f2...e3bb`) still exists on chain but was retired when the settlement token was replaced; the Worker no longer reads it unless the vars below are removed.

- **Route list (public reads):** `GET /api/health`, `GET /api/merchant/status`, `GET /api/prices/sources`, `GET /api/prices/compare`, `GET /api/v4/pool`. Rate limit: read, 30 per 60 s (`RL_READ`).
- **Var (not a secret):** `ROBINHOOD_RPC` in `wrangler.jsonc`, default `https://rpc.testnet.chain.robinhood.com`. A value that does not start with `https://` is ignored and the default is used.
- **Pool vars (not secrets, set in `wrangler.jsonc` to the mUSDG pool):** `V4_POOL_ID`, `V4_TOKEN0`, `V4_TOKEN1`, `V4_TICK_LOWER`, `V4_TICK_UPPER` and optional `V4_TOKEN1_SYMBOL` (the symbol of the **stable** token, whichever currency it is; default `STABLE`). Current values are the `workerVars` of `packages/contracts/deployments/v4-pool-mUSDG-46630.json`: `V4_POOL_ID=0xafede3281589f6c8d26792dc3bd81603bb9ccc5ea77ce2dd97f70dbcaf5d5a54`, `V4_TOKEN0=0x0B71c1B397A9d33198e0A6a5701E12011AC84D95` (mUSDG), `V4_TOKEN1=0x8875C482eC20c82bE0f62c16d6F94B92a6050a2A` (tIP16P), `V4_TICK_LOWER=-28080`, `V4_TICK_UPPER=-19860`, `V4_TOKEN1_SYMBOL=mUSDG`; a test (`worker/test/v4pool.test.ts`) keeps `wrangler.jsonc` and that file equal. With none set, the compiled-in default is the retired tIP16P / mUSDC pool. They are used only as a complete, valid set: ids `0x` + 64 hex, addresses `0x` + 40 hex sorted `token0 < token1` with tIP16P on one side, ticks integers that are multiples of 60 with lower < upper, and `V4_POOL_ID` equal to `keccak256(abi.encode(token0, token1, 3000, 60, 0x0))`. Anything else falls back to the defaults as a whole and logs `v4pool_vars_invalid` (values are not logged). Config: `apps/web/worker/v4/pool.ts` (`DEFAULT_POOL`, `resolvePoolConfig`).
- **What it calls:** three JSON-RPC requests in parallel, 8 s timeout: `eth_blockNumber` and two `eth_call`s of `PoolManager.extsload(bytes32)` (slot0, then active liquidity at slot + 3).
- **Cache:** a successful body is stored in KV key `v4pool:v2:<poolId>` with `fetchedAtMs` (the pool id is in the key, so re-pointing the pool never serves the old pool's body); an entry younger than 30 s is served without calling the RPC (KV needs a TTL of at least 60 s, so older entries are simply treated as stale).
- **Response (HTTP 200):**

```json
{
  "mode": "REAL",
  "chainId": 46630,
  "poolManager": "0x8366a39CC670B4001A1121B8F6A443A643e40951",
  "poolId": "0xafede328...5d5a54",
  "token0": { "address": "0x0B71c1B3...84D95", "symbol": "mUSDG", "decimals": 6 },
  "token1": { "address": "0x8875C482...50a2A", "symbol": "tIP16P", "decimals": 6 },
  "stableSymbol": "mUSDG", "unitSymbol": "tIP16P", "roles": { "unit": "token1", "stable": "token0" },
  "fee": 3000, "tickSpacing": 60, "hooks": null,
  "tick": -23972, "sqrtPriceX96": "23899055485173685887908959771",
  "priceMusdcPerUnit": "10.990000", "priceStablePerUnit": "10.990000", "liquidity": "17851181514",
  "tickLower": -28080, "tickUpper": -19860, "inRange": true,
  "blockNumber": 128237488, "updatedAt": "2026-10-03T15:03:47.595Z",
  "note": "Secondary reference venue for a test token pair. Not a hook and not the sealed-bid market.",
  "explorer": { "poolManager": "https://explorer.testnet.chain.robinhood.com/address/0x8366...", "token0": "...", "token1": "..." }
}
```

- **Degraded:** if the RPC fails, times out or answers something unreadable, the route still returns HTTP 200 with `"mode": "DEGRADED"`, the chain fields (`tick`, `sqrtPriceX96`, `priceMusdcPerUnit`, `liquidity`, `inRange`, `blockNumber`) set to `null` and `"error": { "code": "RPC_UNAVAILABLE" | "RPC_BAD_RESPONSE" | "POOL_NOT_INITIALIZED" }`. Upstream text is never returned or logged, and a degraded body is never cached.
- **Price:** `priceStablePerUnit` (and, under its old name, `priceMusdcPerUnit`, same value) is always stable per unit, computed with BigInt (no floating point) and rounded half up to 6 decimals: `(sqrtPriceX96 / 2^96)^2` when the unit token is currency0, `(2^96 / sqrtPriceX96)^2` when the stable token is currency0. `inRange` is `tickLower <= tick < tickUpper`.
- **Check:** `curl -s $BASE/api/v4/pool` should read `"mode":"REAL"`. The Integrations page shows the same read as the row "Uniswap v4 pool (test token pair)", with the stable symbol from `stableSymbol`.
- **Re-pool for a new stable token:** run the one-command re-pool (`packages/contracts/script/RePoolV4.s.sol`; exact command and checks in `docs/v4-pool.md`, "Re-pool for a new stable token"):

```sh
cd packages/contracts && STABLE_TOKEN=<new stable address> forge script script/RePoolV4.s.sol:RePoolV4 --evm-version cancun --out out/cancun --cache-path cache/cancun --rpc-url https://rpc.testnet.chain.robinhood.com --account <keystore-name> --sender 0x6129C88CE91ACdf5c1E42188B1aF88C2166a5501 --broadcast --slow
```

  (This is how the mUSDG pool was created; its six transactions are listed in `packages/contracts/deployments/v4-pool-mUSDG-46630.json`.) Then copy `workerVars` from `packages/contracts/deployments/v4-pool-<SYMBOL>-46630.json` into `wrangler.jsonc` `vars` (`V4_POOL_ID`, `V4_TOKEN0`, `V4_TOKEN1`, `V4_TICK_LOWER`, `V4_TICK_UPPER`, `V4_TOKEN1_SYMBOL`), run `npm run check:worker && npm run test:worker`, deploy, and check that `curl -s $BASE/api/v4/pool` reads `"mode":"REAL"` with the new `poolId` and `stableSymbol`. To go back, remove the six vars and deploy: the route reads the retired tIP16P / mUSDC pool again (the compiled-in default).

## 7. Rollback

- **Worker:** `npx wrangler rollback`. This restores the previous version; static assets roll back with it. Note that the previous version may be the assets-only deploy, which has no `/api/*`: the UI then shows API OFFLINE, which is the intended honest state. After the market cache (section 9) a plain rollback also needs the cron fix described there.
- **Credentials:**
  - Revoke Google access with `npx wrangler secret delete GOOGLE_SA_JSON`, or remove the service account from Merchant Center.
  - Rotate `ADMIN_TOKEN` with `npx wrangler secret put ADMIN_TOKEN`.

## 8. Error codes → action

| Code | Meaning | Action |
|---|---|---|
| `MERCHANT_NOT_REGISTERED` | GCP project not registered | §3 `--register`, wait 5 minutes |
| `MERCHANT_UNAUTHORIZED` | Bad SA key, or SA not Admin in Merchant Center | Re-upload `GOOGLE_SA_JSON`; check People and access |
| `MERCHANT_INVALID_PRODUCT` | Google rejected the payload (message included) | Fix the attribute named in the message |
| `MERCHANT_QUOTA` | Merchant API quota | Retry later |
| `UNAUTHORIZED` (401) | Live publish or delete without a valid `x-admin-token` | Send the token; dry runs need none |
| `LINK_NOT_IN_MANIFEST` | link/image/price do not match a built `/p/<sku>/` page | Rebuild and deploy, or use the page's exact price and PNG |
| `NOT_CONFIGURED` | Missing secrets (names listed) | §2 |
| `FEED_UPSTREAM` / `quota_exhausted` | Source failed or over budget | Compare still answers; check the key or raise `QUOTA_*_DAILY` |
| `refresh_requires_operator` | A paid source (SerpApi) was asked for by a visitor without a valid `x-admin-token` and nothing is cached | Not a failure. The cron warm-up refreshes the hero SKU; send `x-admin-token` to refresh another SKU. §6a |
| `quota_unavailable` | KV could not read or write a quota counter, so the source failed closed | Check the KV namespace; no live call was made. Never triggers the SearchApi.io backup |
| `FEED_UPSTREAM` on `searchapi` ("bad response") | SearchApi.io answered 200 with neither `shopping_results` nor an `error` (for example "Processing") | Nothing is cached; retry later |
| `RATE_LIMITED` | Rate-limit binding | Wait 60 s |

## 9. Market snapshot (every-minute ingest and `GET /api/market/snapshot`)

The single cron trigger is `* * * * *` (before the market cache it was `*/15 * * * *`; the Free plan allows 5 Cron Triggers per account and the account is shared, so this is the only one). Minutes 0, 15, 30 and 45 (UTC) run the reconcile/warm/purge job above (log `event:"cron"`) and nothing else; every other minute runs the market ingest (log `event:"market_ingest"`). One task per invocation, so each keeps its own subrequest budget and a failure in one never skips the other. The ingest reads public BlindBook logs from `MARKET_RPC_URL` (a plain var, no secret) into D1 tables `mk_meta`, `mk_epochs`, `mk_snapshot` (migration `0002_market.sql`). The vars `MARKET_RPC_URL`, `MARKET_BOOK`, `MARKET_CHAIN_ID`, `MARKET_DEPLOY_BLOCK` live in `wrangler.jsonc`; a test fails if the last three drift from `apps/web/src/data/blindbook.json`.

- **Deploy order (first deploy of the market cache):**
  1. Apply migration `0002_market.sql` to the remote D1 BEFORE deploying the Worker: `npx wrangler d1 migrations list robinize --remote`, then `npx wrangler d1 migrations apply robinize --remote`. The migration is additive (three new tables), so the old Worker keeps running against it.
  2. Regenerate the baked history right before the build (`cd apps/web && node --env-file=../../.env tools/market-snapshot.ts`), so the page's fallback is as fresh as possible, then `npm run build` and deploy.
  3. Expected timeline after the deploy: for about the first minute `GET /api/market/snapshot` answers `503 SNAPSHOT_UNAVAILABLE` (no ingest has run yet); then `200` with `"complete":false` while the cron catches up from `MARKET_DEPLOY_BLOCK` (up to 8,000 blocks per run, about 10 runs); then `"complete":true`. Meanwhile the page uses the baked history plus the chain.
  4. Record after the deploy (Workers observability / the D1 dashboard): `cpuTime` per `market_ingest` invocation (budget: well under the Free plan's 10 ms) and the D1 rows read and rows written per run and per day (budget in the line at the end of this list).
- **Rollback of the Worker:** Cron Triggers are not part of a Worker version. `npx wrangler rollback` alone therefore keeps the `* * * * *` trigger, while the old code ignores the cron string and runs the full reconcile job every minute (15 times the Merchant and KV calls). Roll back by redeploying the previous `origin/main` commit with `npx wrangler deploy` (this restores `*/15 * * * *`), or run `npx wrangler triggers deploy` right after a `wrangler rollback`. Migration `0002_market.sql` is additive and may stay applied.
- **Check:** `curl -s https://skudesk.lol/api/market/snapshot | head -c 300` shows `"complete":true` and a `cursor` within ~2,400 blocks of the chain head; run `curl -s -D- -o /dev/null …/api/market/snapshot` twice (a HEAD request answers 405): a `cf-cache-status: HIT` on the second call means the Workers Cache works. The Cache API is only functional on custom domains, so on `*.workers.dev` no HIT may ever appear; then every request costs 2 D1 statements (1 for a 304) and is bounded by the read rate limit. The request log's `cache` field (`hit`/`miss`) shows the same.
- **Healthy logs:** `market_ingest` lines have `level:"info"` and no `code`; `calls` ≤ 6; `reason` is `caught_up`, `partial` (still catching up), `busy` (the previous run still holds the lease: normal, not an error) or empty; `reorg:true` is rare and self-healing. Lines carry only short codes and numbers, never upstream text.
- **Reset (re-ingest from the deploy block):** change `MARKET_DEPLOY_BLOCK` or bump `SCHEMA_VERSION` in `worker/market/ingest.ts` and deploy; the next run clears the three tables.
- **Turn the snapshot off without a rollback:** deploy with `MARKET_RPC_URL` set to `""`: the ingest logs `reason:"not_configured"`, the route keeps serving the last parts until they go stale (`complete:false` after 10 minutes), and the page falls back to the chain.
- **Budgets (Free plan):** ≤ 6 subrequests, ≤ ~14 D1 queries and ≤ 1,200 decoded logs per run; no KV writes from market code.

| Code | Meaning | Action |
|---|---|---|
| `SNAPSHOT_UNAVAILABLE` (503, `Retry-After`) | No meta row, no schedule yet, parts torn, or the cursor is still before the deploy block | Wait for the next cron minutes; check `market_ingest` logs |
| `market_ingest` `code: RPC_*` (`level:"error"`) | The public RPC failed (`RPC_UNREACHABLE`, `RPC_HTTP_429`, `RPC_ERROR`, …) | Nothing written; retried next minute. Persisting: switch `MARKET_RPC_URL` |
| `market_ingest` `reason: rpc_behind` | The RPC node does not have our anchor block yet | Self-heals |
| `market_ingest` `fatal:true`, `code: INTERNAL` | The ingest threw outside its own handling | Retried next minute; the reconcile job is unaffected |
