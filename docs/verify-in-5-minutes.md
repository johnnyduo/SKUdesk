# Verify SKUdesk in 5 minutes

> SKUdesk lets agents compete to find and bid for the same product in sealed-batch auctions; a vault limits what each agent can spend and records the proof on-chain.

Testnet prototype: price search, agent vault, sealed auction and a Uniswap v4 reference pool work today; ordering and delivery of real goods are still being connected.

A checklist a reviewer can run without trusting us. Every step is read-only: no wallet, no keys, no transactions.
The outputs below are real and were read on **2026-10-03 between 16:17 and 16:25 UTC** (chain head about block 128,246,000), against the system deployed on 2026-10-03 at 15:36 UTC (block 128,228,499; the earlier mUSDC deployment is retired). Outputs are trimmed for space. Vault and market numbers move over time, because the owner and the bots keep using the contracts.

The product in every step is the **iPhone 16 Pro Clear MagSafe Case** (market id `CASE-IP16PRO-CLEAR-MAG-001`, symbol `IP16P-CLR`).

You need `curl` and `python3`, plus Foundry's `cast` for steps 2 to 7 (`curl -L https://foundry.paradigm.xyz | bash`). Step 1 needs only a browser.

```sh
R=https://rpc.testnet.chain.robinhood.com          # Robinhood Chain Testnet RPC, chain id 46630
X=https://explorer.testnet.chain.robinhood.com     # Blockscout explorer
V=0x3799747B933Ed7FEfAd6097998749Fd95fCD8c2A       # SKUdeskCore (the mandate vault)
T=0x0B71c1B397A9d33198e0A6a5701E12011AC84D95       # mUSDG (Test USDG, test token, no value; contract class MockUSDC)
B=0x8b4dFd26ab2A7Bdfd2090e434bcfB2C10A296E5d       # BlindBook (sealed-batch auction)
F=0xeA8407948e8BE12Ea2365d1BEdBADf364aadaaE0       # AgentFactory (vault + locked account + identity)
I=0x8004A818BFB912233c491871b3d84c89A494BD9e       # ERC-8004 identity registry (shared, not ours)
PM=0x8366a39CC670B4001A1121B8F6A443A643e40951      # Uniswap v4 PoolManager already on the chain
```

---

## 1. Open the live site (1 minute)

Base URL: https://skudesk.lol. Every route below returned HTTP 200 at 16:19 UTC (the Worker redirects to the trailing-slash path; use `curl -L`).

| Route | What to look for |
|---|---|
| `/` | The landing page |
| `/app/create` | The page that creates an agent account in one transaction (it needs a wallet to send; you can read the page without one) |
| `/app/radar` | The price-compare panel, with a source label per source (live source or test data) and the spread basis |
| `/market` | The BlindBook terminal: chart, tape and epoch table built from on-chain events. Give it up to a minute to load the newest history. **Recent results** under the sealed book lists finished epochs with their clearing transactions (there is no replay mode on this page) |
| `/show` | The ON-CHAIN RUN strip with the run date and blocks, and a line such as "9 of 9 transactions match the chain, according to the public RPC" (the page only tries to check; if the RPC is down it says so). Press **Walk through the run**. Watch for lot 1, 350 units, spend $2,306.50, the red `MathMismatch` sentence, and the payout sized to the verified net |
| `/app/policies` | The live mandate read from chain. The "Try to cheat" panel: pick **Inflate the profit**, and the deployed contract answers `MathMismatch` through a read-only `eth_call` |
| `/app/integrations` | The live backend table, with a label for each source (NOT CONNECTED means no API key yet) |
| `/deck` | The deck. The last content slide lists the limitations |

## 2. The contracts are source-verified (30 seconds)

Open them in the browser, or ask the Blockscout API:

