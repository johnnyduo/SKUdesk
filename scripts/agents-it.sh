#!/usr/bin/env bash
# Throwaway local chain: install the real EntryPoint v0.7 runtime code (copied from chain 46630), deploy vault stack + factory, run the 4337 proof.
# The proof tool exits non-zero if any honest op fails or any attack is accepted.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$ROOT"
set -a; . ./.env; set +a; unset KEEPER_GATE_URL
PORT=${AGENTS_PORT:-8611}; RPC=http://127.0.0.1:$PORT
anvil --chain-id 31337 --port $PORT --silent & AP=$!
trap 'kill $AP 2>/dev/null; rm -f packages/contracts/deployments/31337.json packages/contracts/deployments/agents-31337.json' EXIT
sleep 2
J=$(cast wallet new --json); DK=$(echo "$J" | python3 -c 'import sys,json;print(json.load(sys.stdin)[0]["private_key"])'); DA=$(echo "$J" | python3 -c 'import sys,json;print(json.load(sys.stdin)[0]["address"])')
cast rpc anvil_setBalance "$DA" 0x56BC75E2D63100000 --rpc-url $RPC >/dev/null
cast rpc anvil_setBalance "$AGENT_ADDRESS" 0x56BC75E2D63100000 --rpc-url $RPC >/dev/null
cast rpc anvil_setCode 0x0000000071727De22E5E9d8BAf0edAc6f37da032 "$(cat packages/contracts/test/fixtures/entrypoint-v0.7.hex)" --rpc-url $RPC >/dev/null
( cd packages/contracts && DEPLOYER_PRIVATE_KEY=$DK forge script script/Deploy.s.sol --rpc-url $RPC --broadcast 2>&1 | grep -E "ONCHAIN EXECUTION COMPLETE|Error" )
( cd packages/contracts && DEPLOYER_PRIVATE_KEY=$DK forge script script/DeployAgents.s.sol --rpc-url $RPC --broadcast 2>&1 | grep -E "ONCHAIN EXECUTION COMPLETE|Error|AgentFactory" )
( cd apps/web && DEPLOYER_PRIVATE_KEY=$DK node tools/agent-4337.ts --rpc $RPC --chain 31337 --out /tmp/agent4337-local.json )
