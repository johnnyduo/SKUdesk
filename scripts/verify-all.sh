#!/usr/bin/env bash
# Full verification loop. Every stage must pass or the script exits non-zero.
#   1. Foundry tests (unit, fuzz, invariants)
#   2. TypeScript unit tests, then the Worker, site and built-page tests and the type checks
#   3. Web build (private output dir)
#   4. Fresh local chain: deploy -> real agent run (Gemini) -> assert the run's results
#   5. Market integration: BlindBook + keeper on a local chain, every clear re-derived with the TypeScript mirror
#   6. Agent factory + ERC-4337 account on a local chain with the real EntryPoint code, attacks refused
#   7. Browser checks of every route against the built site, the story navigation, the on-chain simulator
#   8. Wallet + Owner console e2e (testnet, real transactions; SKIP_WALLET=1 skips stages 8 and 9)
#   9. Deploy-your-agent e2e (testnet, real transactions)
#  10. Market terminal in a real browser, then the per-asset probe over every catalog market (read-only; SKIP_MARKET_UI=1 skips both)
# Skips: SKIP_AGENT=1 (stages 4 and 5), SKIP_MARKET=1 (stage 5), SKIP_WALLET=1, SKIP_MARKET_UI=1. A run with skips ends with 'PASSED WITH SKIPS' so it is never mistaken for a full pass.
# Ports are overridable (PORT_ANVIL, PORT_WEB, MARKET_PORT, AGENTS_PORT) and a busy port is refused, so two runs cannot test each other's servers. Stage 8 uses a mock browser wallet that signs REAL transactions on Robinhood testnet (reversible; SKIP_WALLET=1 to skip)
# Needs: forge/anvil/cast, node >= 22, a funded .env (GEMINI_API_KEY, AGENT_PRIVATE_KEY, AGENT_ADDRESS).
# Stage 4 uses the real Gemini API (one short call). Set SKIP_AGENT=1 to skip it.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$ROOT"
PORT_ANVIL=${PORT_ANVIL:-8598}; PORT_WEB=${PORT_WEB:-4394}   # override when these ports are taken
DIST="${VERIFY_DIST:-/tmp/robinize-verify-dist}"   # private build output, so a concurrent build of apps/web/dist cannot corrupt it
SKIPPED=""
need_free() { if (echo > /dev/tcp/127.0.0.1/$1) 2>/dev/null; then echo "FAIL: port $1 is already in use (set PORT_ANVIL / PORT_WEB / MARKET_PORT / AGENTS_PORT)"; exit 1; fi; }
step() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
cleanup() { [ -n "${ANVIL_PID:-}" ] && kill "$ANVIL_PID" 2>/dev/null || true; [ -n "${WEB_PID:-}" ] && kill "$WEB_PID" 2>/dev/null || true; rm -f packages/contracts/deployments/31337.json packages/contracts/deployments/blindbook-31337.json packages/contracts/deployments/agents-31337.json; rm -rf packages/contracts/broadcast/Deploy.s.sol/31337 packages/contracts/cache/Deploy.s.sol/31337; }
trap cleanup EXIT

step "1/10 Foundry tests"
( cd packages/contracts && forge test 2>&1 | tee /tmp/verify-forge.log | tail -3 )
grep -q " 0 failed" /tmp/verify-forge.log || { echo "FAIL: forge tests"; exit 1; }