```sh
for a in $V $T $B $F 0x4A349Eb630157881e9c39d2eEB0Aa5879Ca764FD 0x8875C482eC20c82bE0f62c16d6F94B92a6050a2A; do curl -s $X/api/v2/smart-contracts/$a | python3 -c 'import sys,json;d=json.load(sys.stdin);print(d["name"],"is_verified=",d["is_verified"],d["compiler_version"])'; done
```
```
RobinizeCore is_verified= True v0.8.30+commit.73712a01
MockUSDC is_verified= True v0.8.30+commit.73712a01
BlindBook is_verified= True v0.8.30+commit.73712a01
AgentFactory is_verified= True v0.8.30+commit.73712a01
TokenFaucet is_verified= True v0.8.30+commit.73712a01
UnitReceiptToken is_verified= True v0.8.30+commit.73712a01
```

The vault is called `SKUdeskCore` in this repository; the explorer lists the deployed instance under its original name `RobinizeCore` (same source).

`MockUSDC` is the contract class of the mUSDG token (name "Test USDG (testnet stand-in)", symbol `mUSDG`, read on chain at 16:1x UTC). It is a test token, not real USDG or USDC.

- https://explorer.testnet.chain.robinhood.com/address/0x3799747B933Ed7FEfAd6097998749Fd95fCD8c2A?tab=contract
- https://explorer.testnet.chain.robinhood.com/address/0x0B71c1B397A9d33198e0A6a5701E12011AC84D95?tab=contract
- https://explorer.testnet.chain.robinhood.com/address/0x8b4dFd26ab2A7Bdfd2090e434bcfB2C10A296E5d?tab=contract

Also checked on 2026-10-03 at 16:1x UTC: `V4LiquidityHelper` `0xF0BD…e3D4` and `V4SwapHelper` `0xFAbd…3Bcb` return `is_verified: True`, and the Uniswap `PoolManager` `0x8366…0951` returns `True` (compiler v0.8.26). The ERC-8004 registry proxy `0x8004…BD9e` returns `False`: it is a third-party contract, and its implementation source is not verified (`docs/agent-identity.md`). The per-agent vault and account that `AgentFactory` creates (for example `0x9204…A3bf` and `0xa123…4f61`, agent 128) are clones with no source verified at their own address.

## 3. Vault state on chain, and the agent run file (1 minute)

```sh
for f in "free()(uint256)" "totalEscrow()(uint256)" "totalPaidOut()(uint256)" "totalProceeds()(uint256)" "nextLot()(uint256)" "maxExec()(uint256)" "dailySpendCap()(uint256)" "minMarginBps()(uint256)" "quoteTTL()(uint256)" "paused()(bool)"; do printf '%s = ' "$f"; cast call $V "$f" --rpc-url $R; done
cast call $V "statusOf(uint256)(uint8)" 1 --rpc-url $R
cast call $V "lots(uint256)(uint256,uint256,uint256,bytes32,bytes32,uint8)" 1 --rpc-url $R
```
```
free()(uint256) = ...                       (moves with owner deposits and withdrawals; at the end of the run it was 5913500000; check the identity in the note below instead)
totalEscrow()(uint256) = 0
totalPaidOut()(uint256) = 2306500000
totalProceeds()(uint256) = 3220000000
nextLot()(uint256) = 1
maxExec()(uint256) = 250000
dailySpendCap()(uint256) = 500000
minMarginBps()(uint256) = 1800
quoteTTL()(uint256) = 180
paused()(bool) = false
7                       <- statusOf(1): 7 = SETTLED (enum LS, SKUdeskCore.sol:42)
350                     <- units
659                     <- landed cost per unit, cents
230650                  <- spend, cents = 659 x 350 = $2,306.50
0x8747…550e             <- productHash = keccak256("CASE-IP16PRO-CLEAR-MAG-001")
0x93f6…8f89             <- oppHash (equals run.json meta.oppHash)
7
```

Compare with the run file:

```sh
python3 -c "import json;r=json.load(open('apps/web/src/data/run.json'));print(r['end']);print(r['meta']['lot'],r['accepted']['units'])"
cast keccak "CASE-IP16PRO-CLEAR-MAG-001"
```
```
{'free': '<current free()>', 'totalEscrow': '0', 'totalPaidOut': '2306500000', 'totalProceeds': '3220000000', 'spentToday': '230650'}
1 350
0x874760df68911be9e368727c9d7c69bb3a9fc9c8845563c7febbc10a8bb4550e
```

