#!/usr/bin/env bash
# Market integration test on a throwaway local chain (31337, never the real 46630):
# deploy vault + BlindBook (short epochs), set up 6 bots, run the real keeper for N epochs, then re-derive every
# cleared epoch independently with the TypeScript mirror and check conservation. EPOCHS=5 by default.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$ROOT"; set -a; . ./.env; set +a; unset KEEPER_GATE_URL
PORT=${MARKET_PORT:-8596}; RPC=http://127.0.0.1:$PORT; EPOCHS="${EPOCHS:-5}"
anvil --chain-id 31337 --port $PORT --silent & APID=$!
cleanup() { kill $APID 2>/dev/null || true; rm -f packages/contracts/deployments/31337.json packages/contracts/deployments/blindbook-31337.json; rm -rf packages/contracts/broadcast/Deploy.s.sol/31337 packages/contracts/broadcast/DeployBook.s.sol/31337 packages/contracts/cache/Deploy.s.sol/31337 packages/contracts/cache/DeployBook.s.sol/31337; }
trap cleanup EXIT; sleep 2
J=$(cast wallet new --json); DK=$(echo "$J" | python3 -c 'import sys,json;print(json.load(sys.stdin)[0]["private_key"])'); DA=$(echo "$J" | python3 -c 'import sys,json;print(json.load(sys.stdin)[0]["address"])')
cast rpc anvil_setBalance "$DA" 0x56BC75E2D63100000 --rpc-url $RPC >/dev/null
BOTS=$(for i in 1 2 3 4 5 6; do cast wallet new --json | python3 -c 'import sys,json;print(json.load(sys.stdin)[0]["private_key"])'; done | paste -sd, -)
echo "== deploy (chain 31337, epochs 15s)"
( cd packages/contracts && DEPLOYER_PRIVATE_KEY=$DK forge script script/Deploy.s.sol --rpc-url $RPC --broadcast 2>&1 | grep -E "ONCHAIN EXECUTION COMPLETE"
  DEPLOYER_PRIVATE_KEY=$DK EPOCH_LEN=15 COMMIT_END=6 REVEAL_END=11 BOND=2000000 forge script script/DeployBook.s.sol --rpc-url $RPC --broadcast 2>&1 | grep -E "ONCHAIN EXECUTION COMPLETE|Error" )
cd apps/web
export DEPLOYER_PRIVATE_KEY=$DK ROBINHOOD_RPC=$RPC BOT_PRIVATE_KEYS=$BOTS
echo "== setup bots"; node tools/market-setup.ts --chain 31337 --eth 1 2>&1 | grep -v -E "Warning|Reparsing|eliminate|trace-warnings" | tail -8
echo "== keeper, $EPOCHS epochs"; node tools/keeper.ts --chain 31337 --epochs $EPOCHS --markets 3 2>&1 | grep -v -E "Warning|Reparsing|eliminate|trace-warnings" | tee /tmp/keeper-it.log | tail -40
grep -qE "FAILED|crashed|problem" /tmp/keeper-it.log && { echo "FAIL: keeper reported problems"; exit 1; } || echo "keeper reported no failed transactions"
echo "== independent verification"; node tools/market-verify.ts --chain 31337 --min-cleared $((EPOCHS * 2)) --min-traded $EPOCHS