step "2/10 TypeScript tests"
node --test packages/matching/test/gates.test.ts packages/economics/test/econ.test.ts apps/web/src/lib/wallet.test.ts apps/web/src/lib/book.test.ts apps/web/src/lib/products.test.ts apps/web/src/components/wallet/parse.test.ts packages/economics/test/proofs.econ.test.ts apps/web/src/lib/proofs.book.test.ts apps/web/src/lib/agent-form.test.ts apps/web/src/lib/journey.test.ts apps/web/src/lib/market-chart.test.ts 2>&1 | tee /tmp/verify-node.log | grep -E "^ℹ (tests|pass|fail)"
grep -q "ℹ fail 0" /tmp/verify-node.log || { echo "FAIL: node tests"; exit 1; }
# the Worker, site and type-check suites live behind npm scripts
( cd apps/web && npm run test >/tmp/verify-web-unit.log 2>&1 && npm run test:worker >/tmp/verify-worker.log 2>&1 && npm run test:site >/tmp/verify-site.log 2>&1 && npm run check:site >/dev/null 2>&1 && npm run check:worker >/dev/null 2>&1 ) || { echo "FAIL: web unit, Worker, site or type-check suite (see /tmp/verify-web-unit.log, /tmp/verify-worker.log, /tmp/verify-site.log)"; exit 1; }
echo "web unit, Worker ($(grep -E '^ℹ pass' /tmp/verify-worker.log | tr -d 'ℹ ')), site and type checks passed"

step "3/10 Web build"
rm -rf "$DIST"; ( cd apps/web && npx astro build --outDir "$DIST" 2>&1 | tee /tmp/verify-build.log | grep -E "page\(s\) built" )
grep -q "Complete" /tmp/verify-build.log || { echo "FAIL: build"; exit 1; }
( cd apps/web && cp public/_headers "$DIST/_headers" 2>/dev/null; node scripts/copy-lint.mjs "$DIST/index.html" ) || { echo "FAIL: landing copy lint"; exit 1; }
( cd apps/web && DIST_DIR="$DIST" npm run test:built >/tmp/verify-built.log 2>&1 ) || { echo "FAIL: built-page tests (see /tmp/verify-built.log)"; exit 1; }
echo "built-page tests passed ($(grep -E '^ℹ pass' /tmp/verify-built.log | tr -d 'ℹ '))"

if [ "${SKIP_AGENT:-0}" != "1" ]; then
  step "4/10 Fresh chain: deploy, run the real agent, assert results"
  set -a; . ./.env; set +a; unset KEEPER_GATE_URL   # a local-chain keeper must never be gated on the live site
  need_free $PORT_ANVIL; anvil --chain-id 31337 --port $PORT_ANVIL --silent & ANVIL_PID=$!; for i in $(seq 1 20); do cast block-number --rpc-url http://127.0.0.1:$PORT_ANVIL >/dev/null 2>&1 && break; sleep 0.5; done
  RPC=http://127.0.0.1:$PORT_ANVIL
  J=$(cast wallet new --json); DK=$(echo "$J" | python3 -c 'import sys,json;print(json.load(sys.stdin)[0]["private_key"])'); DA=$(echo "$J" | python3 -c 'import sys,json;print(json.load(sys.stdin)[0]["address"])')
  for a in "$DA" "$AGENT_ADDRESS"; do cast rpc anvil_setBalance "$a" 0x56BC75E2D63100000 --rpc-url $RPC >/dev/null; done
  ( cd packages/contracts && DEPLOYER_PRIVATE_KEY=$DK forge script script/Deploy.s.sol --rpc-url $RPC --broadcast 2>&1 | grep -E "ONCHAIN EXECUTION COMPLETE" )
  ( cd apps/web && node --env-file=../../.env tools/run-agent.ts --rpc $RPC --chain 31337 --out /tmp/verify-run.json 2>&1 | grep -E "RUN FAILED|wrote" )
  python3 - <<'PY'
import json
r = json.load(open('/tmp/verify-run.json'))
errs = [a['error'] for a in r['attacks']]
want = ['MathMismatch','SpendCap','Replay','Stale','BadQuoteHash','PayeeNotAllowed']
assert errs == want, f"attack errors {errs} != {want}"
txs = [e['tx'] for e in r['events'] if e.get('tx')]
assert sum(t['status']=='success' for t in txs) == 8 and sum(t['status']=='reverted' for t in txs) == 1, "tx statuses"
econ = [e for e in r['events'] if e['kind']=='econ'][0]['data']
realized = (int(r['end']['totalProceeds']) - int(r['end']['totalPaidOut'])) // 10000
assert realized == econ['netCents'] * econ['units'], f"realized {realized} != verified {econ['netCents']*econ['units']}"
total = int(r['end']['free']) + int(r['end']['totalEscrow']) + int(r['end']['totalPaidOut'])
print(f"agent run OK: 6/6 attacks blocked with expected errors, 8 ok + 1 reverted tx, realized {realized}c == verified net, vault totals ({total})")
PY
else
  step "4/10 skipped (SKIP_AGENT=1)"; SKIPPED="$SKIPPED 4"