How to read it: 1 cent = 10,000 base units (6-decimal token, `SKUdeskCore.sol:21`). Realized = proceeds − paid out = 3,220,000,000 − 2,306,500,000 = 913,500,000 base units = **$913.50**. That equals net 261 cents × 350 units, the figure the contract derived at commit time (`run.json` event 13). **This match is by construction, not a market result.** The agent script set the settlement proceeds to (net + landed) × units (`apps/web/tools/run-agent.ts:210`). The payer is the owner's own address (`packages/contracts/deployments/46630.json`, `payer` = `owner`). What the chain proves is the accounting: profit was counted on tokens actually received. Delivered, listed and sold in this run are agent-attested.

The live `free()` and the deposit counters move when the owner deposits or withdraws, so do not expect an exact number: at the end of the run `free()` was 5,913,500,000 (`run.json` `end.free`), and a read at about 16:50 UTC on 2026-10-03 showed 5,912,500,000 after the owner deposited 1 token and withdrew 2 more (cause not verified). What must hold at any time is the identity `free = deposited − withdrawn − escrow − paid out + proceeds`: read `totalDeposited()`, `totalWithdrawn()`, `totalEscrow()`, `totalPaidOut()`, `totalProceeds()` and check it (with `totalEscrow` 0, `paidOut` 2,306,500,000 and `proceeds` 3,220,000,000 after settlement). `spentToday` is a per-day counter that the contract resets lazily, inside the next `commitOpportunity`, so the getter can show the previous day's total until then.

## 4. The transactions (1 minute)

