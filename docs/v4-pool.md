# Uniswap v4 reference pool (tIP16P / mUSDG)

This file describes the **current** pool, mUSDG / tIP16P (pool id `0xafede328...5d5a54`). The earlier tIP16P / mUSDC pool
(pool id `0xb18fd8f2...e3bb`, old test token mUSDC `0xee1a9ef855AF50eAd6a3E62974EAd4d85A9465b8`) was **retired when the
settlement token was replaced**. It still exists on chain with its liquidity, but the UI, the Worker and this document
no longer point at it; its deployment record stays in `packages/contracts/deployments/v4-46630.json`.

## What it is

A standard Uniswap v4 pool on Robinhood Chain Testnet (chain id 46630), created on the Uniswap v4
PoolManager already deployed on that chain. It pairs two test tokens:

- **tIP16P**: "SKUdesk test unit (IP16P-CLR)", a new ERC-20 test token (6 decimals, owner-only mint) that stands
  for units of the hero product (iPhone 16 Pro clear MagSafe case).
- **mUSDG**: "Test USDG (testnet stand-in)", the project's test settlement token (6 decimals, owner-only mint, test
  token, no value). It is a stand-in, not the real USDG.

The pool opened at 10.99 mUSDG per unit, inside BlindBook's recent clearing range (10.98 to 11.16 over epochs
1775 to 1783 just before deploy); the two prices are not linked. It serves as a **secondary reference venue**:
anyone can read a continuous price for the units and trade against it.

The Uniswap v4 code is not rewritten: all 22 vendored v4-core files are byte-identical to upstream at commit
`46c6834698c48bc4a463a86d8420f4eb1d7f3b75` (MIT), and the three contracts are source-verified on the explorer.

What it is **not**:

- It is **not a hook**. The pool uses `hooks = address(0)`, so plain Uniswap v4 logic runs and nothing else.
- It is **not the sealed-bid market**. BlindBook (commit/reveal, uniform-price batch clearing) remains the primary
  market. Nothing connects the two automatically: there is no oracle feed, no arbitrage keeper and no price sync.
- **tIP16P has no value and carries no claim on goods.** Holding it does not entitle anyone to a product,
  delivery, refund or payment. mUSDG is a test token with no value either.

## Addresses (Robinhood Chain Testnet, 46630)

| Item | Value |
| --- | --- |
| PoolManager (Uniswap v4) | `0x8366a39CC670B4001A1121B8F6A443A643e40951` |
| mUSDG (currency0, the stable token) | `0x0B71c1B397A9d33198e0A6a5701E12011AC84D95` |
| tIP16P (currency1, the unit token) | `0x8875C482eC20c82bE0f62c16d6F94B92a6050a2A` |
| V4LiquidityHelper | `0xF0BDaC9d6A849992D5825ad20A73E6bf1B47e3D4` |
| V4SwapHelper | `0xFAbd4D06F31Fc3d5E19b360fFC9A2135645D3Bcb` |
| Pool id | `0xafede3281589f6c8d26792dc3bd81603bb9ccc5ea77ce2dd97f70dbcaf5d5a54` |