fi

if [ "${SKIP_MARKET:-0}" != "1" ] && [ "${SKIP_AGENT:-0}" != "1" ]; then
  step "5/10 Market integration: BlindBook + real keeper on a throwaway local chain, independently re-derived"
  EPOCHS=3 bash scripts/market-it.sh 2>&1 | grep -v -E "gas 0\.99|gas left|Warning|Reparsing" | tail -14
  [ "${PIPESTATUS[0]}" = "0" ] || { echo "FAIL: market integration"; exit 1; }
else
  step "5/10 skipped (SKIP_MARKET=1 or SKIP_AGENT=1)"; SKIPPED="$SKIPPED 5"
fi

step "6/10 Agent factory: locked ERC-4337 account, identity NFT and attacks on a throwaway chain with the real EntryPoint v0.7 code"
bash scripts/agents-it.sh 2>&1 | grep -E "created agent|honest commit|refused|wrote|RUN FAILED|Error" | cut -c1-200
[ "${PIPESTATUS[0]}" = "0" ] || { echo "FAIL: agent factory integration"; exit 1; }

step "7/10 Browser checks of the built site"
# a Node server on purpose: Python's http.server resets connections under the burst of ~30 parallel asset requests and made the checks flaky
need_free $PORT_WEB; node scripts/static-server.cjs "$DIST" $PORT_WEB >/tmp/verify-web.log 2>&1 & WEB_PID=$!
for i in $(seq 1 25); do [ "$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:$PORT_WEB/app/)" = "200" ] && break; sleep 1; done
node scripts/e2e-browser.cjs "http://127.0.0.1:$PORT_WEB"
node scripts/e2e-journey.cjs "http://127.0.0.1:$PORT_WEB"

if [ "${SKIP_WALLET:-0}" != "1" ]; then
  step "8/10 Wallet + Owner console against the real contracts (mock browser wallet signs with the real owner/agent keys)"
  node --env-file=.env scripts/e2e-wallet.cjs "http://127.0.0.1:$PORT_WEB"
else
  step "8/10 skipped (SKIP_WALLET=1)"; SKIPPED="$SKIPPED 8"
fi
if [ "${SKIP_WALLET:-0}" != "1" ]; then
  step "9/10 Deploy your agent in a real browser: faucet, create, fund, pause, and the new agent's key signs real UserOperations (testnet)"
  node --env-file=.env scripts/e2e-create.cjs "http://127.0.0.1:$PORT_WEB"
else
  step "9/10 skipped (SKIP_WALLET=1)"; SKIPPED="$SKIPPED 9"
fi
if [ "${SKIP_MARKET_UI:-0}" != "1" ] && [ -f scripts/e2e-market.cjs ]; then
  step "10/10 Market terminal in a real browser against the live deployment"
  node scripts/e2e-market.cjs "http://127.0.0.1:$PORT_WEB"
  node scripts/probe-assets.cjs "http://127.0.0.1:$PORT_WEB"   # every catalog market through the asset switcher (read-only, about 2.5 min)
else
  step "10/10 skipped (SKIP_MARKET_UI=1)"; SKIPPED="$SKIPPED 10"
fi
if [ -n "$SKIPPED" ]; then printf '\n\033[1;33mPASSED WITH SKIPS (stages:%s)\033[0m\n' "$SKIPPED"; else printf '\n\033[1;32mALL STAGES PASSED\033[0m\n'; fi