| What | Tx | `cast receipt <tx> status --rpc-url $R` |
|---|---|---|
| Vault deploy (creates `0x3799…8c2A`, block 128,228,546) | [0x0f0c8578…a881](https://explorer.testnet.chain.robinhood.com/tx/0x0f0c8578e58e5fe4b4d1928801d4d8318319db8916a7ccd43fcf3f94c2c3a881) | `true` |
| `commitOpportunity`, accepted (block 128,229,470) | [0x2eef0a8f…99ab](https://explorer.testnet.chain.robinhood.com/tx/0x2eef0a8f0620b5526536d2330b898d5f3f2140dc368830a3ca73f0d8c91299ab) | `true` |
| Inflated-profit commit, **reverted** (block 128,229,533) | [0xcbc1f59c…e056](https://explorer.testnet.chain.robinhood.com/tx/0xcbc1f59c3a70255239c697e3aeae1e88433826294bf792915998a365d261e056) | `false` |
| `settle`, proceeds pulled (block 128,229,614) | [0x9a6d4b3d…d384](https://explorer.testnet.chain.robinhood.com/tx/0x9a6d4b3d07d1c84abda272717f3c10cae406ccd68a40d80a5ef3cdcf71b8d384) | `true` |
| `createAgent` (agent 128: vault, locked account, identity; block 128,231,762) | [0x3c271080…ad06](https://explorer.testnet.chain.robinhood.com/tx/0x3c271080e364cd90d48a0ecdc7ffb812ebb5353d5a9fa26bf9435f668383ad06) | `true` |

All five statuses were read with `cast receipt` on 2026-10-03 (16:1x UTC). All 9 transaction hashes in `run.json` were re-read the same way: 8 `true`, 1 `false`, and each block number equals the file's.

The revert reason, decoded by Blockscout:

```sh
curl -s $X/api/v2/transactions/0xcbc1f59c3a70255239c697e3aeae1e88433826294bf792915998a365d261e056 | python3 -c 'import sys,json;d=json.load(sys.stdin);print(d["result"],d["method"]);print(d["revert_reason"]["method_call"],[p["value"] for p in d["revert_reason"]["parameters"]])'
```
```
execution reverted commitOpportunity
MathMismatch(int256 claimedNet, int256 derivedNet, uint256 claimedBps, uint256 derivedBps) ['390', '261', '2374', '2374']
```

The agent claimed 390 cents of net per unit, and the contract derived 261. The other five tampering cases in `run.json` (`SpendCap`, `Replay`, `Stale`, `BadQuoteHash`, `PayeeNotAllowed`) were read-only `eth_call`s made as the agent address. They were not mined: the RPC refuses to broadcast a transaction that fails gas estimation (`README.md`). The run's 9 transactions (8 succeeded, 1 reverted) are listed in `run.json` (`events[].tx`).

The agent account made by `createAgent` can be read back. The vault's owner is the owner, and its agent is the locked account:

```sh
cast call $I "ownerOf(uint256)(address)" 128 --rpc-url $R
cast call 0x9204523A99432374B7C6f08587e53bea4B8eA3bf "agent()(address)" --rpc-url $R
```
```
0x6129C88CE91ACdf5c1E42188B1aF88C2166a5501          <- the owner
0xa123b77853fB3A2B621c57E5AC6dd8A3b6254f61          <- the locked account (apps/web/src/data/agent4337.json)
```

## 5. The sealed-batch auction: one cleared round (1 minute)

BlindBook is our own commit-reveal auction. The bidders are scripted bot wallets, and the units are operator-issued test units that are not tied to real stock. One cleared round for this product, read from the new BlindBook's events (`EpochCleared` logs from block 128,228,560; the bundled `apps/web/src/data/blindbook-history.json` is a snapshot from the first minutes after the redeploy and holds only older epochs 7 and 8):

```sh
T1=0x2bb327bc636f82a197dddb67b251ddaa416fcce2af63e54bf5cdeb3918a18025
cast receipt $T1 status --rpc-url $R
cast receipt $T1 blockNumber --rpc-url $R
curl -s $X/api/v2/transactions/$T1 | python3 -c 'import sys,json;d=json.load(sys.stdin);print(d["status"],d["method"],d["to"]["name"],d["timestamp"])'
```
```
true
128243039
ok clear BlindBook 2026-10-03T16:13:40.000000Z
```

The `EpochCleared` log in that transaction has market `0x874760df…550e` (the market id above), epoch 48 (0x30), price 1088 (that is $10.88), volume 12, 3 buys, 3 sells and 0 forfeited bonds. Decode it with `cast receipt $T1 logs` and the event signature `EpochCleared(bytes32,uint256,uint256,uint256,uint256,uint256,uint256)` (topic `0xbb2d1e15…c11a`, `BlindBook.sol:43`).

Two limits are visible in the contract: orders are revealed before the clear transaction, so prices are not secret until clearing (finding F-B6), and `issue` is owner-only and unbacked (`BlindBook.sol:64`, F-B3).

## 6. Market and chain sanity (30 seconds)

```sh
for f in "marketCount()(uint256)" "currentEpoch()(uint256)" "paused()(bool)" "treasury()(uint256)" "accounted()(uint256)"; do printf '%s = ' "$f"; cast call $B "$f" --rpc-url $R; done
cast call $T "balanceOf(address)(uint256)" $B --rpc-url $R
cast call 0x0000000000000000000000000000000000000064 "arbChainID()(uint256)" --rpc-url $R
```
```
marketCount()(uint256) = 6
currentEpoch()(uint256) = 60                      (a time-based counter since the deploy, not a count of cleared rounds)
paused()(bool) = false
treasury()(uint256) = 22000000            <- 11 forfeited bonds of 2 tokens each
accounted()(uint256) = 304473430000
304473430000                              <- token balance of the book equals what the book accounts for
46630                                     <- ArbSys precompile answers: this is an Arbitrum Nitro chain
```

Whether the bots are running changes over time. At 16:22 UTC `cast logs --from-block 128228560 --address $B "EpochCleared(bytes32,uint256,uint256,uint256,uint256,uint256,uint256)" --rpc-url $R` returned 56 events, from block 128,231,071 to block 128,246,157 (most for the case's market; the keeper can be set to act in one of every N epochs to save testnet ETH). If a recording or a review happens while the keeper is off, `/market` shows real history but no live epochs, and its Replay button re-animates a stored one.

## 7. The Uniswap v4 reference pool (30 seconds)

A standard Uniswap v4 pool for two test tokens, tIP16P (units of the case, no redemption right) and mUSDG: fee 0.3%, tick spacing 60, no hook. It is not connected to BlindBook and delivers no goods (`docs/v4-pool.md`).

```sh
S=https://skudesk.lol
curl -s $S/api/v4/pool
cast call $PM 'extsload(bytes32)(bytes32)' 0x2c06a2b62b70da3a4d7551113aa826f03a01355f7b8d671389058485389cce75 --rpc-url $R
```
```
{"mode":"REAL","chainId":46630,"poolManager":"0x8366…0951","poolId":"0xafede328…5a54","token0":{"symbol":"mUSDG",…},"token1":{"symbol":"tIP16P",…},"stableSymbol":"mUSDG","unitSymbol":"tIP16P","fee":3000,"tickSpacing":60,"hooks":null,"tickLower":-28080,"tickUpper":-19860,…,"tick":-23972,"sqrtPriceX96":"23899055485173685887908959771","priceMusdcPerUnit":"10.990000","priceStablePerUnit":"10.990000","liquidity":"17851181514","inRange":true,"blockNumber":128245233,"updatedAt":"2026-10-03T16:19:27.879Z"}
0x000000000bb8000000ffa25c00000000000000004d38d5d9de6cb2394323d61b
```

In the second line, `0x0bb8` = 3000 is the LP fee and `0xffa25c` = −23972 is the tick (a signed 24-bit number). The price 10.99 mUSDG per unit is the opening price; nothing has moved it since the seed. The two price fields have the same value (`priceMusdcPerUnit` is an older field name that the route keeps). The pool is currency0 = mUSDG, currency1 = tIP16P, so the raw tick is negative. The route `GET /api/v4/pool` returned HTTP 200 at 16:19 UTC. The pool was seeded by six transactions (`packages/contracts/deployments/v4-pool-mUSDG-46630.json`): initialize `0x3cdbc7ad…7d11` in block 128,236,851 and the seed position `0x37612ee2…4ad8` in block 128,236,900 were both read with `cast receipt`: status `true`. The earlier tIP16P / mUSDC pool still exists on chain with its liquidity but is retired: the site, the Worker and this pack do not use it.

## 8. The agent's ERC-8004 identity (30 seconds)

The run's agent wallet holds identity 119 in the shared ERC-8004 registry. That registration was made before the redeploy, and it has not been updated since. The vault now in use is a new one.

```sh
cast call $I "ownerOf(uint256)(address)" 119 --rpc-url $R
cast call $V "agent()(address)" --rpc-url $R
cast call $I "ownerOf(uint256)(address)" 128 --rpc-url $R
cast call $I "tokenURI(uint256)(string)" 119 --rpc-url $R | tr -d '"' | sed 's#^data:application/json;base64,##' | base64 -d | python3 -m json.tool
```
```
0x3EC91B7dfF57403aE298e503FAe4f5815B4C1818          <- identity 119 belongs to the agent wallet
0x3EC91B7dfF57403aE298e503FAe4f5815B4C1818          <- the same address the current vault authorizes
0x6129C88CE91ACdf5c1E42188B1aF88C2166a5501          <- identity 128 (the factory example) belongs to the owner
{
    "type": "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
    "name": "SKUdesk agent",
    "description": "… Robinhood Chain Testnet only. Settlement token is MockUSDC, a test token with no value. The contracts are source-verified but not audited.",
    "vault": {"chainId": 46630, "address": "0xa452161B75b7B79B3021639b73C0F5E3A529a1bb"},
    "registrations": [{"agentId": 119, "agentRegistry": "eip155:46630:0x8004A818BFB912233c491871b3d84c89A494BD9e"}]
}
```

Read honestly: the agent wallet owns identity 119 and is the vault's agent, but the card of 119 still names the retired vault `0xa452…a1bb` (not the current `0x3799…8c2A`) and calls the token `MockUSDC`. One `setAgentURI(119, …)` transaction from the agent wallet would fix it; it has not been sent. The card of identity 128 is a short `data:` URI (name "SKUdesk proof agent", no vault link) written by `apps/web/tools/agent-4337.ts`.

On the explorer: https://explorer.testnet.chain.robinhood.com/token/0x8004A818BFB912233c491871b3d84c89A494BD9e/instance/119. The registration tx is `0xc1ea4528…118d` (block 128,175,533) and the `setAgentURI` tx is `0xd2bf6b77…d683` (block 128,175,636); both read `true` with `cast receipt` on 2026-10-03 at 16:2x UTC.

## 9. The backend API (30 seconds, safe to call)

These calls are public and read-only. They are rate-limited (30 per 60 s for reads, 10 per 60 s for compare) and never return secrets.

```sh
curl -s $S/api/health
curl -s $S/api/merchant/status
curl -s $S/api/prices/sources
```
```
{"ok":true,"service":"robinize-api","apiVersion":1,"time":"…","requestId":"…"}
{"mode":"REAL","configured":true,"hasDataSource":true,"registered":true,"latencyMs":807,"checkedAt":"2026-10-03T16:19:37.307Z"}
{"sources":[
  {"id":"ebay","mode":"MOCK","configured":false,"searchesByGtin":true,"dailyBudget":1000,"quotaRemaining":null},
  {"id":"bestbuy","mode":"MOCK","configured":false,"searchesByGtin":true,"dailyBudget":2000,"quotaRemaining":null},
  {"id":"serpapi","mode":"REAL","configured":true,"searchesByGtin":false,"dailyBudget":8,"quotaRemaining":6,
   "backup":{"id":"searchapi","configured":true,…}}]}
```

What this shows:
- The Google Merchant account is connected and registered, and it has a data source. The public response leaves out the account ids (`apps/web/worker/google/status.ts`).
- SerpApi (Google Shopping) is a live source. eBay and Best Buy are not connected (no API keys yet), so the site labels them TEST DATA and the raw API says `"mode":"MOCK"`. Lazada and Shopee are integrated for demo purposes only: fixed snapshot listings, no live API.

You can also call `curl -s "$S/api/prices/compare?sku=CASE-IP16PRO-CLEAR-MAG-001"`. An anonymous compare never spends a paid search: SerpApi is answered from cache only (`apps/web/worker/feeds/run.ts:19-24`). At 16:19 UTC it returned these results:

| Source | mode | cache | best | locked / offers |
|---|---|---|---|---|
| ebay | `MOCK` | NONE | $9.74 | 3 / 3 |
| bestbuy | `MOCK` | NONE | $11.06 | 3 / 3 |
| serpapi | REAL | HIT | none | **0 / 40** |

The spread came back as `basis: "MOCK"` with the flag `gtin_unavailable`. So the 40 live Google Shopping offers were all rejected by the identity gates (other models, hard-shell, multi-device titles), and the only spread on screen is built from test data, and labelled TEST DATA. That is the honest state today. It is also why the product claim is "agents compete to find the lowest total cost from offers that pass the identity checks", not "the best price".

Do not call `POST /api/merchant/listing` for this check. It is a dry run by default and sends nothing to Google, but it is a write route and is not needed to verify anything here.

## 10. Run the tests yourself (optional, about 5 minutes)

```sh
git clone --recurse-submodules https://github.com/johnnyduo/SKUdesk && cd SKUdesk && npm ci
(cd packages/contracts && rm -rf cache/invariant && forge test)                 # 252 passed, 0 failed (29 suites)
node --test packages/economics/test/proofs.econ.test.ts apps/web/src/lib/proofs.book.test.ts   # proof suites on the TypeScript mirrors
(cd apps/web && npm run test:worker)                                   # 448 passed
(cd apps/web && npm run test:site)                                     # 129 passed
(cd apps/web && npm test)                                              # 43 passed
(cd apps/web && npm run test:market)                                   # 287 passed
(cd apps/web && npm run build && npm run test:built)                   # 56 passed (needs a built `dist`)
```

Counts are from the verification run of this release (Node 26, forge 1.7.1). No network access or keys are needed for the TypeScript and Worker tests; the Uniswap v4 fork tests in `test/V4Pool.t.sol` read the public RPC and skip themselves when it is unreachable. `bash scripts/verify-all.sh` runs everything, but its later stages need a funded `.env` and send testnet transactions, so it is not a reviewer step.