The tIP16P token and the two helpers were verified on the explorer (https://explorer.testnet.chain.robinhood.com).
Deployment data of the helpers: `packages/contracts/deployments/v4-46630.json`. Data of the current pool, including the six
re-pool transactions (hash and block each): `packages/contracts/deployments/v4-pool-mUSDG-46630.json`
(initialize in block 128236851 through the seed position in block 128236900).

## Pool parameters

- Pool key: `(currency0 = mUSDG, currency1 = tIP16P, fee = 3000, tickSpacing = 60, hooks = 0x0)`.
  Currencies are sorted by address, as Uniswap v4 requires; here the stable token mUSDG has the lower address, so the
  raw pool price (currency1 per currency0) is units per mUSDG, and "mUSDG per unit" is its inverse.
- Fee: 0.30% (3000 pips) to liquidity providers. The PoolManager has no protocol fee controller set, so the protocol
  fee is 0.
- Start price: 10.99 mUSDG per unit. Both tokens have 6 decimals, so the raw price is the plain ratio, and with the
  unit token as currency1 the pool tick is negative:
  `sqrtPriceX96 = floor(sqrt(100 * 2^192 / 1099)) = 23899055485173685887908959771` (start tick -23972).
- Liquidity range: ticks -28080 to -19860, about 7.29 to 16.57 mUSDG per unit. That is the start tick plus or minus
  4055 ticks (ln 1.5 / ln 1.0001), so price / 1.5 to price x 1.5, widened outwards to multiples of 60.
  Because the range is symmetric in ticks, the seed holds about equal value on both sides.
- Seed position: liquidity 17,851,181,514, funded with 1,000 tIP16P and 10,995.088966 mUSDG. Read back from the chain
  after the broadcast: slot0 and active liquidity match these values.
  It is held by V4LiquidityHelper inside the PoolManager under the deployer's salt (see below).

## Reading price and liquidity with cast

The PoolManager exposes its storage through `extsload(bytes32)`. In v4-core, `_pools` is at storage slot 6
(`StateLibrary.POOLS_SLOT`), so the pool's state starts at `keccak256(abi.encode(poolId, uint256(6)))`:
slot0 at offset 0, active liquidity at offset 3.

```sh
RPC=https://rpc.testnet.chain.robinhood.com
PM=0x8366a39CC670B4001A1121B8F6A443A643e40951
POOL_ID=0xafede3281589f6c8d26792dc3bd81603bb9ccc5ea77ce2dd97f70dbcaf5d5a54
STATE=$(cast keccak $(cast abi-encode 'f(bytes32,uint256)' $POOL_ID 6))   # 0x2c06a2b6...ce75

# slot0: bits 0-159 sqrtPriceX96, 160-183 tick (signed), 184-207 protocol fee, 208-231 LP fee
cast call $PM 'extsload(bytes32)(bytes32)' $STATE -r $RPC

# active liquidity (uint128) at STATE + 3 (256-bit addition, so use python rather than shell arithmetic)
cast call $PM 'extsload(bytes32)(bytes32)' $(python3 -c "print(hex(int('$STATE',16)+3))") -r $RPC
```

The raw price is token1 per token0 = `(sqrtPriceX96 / 2^96)^2`. Here token0 is the stable token, so mUSDG per unit is
its inverse, `(2^96 / sqrtPriceX96)^2`. Right after the seed, slot0 read back as
`sqrtPriceX96 = 23899055485173685887908959771`, tick -23972, protocol fee 0, LP fee 3000 (price 10.99 mUSDG per
unit), and active liquidity 17,851,181,514.

The pool id itself is `keccak256(abi.encode(poolKey))`:

```sh
cast keccak $(cast abi-encode 'f((address,address,uint24,int24,address))' \
  "(0x0B71c1B397A9d33198e0A6a5701E12011AC84D95,0x8875C482eC20c82bE0f62c16d6F94B92a6050a2A,3000,60,0x0000000000000000000000000000000000000000)")
```

## Read it through the API

The site's Worker exposes the same read as JSON, so a page or a script does not need an RPC client:

```sh
curl -s https://skudesk.lol/api/v4/pool
```

The answer carries `priceMusdcPerUnit` (decimal string, 6 places; the name is kept for compatibility, the value is
stable per unit and equals `priceStablePerUnit`), `stableSymbol` (`mUSDG`), `tick`, `sqrtPriceX96`, `liquidity`, `inRange`
(tick inside -28080 to -19860), `blockNumber`, `updatedAt` and explorer links. It reads `"mode": "REAL"` when the chain
answered and `"mode": "DEGRADED"` (with an error code and null chain fields) when it did not. The Worker caches a
good answer for 30 seconds. The route is read-only: it sends no transaction. Details and the response shape are in
`docs/runbooks/worker-backend.md` (section 6c).

## Swapping on testnet

Any address with testnet ETH for gas can trade against the pool through V4SwapHelper:

```sh
RPC=https://rpc.testnet.chain.robinhood.com
USD=0x0B71c1B397A9d33198e0A6a5701E12011AC84D95
UNIT=0x8875C482eC20c82bE0f62c16d6F94B92a6050a2A
SWAP=0xFAbd4D06F31Fc3d5E19b360fFC9A2135645D3Bcb
KEY="($USD,$UNIT,3000,60,0x0000000000000000000000000000000000000000)"

# Signing: --account <keystore-name> uses a keystore made with `cast wallet import`; --interactive prompts for the
# key instead. Do not pass --private-key on the command line: it lands in shell history and the process list.

# 1. get some mUSDG. mUSDG has an owner-only mint (it is a test token), and the faucet that was deployed for the earlier
#    mUSDC token does not drip it, so ask the project owner to mint a few hundred to your address.

# 2. allow the swap helper to pull 100 mUSDG
cast send $USD 'approve(address,uint256)' $SWAP 100000000 -r $RPC --account <keystore-name>

# 3. buy units with 100 mUSDG (zeroForOne = true: pay currency0 = mUSDG, receive currency1 = tIP16P); minimum out 8 units
cast send $SWAP 'swapExactIn((address,address,uint24,int24,address),bool,uint256,uint256)' \
  "$KEY" true 100000000 8000000 -r $RPC --account <keystore-name>

# 4. optional: sell the units back (zeroForOne = false: pay tIP16P, receive mUSDG)
cast send $UNIT 'approve(address,uint256)' $SWAP 9000000 -r $RPC --account <keystore-name>
cast send $SWAP 'swapExactIn((address,address,uint24,int24,address),bool,uint256,uint256)' \
  "$KEY" false 9000000 90000000 -r $RPC --account <keystore-name>
```

After the approval, you can preview a swap's output with `cast call` instead of `cast send` (same arguments, plus `--from <your address>`).
`swapExactIn` reverts with `InsufficientOutput` if the output is below the minimum you pass.

## The helpers

Both helpers follow the standard v4 flash-accounting pattern: the caller calls the helper, the helper calls
`PoolManager.unlock`, the PoolManager calls back `unlockCallback`, the helper runs `modifyLiquidity` or `swap`,
then settles every currency delta before the unlock ends:

- a debt is paid straight from the caller to the PoolManager (`sync`, `transferFrom(caller, PoolManager, amount)`,
  `settle`);
- a credit is sent straight to the caller (`take`).

The helpers never hold tokens and need no standing approval beyond what the caller grants for one call.
`unlockCallback` only accepts calls from the PoolManager. V4LiquidityHelper keys every position by
`keccak256(abi.encode(caller, userSalt))`, so one caller can never modify or withdraw another caller's position.
Native ETH pairs are not supported (ERC-20 only), and no hook data is passed.

Source: `packages/contracts/src/v4/` (`UnitReceiptToken.sol`, `V4LiquidityHelper.sol`, `V4SwapHelper.sol`,
`V4Settle.sol`). The Uniswap v4 interfaces, types and math libraries they use are copied unmodified from
Uniswap/v4-core (commit `46c6834698c48bc4a463a86d8420f4eb1d7f3b75`, MIT-licensed files only) into
`packages/contracts/src/v4/core/` together with the MIT license. The on-chain PoolManager exposes the same
v4-core interface (`unlock`, `initialize`, `modifyLiquidity`, `swap`, `sync`, `settle()`, `take`, `extsload`,
`exttload` selectors present in its bytecode).

## Tests

`packages/contracts/test/V4Pool.t.sol` holds 8 tests that run against a fork of the live chain (env `ROBINHOOD_RPC`,
default `https://rpc.testnet.chain.robinhood.com`; skipped with a message when the RPC is unreachable). Two pure
tests (exact price math and range alignment) live in the same file in a separate contract, `V4PoolPureTest`, so they
always run. The fork tests deploy a fresh token and helpers in the fork, initialize a pool on the real PoolManager,
and check: the exact sqrtPriceX96 and
tick, LP fee 3000 and protocol fee 0, tick-spacing enforcement (a misaligned tick reverts with `TickMisaligned`),
active and per-tick liquidity, swap output in both directions against the constant-product formula on the
position's virtual reserves (within 2 base units), that a stranger cannot remove another caller's position, the
slippage bound, and that no tokens stay in either helper. Both token orderings are covered.

```sh
cd packages/contracts && forge test --match-path test/V4Pool.t.sol
```

The deployment script is `packages/contracts/script/DeployV4Pool.s.sol`. The PoolManager uses transient storage,
so the script is run with `--evm-version cancun`; the three contracts on chain were compiled with solc 0.8.30,
via-IR, 200 optimizer runs, EVM version cancun.

## Re-pool for a new stable token

The helpers take any `PoolKey`, and tIP16P (owner: the deployer) stays the unit token, so moving the pool to a new
6-decimal stable test token deploys nothing. That is how the current mUSDG pool was created (stable token mUSDG
`0x0B71c1B3...4D95`, six transactions in blocks 128236851 to 128236900, hashes in the deployment file). It is one script,
`packages/contracts/script/RePoolV4.s.sol`, which:

1. sorts (tIP16P, new stable) into the key `(currency0, currency1, fee 3000, tickSpacing 60, hooks 0x0)`;
2. computes `sqrtPriceX96` exactly as `DeployV4Pool` does (10.99 stable per unit by default; the floor of an integer
   square root, for either currency order) and initializes the pool, or skips that step when slot0 is already set
   within `MAX_TICK_DRIFT` ticks (default 5) of the target, and refuses when it is set anywhere else;
3. mints only what the deployer is missing, and only if the deployer owns that token (otherwise it stops);
4. approves V4LiquidityHelper for the exact amounts, then adds liquidity through it (default 1,000 units over the same
   x1.5 / /1.5 range as today: `RANGE_BPS=5000`, 4055 ticks either side, widened to multiples of 60).

Safety: it requires chain id 46630, prints every planned transaction with a gas estimate, requires the deployer's ETH
balance to cover three times the estimated cost, reads slot0 and the position back, and does nothing at all if the
deployer already has liquidity at that range in that pool (so running it twice is harmless). Forge runs the whole
script in simulation before sending anything, so a failed check sends no transaction. Measured on a fork: 6
transactions (initialize, two mints, two approvals, add liquidity), about 630,000 gas with margin, about 0.0000063 ETH
at the testnet's 0.01 gwei.

Env: `STABLE_TOKEN` (required), `UNIT_TOKEN` (default tIP16P), `PRICE_NUM` / `PRICE_DEN` (default 1099 / 100),
`LIQ_UNITS` (default 1000000000, i.e. 1,000 units), `RANGE_BPS` (default 5000), `MAX_TICK_DRIFT` (default 5),
`DEPLOYER` (default: the `--sender`).

Operator sequence, once the new stable token is deployed and its owner is the deployer `0x6129C88C...5501`:

```sh
# 1. optional rehearsal: the same command without --broadcast (simulation only, nothing is sent)
# 2. the re-pool itself (one command)
cd packages/contracts && STABLE_TOKEN=<new stable address> forge script script/RePoolV4.s.sol:RePoolV4 --evm-version cancun --out out/cancun --cache-path cache/cancun --rpc-url https://rpc.testnet.chain.robinhood.com --account <keystore-name> --sender 0x6129C88CE91ACdf5c1E42188B1aF88C2166a5501 --broadcast --slow

# 3. confirm on chain: slot0 of the new pool (pool id from the script output or the deployment file)
POOL_ID=$(jq -r .poolId packages/contracts/deployments/v4-pool-<SYMBOL>-46630.json)
cast call 0x8366a39CC670B4001A1121B8F6A443A643e40951 'extsload(bytes32)(bytes32)' \
  $(cast keccak $(cast abi-encode 'f(bytes32,uint256)' $POOL_ID 6)) -r https://rpc.testnet.chain.robinhood.com

# 4. point the Worker at it: copy "workerVars" from the deployment file into apps/web/wrangler.jsonc "vars"
#    (V4_POOL_ID, V4_TOKEN0, V4_TOKEN1, V4_TICK_LOWER, V4_TICK_UPPER, V4_TOKEN1_SYMBOL), then
cd apps/web && npm run check:worker && npm run test:worker && npm run deploy
curl -s https://skudesk.lol/api/v4/pool   # stableSymbol is the new symbol, mode REAL
```

Under `--broadcast` the script writes `packages/contracts/deployments/v4-pool-<SYMBOL>-46630.json` (pool key, id,
state slot, ticks, seed amounts, `workerVars`). It is written from the simulation just before sending, so step 3 is
the confirmation; transaction hashes are in `packages/contracts/broadcast/RePoolV4.s.sol/46630/run-latest.json`.
The old tIP16P / mUSDC pool and its liquidity stay where they are (retired, not drained). Fork tests:
`cd packages/contracts && forge test --match-path test/RePoolV4.t.sol` (both currency orders, price, liquidity,
empty helpers, a 100-stable swap against the constant-product formula within 2 base units, and the second run being
a no-op).

## Limits

- Test tokens only. Prices here say nothing about real-world value, and tIP16P cannot be redeemed for anything.
- One liquidity position, about 11,000 mUSDG deep per side. A swap of a few hundred mUSDG moves the price
  noticeably; outside 7.29 to 16.57 the pool has no liquidity.
- `swapExactIn` spends up to `amountIn`, not exactly `amountIn`. V4SwapHelper passes the widest price limit
  (TickMath min/max), and the only liquidity is inside the range, so a large swap runs through the range, spends only
  what the range could absorb, and leaves the rest with the caller. About 13.5k mUSDG is enough to push the pool out
  of its range, after which the price no longer says anything useful until someone trades it back.
- The helpers are test-grade: `swapExactIn` has no deadline and `modifyLiquidity` has no min/max amounts, so a
  transaction that sits in the mempool can execute at a worse price. Use exact approvals and small amounts.
- The deployer can withdraw the whole seed position at any time, and the owner can mint unlimited tIP16P and mUSDG.
- The protocol fee is currently 0. That depends on the PoolManager owner (`0x9701fb0a...`) leaving the protocol fee
  controller unset; if it sets one, the protocol fee can change.
- Whether this PoolManager is an official Uniswap Labs deployment was not checked. Its verified code matches upstream
  v4-core commit `46c6834698c48bc4a463a86d8420f4eb1d7f3b75`.
- No link to BlindBook: if the batch market clears at a different price, this pool does not follow until someone
  trades it there.
- The helpers are small and fully tested on a fork, but they have not been audited.
- tIP16P and mUSDG are owner-mint tokens; the owner (the project deployer) can mint more at any time.
