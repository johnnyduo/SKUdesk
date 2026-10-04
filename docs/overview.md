# SKUdesk: technical overview

The short version is in the [README](../README.md); this page keeps the full status, limits and layout.

> SKUdesk lets agents compete to find and bid for the same product in sealed-batch auctions; a vault limits what each agent can spend and records the proof on-chain.

Testnet prototype: price search, agent vault, sealed auction and a Uniswap v4 reference pool work today; ordering and delivery of real goods are still being connected.

One product is used everywhere (site, video, docs): the **iPhone 16 Pro Clear MagSafe Case**, market id `CASE-IP16PRO-CLEAR-MAG-001`, symbol `IP16P-CLR`. It is a phone case, not a phone. Everything runs on Robinhood Chain Testnet (chain id 46630) with a test token, mUSDG (Test USDG, no value; contract class `MockUSDC`). The system was deployed on 2026-10-03 at 15:36 UTC, from block 128,228,499; the earlier mUSDC deployment is retired.

## What works today, and what does not

1. **Create an agent account.** One transaction from `/app/create` (a wallet is needed to send it) deploys a spending vault the owner controls, a locked ERC-4337 smart account that can only call that vault, and an ERC-8004 identity token.
2. **Compare prices with same-product checks.** A Cloudflare Worker compares prices for the product. An offer counts only after it passes the identity gates. Google Shopping through SerpApi is live. eBay and Best Buy show test data until their keys are set. Lazada and Shopee are integrated for demo purposes (fixed snapshot listings, no live API). The goal is that agents compete to find the lowest total cost from offers that pass the identity checks. Today none of the 40 live Google offers passed the gates, so no real price gap has been shown.
3. **Bid in a sealed-batch auction.** BlindBook is our own commit-reveal auction: orders are hashes, then revealed, then cleared at one price per 45-second epoch. The bidders are six scripted bot wallets, and they trade operator-issued test units (`BlindBook.issue`) that are not tied to real stock.
4. **Limit what each agent can spend.** The vault, `SKUdeskCore`, re-derives the agent's economics from the quote, derives the spend itself, caps spend per trade and per UTC day, and escrows mUSDG only to payees the owner approved. In the proof run it refused six tampering attempts. The proof run was paid from the owner's test wallet, and its "delivered, listed, sold" states are attested by the agent.
5. **A reference price.** A Uniswap v4 pool for two test tokens (mUSDG and tIP16P; fee 0.3%, tick spacing 60, no hook) gives a price anyone can read, and the Worker exposes it read-only at `GET /api/v4/pool`. It does not deliver goods, and the test tokens carry no right to anything. See `v4-pool.md`.

### Target flow (not built yet)

pick product -> agents find sources -> sealed bids -> round clears -> buyer pays -> delivery confirmed -> seller paid.

Steps 1 to 4 exist on testnet with the caveats above, and prices are revealed before a round clears, so bids are not secret until then. **Steps 5 to 7 exist only as a script-driven testnet proof (`OrderEscrow`, `order-escrow.md`), not as a product:** the escrow contract is not wired into the market page, there are no outside buyers, no seller inventory proof and no real goods; the delivery statement comes from one named operator address, and the proof wallets are script-controlled. The on-chain run covers payment, bond, delivery statement, release and a refund; the unshipped-timeout and dispute paths are covered by tests only. There is also no runtime that makes a user-created agent search and bid by itself. The agents that bid today are scripted.

## Links

- Live site: https://skudesk.lol
- Pitch deck: https://skudesk.lol/deck/
- Agent run walkthrough: https://skudesk.lol/show/
- Market (sealed-bid batch auctions): https://skudesk.lol/market/
- Uniswap v4 reference pool: [v4-pool.md](v4-pool.md)
- Proofs of the contract math: [proofs/README.md](proofs/README.md)
- Agent identity (ERC-8004, agent 119): [agent-identity.md](agent-identity.md)
- Worker backend runbook: [runbooks/worker-backend.md](runbooks/worker-backend.md)
- Architecture and trust boundaries: [architecture.md](architecture.md)
- Verify it yourself, read-only, in five minutes: [verify-in-5-minutes.md](verify-in-5-minutes.md)

## Clone and run

forge-std is a git submodule, so clone with `--recursive` (or run `git submodule update --init` after a plain clone). Node 22.18 or newer is needed, because the tools and tests run TypeScript natively.

```
git clone --recursive https://github.com/johnnyduo/SKUdesk
cd SKUdesk
npm install
(cd apps/web && npm run build)        # builds the site into apps/web/dist
(cd packages/contracts && forge test)
```

## The vault: the problem it solves

AI agents that spend money need limits. Session keys and smart-account spend-limit policies cap how much an agent may spend, but they still trust the figures the agent reports: its claimed profit, its cost breakdown, even the spend amount it passes in. An agent that overstates its margin, or passes a spend of 0 to dodge a cap, is not stopped by a limit alone.

## The differentiator

The contract does not just cap spend. It re-derives the agent's unit economics from the quote and derives the spend itself, then reverts if the agent's numbers differ. The agent proposes; the contract disposes.

- Spend is derived on-chain as landed cost times units. The agent never supplies it.
- Net profit and margin are recomputed on-chain. A claim that differs reverts with both numbers (`MathMismatch(claimedNet, derivedNet, ...)`).
- The quote must hash to the committed `quoteHash`; each opportunity id is `keccak256(productHash, quoteHash, snapshotHash)` and can be committed once. The agent supplies the snapshot hash and the observation time, so a new snapshot hash is a new id and the freshness check bounds the age the agent claims (see the limitations below).
- Escrow can only be released to payees the owner allowlisted.
- Settlement pulls tokens from an allowlisted payer and measures realized profit on tokens actually received.

## Architecture

```
 owner ──deposit / setPolicy / allowlist payees──▶ ┌────────────────────────────┐
                                                   │ SKUdeskCore (vault)       │
 apps/web/tools/run-agent.ts  (offline, local)      │  caps, margin floor, TTL   │
   1. load price snapshot  -> snapshotHash         │  re-derives net + spend    │
   2. Gemini proposes one trade (JSON schema)      │  replay + staleness checks │
   3. TypeScript gates: identity + policy          │  lot lifecycle + escrow    │
      (packages/matching, packages/economics)      │  payee allowlist           │
   4. agent sends txs ────────────────────────────▶│  settle on tokens received │
   5. tamper attempts are simulated / sent         └──────────────┬─────────────┘
   6. writes apps/web/src/data/run.json                           │ mUSDG (class MockUSDC, testnet stand-in)
                                                                  ▼
 apps/web  (Astro static site)
   /show    walks through the on-chain agent run (run.json) and tries to check its 9 transactions against the public RPC when you open it; the explorer links work without that
   /market  sealed-bid trading terminal on BlindBook (live chain events)
   /app     desk pages: the run, a fixed market snapshot, and live read-only chain state (no LLM on the page)
   /app/owner  wallet console: the owner acts through their own wallet
```

## What the contract enforces, and what it does not

Enforced on-chain:

- Per-execution spend cap and a per-UTC-day cap on new commitments, with the spend derived from the quote.
- Margin floor, quote lifetime, bounds on every quote field, and recomputed net and margin.
- Replay protection per (product, quote, snapshot) id, and a committed quote hash.
- Mint and fund only for a committed, unconsumed opportunity, for exactly the committed spend.
- A strict lot state machine, escrow released only to allowlisted payees, owner and agent roles, and a pause switch.

Known limitations (stated openly):

- The contract verifies the math, not that the input prices are true (the oracle problem). v1 commits a `snapshotHash` so inputs are auditable after the fact. TLS-notary or oracle-signed inputs are roadmap.
- Product identity (same SKU) is checked off-chain by the TypeScript gates. On-chain it appears only as a committed `productHash`. The contract does not verify the product match.
- Lifecycle steps after escrow (purchased, received, listed, sold) are agent-attested in v1. Proof-of-purchase integrations are roadmap.
- Settlement proceeds on testnet are a token transfer standing in for a marketplace payout.
- The settlement token is mUSDG (contract class `MockUSDC`, on-chain name "Test USDG (testnet stand-in)"), a testnet stand-in for the Robinhood Chain stablecoin USDG with an owner-only mint. It is not real USDG and has no value; the vault and the market take the token address as a constructor argument, so real USDG is a one-argument swap.
- Single owner, single agent; no LP flow yet.
- Not audited. The contracts are source-verified but have not been audited; testnet only; mUSDG is a test token with no value.
- The daily cap limits new commitments per UTC day, not cash-out. Opportunities do not expire, so commitments banked on earlier days can be minted and funded later, in one block. Cash-out is bounded by the per-lot cap and the vault's free balance. It is per UTC day, not per rolling 24 hours: across a midnight, up to twice the cap can be committed within 24 hours.
- The agent supplies `observedAt` and `snapshotHash`. The freshness check therefore bounds the age the agent claims, not the real age of the data, and the same quote can be committed again under a new snapshot hash (only the caps bound that).
- Settlement proceeds are chosen by the agent within the payer's allowance. They are pulled as real tokens, so the accounting is exact, but the sale price itself is not verified.
- BlindBook market owner powers: the owner can pause trading, and a pause during the reveal window forfeits committed bonds to the owner's treasury. The owner can also `issue` new units, which are warehouse receipts with no on-chain collateral behind them.
- The TypeScript economics mirror is exact for a sell price up to 9e11 cents and throws above that; the contract accepts up to 1e12. The economics library exposes the exact break-even buy price (`purchase + net`), the highest buy price at which net stays at or above zero.
- These findings come from the mathematical proofs in `docs/proofs/FINDINGS.md`. The contracts are deployed and immutable, so they are disclosed here and in the product, not patched. A redeploy would add an expiry on `mintLot` and `fundLot` and stop `clear` forfeiting bonds while paused.

## What is real and what is not

| Piece | Status |
|---|---|
| Vault contract on Robinhood testnet (46630), escrow, reverts | ONCHAIN |
| Gemini agent run (offline script) and its output | Real run, on a fixed snapshot |
| Market data for the agent run | FIXED SNAPSHOT, not a live feed |
| Price compare on the Worker | Google Shopping via SerpApi is a LIVE SOURCE; eBay and Best Buy are TEST DATA until keys are set; Lazada and Shopee are integrated for demo purposes (fixed snapshot listings, no live API) |
| BlindBook rounds and clearing prices | ONCHAIN. The bidders are scripted bots, and the units are operator-issued test units not tied to real stock |
| Uniswap v4 reference pool mUSDG / tIP16P | ONCHAIN, test tokens, no hook, not linked to BlindBook, delivers no goods |
| Settlement token | mUSDG (Test USDG, contract class `MockUSDC`), a test token |
| Purchase, receipt, listing, sale after escrow | AGENT ATTESTED. The proof run was paid from the owner's test wallet |
| Buyer payment, seller bond, delivery statement by a named verifier, seller payout (`OrderEscrow`, one SKU) | ONCHAIN proof on testnet, driven by a script with a named verifier; no real goods moved (`order-escrow.md`) |
| Real buyers ordering real goods, user-created agents that search and bid by themselves | Not built |
| `/app` desk pages | Read the run file and live chain state; no LLM and no transactions from the page (the Owner console sends transactions from the owner's own wallet) |

## Repo layout

```
apps/web/                 Astro 4 static site (React islands, viem)
  src/pages/              landing, /show (run), /app/* (desk pages)
  src/data/               run.json (run), snapshot.json (price snapshot)
  tools/run-agent.ts       offline agent: Gemini + gates + on-chain transactions
packages/contracts/       Foundry project: SKUdeskCore, MockUSDC, BlindBook, AgentFactory, AgentAccount, AgentIdentityRegistry, TokenFaucet, scripts, tests
packages/economics/       integer-cent economics, mirrors the contract's EconLib
packages/matching/        product-identity gates
packages/shared/          shared types and config
packages/agent, commerce/ interface sketches only (not built)
```

## Run the tests

```
cd packages/contracts && forge test
node --test packages/economics/test/*.test.ts packages/matching/test/*.test.ts
bash scripts/verify-all.sh   # all 10 stages: contracts, TS tests, build, agent run, market, 4337 agent factory, browser, wallet, deploy-your-agent, market UI
```

## Reproduce the run

1. Copy `.env.example` to `.env` and fill the deployer key, the agent key, `GEMINI_API_KEY` and `ROBINHOOD_RPC`. Fund both wallets with testnet ETH at the Robinhood Chain testnet faucet.
2. Deploy: `cd packages/contracts && forge script script/Deploy.s.sol --rpc-url $ROBINHOOD_RPC --broadcast`. This writes `packages/contracts/deployments/46630.json`.
3. Run the agent: `cd apps/web && node --env-file=../../.env tools/run-agent.ts`. This calls Gemini, sends the transactions and writes `apps/web/src/data/run.json`.
4. Build the site: `cd apps/web && npm run build` (or `npm run dev`).

Failing transactions cannot be broadcast through the RPC (gas estimation refuses them), so tamper attempts are decoded from `eth_call` simulations run as the agent address, plus one failing transaction sent with a forced gas limit so a revert is visible on the explorer.

## Contract addresses

See `packages/contracts/deployments/46630.json` for the deployed addresses.

| Item | Value |
|---|---|
| Chain | Robinhood Chain testnet, id 46630 |
| SKUdeskCore | [`0x3799747B933Ed7FEfAd6097998749Fd95fCD8c2A`](https://explorer.testnet.chain.robinhood.com/address/0x3799747B933Ed7FEfAd6097998749Fd95fCD8c2A) (source verified) |
| Test USDG, symbol mUSDG (testnet stand-in token; contract class `MockUSDC`) | [`0x0B71c1B397A9d33198e0A6a5701E12011AC84D95`](https://explorer.testnet.chain.robinhood.com/address/0x0B71c1B397A9d33198e0A6a5701E12011AC84D95) (source verified) |
| Deploy tx (SKUdeskCore) | [`0x0f0c8578e58e5fe4b4d1928801d4d8318319db8916a7ccd43fcf3f94c2c3a881`](https://explorer.testnet.chain.robinhood.com/tx/0x0f0c8578e58e5fe4b4d1928801d4d8318319db8916a7ccd43fcf3f94c2c3a881) |
| Happy-path commit tx | [`0x2eef0a8f0620b5526536d2330b898d5f3f2140dc368830a3ca73f0d8c91299ab`](https://explorer.testnet.chain.robinhood.com/tx/0x2eef0a8f0620b5526536d2330b898d5f3f2140dc368830a3ca73f0d8c91299ab) |
| Reverted tx (inflated profit claim, status 0) | [`0xcbc1f59c3a70255239c697e3aeae1e88433826294bf792915998a365d261e056`](https://explorer.testnet.chain.robinhood.com/tx/0xcbc1f59c3a70255239c697e3aeae1e88433826294bf792915998a365d261e056) |
| Settle tx | [`0x9a6d4b3d07d1c84abda272717f3c10cae406ccd68a40d80a5ef3cdcf71b8d384`](https://explorer.testnet.chain.robinhood.com/tx/0x9a6d4b3d07d1c84abda272717f3c10cae406ccd68a40d80a5ef3cdcf71b8d384) |

## The market: sealed-bid batch auctions (`/market`)

`/market` is a trading terminal on top of `BlindBook`, our own commit-reveal batch auction (it is **not** a Uniswap v4 hook; the separate Uniswap v4 reference pool described below is not linked to it). Every 45-second epoch has three windows: **commit** (orders are hashes only, so price, size and side are hidden), **reveal** (orders open and their cash or units are reserved), and **clear** (anyone calls `clear`; the maximal-volume price is found and everyone matches at ONE uniform price with price-time priority, settled atomically). Unrevealed orders forfeit a fixed bond.

- Contract: `packages/contracts/src/BlindBook.sol`. 33 Foundry tests (clearing, phases, bond forfeiture, fuzz against a brute-force reference, multi-epoch invariants, a 400-book parity test against the TypeScript mirror); the tests themselves were mutation-tested.
- TypeScript mirror of the clearing algorithm: `apps/web/src/lib/book.ts` (used for the indicative price while orders are revealed; the final price always comes from the on-chain `EpochCleared` event).
- Keeper and bots: `apps/web/tools/keeper.ts` (six bot wallets place sealed orders and clear them; one market per epoch by default, rotating over the listed ones: a catalog of 18 markets, 6 listed at deploy, the 12 products listed by `market-setup.ts`; `--markets N` to change, `--pin SYMBOL` to quote one market in every epoch), `market-setup.ts` (lists every catalog market on the book if it is not listed yet, then gas, tokens, book cash and inventory; it is idempotent), `market-verify.ts` (re-derives every cleared epoch from the events and checks conservation). Run: `cd apps/web && node --env-file=../../.env tools/keeper.ts --epochs 150`.
- The chart, tape and epoch table are built from the contract's events, so history survives the keeper stopping. The build ships a snapshot of that history (`apps/web/src/data/blindbook-history.json`, made by `node --env-file=../../.env tools/market-snapshot.ts`) so the page opens in seconds; only newer blocks are read from the RPC.
- Asset list: `apps/web/src/data/catalog.json` (12 widely known consumer products in five categories, each with a fixed US list price as of Oct 2026, then six phone cases as a secondary Accessories category with a fixed catalog reference price, validated by `apps/web/src/lib/catalog.ts`) behind a `ProductSource` interface (`apps/web/src/lib/products.ts`). A Google Merchant API adapter implements the same kind of seam in the Worker (`apps/web/worker/google/`). Its status is REAL on the live Worker (`/api/merchant/status`, registered, with a data source), and publishing stays a dry run unless an admin token is sent. The eBay and Best Buy price feeds are still MOCK because their keys are not set. The Merchant API lists a merchant's own products, it is not a market-price feed.
- Local integration test: `bash scripts/market-it.sh` (throwaway chain, real keeper, independent re-derivation). Everything together: `bash scripts/verify-all.sh`.

**What is real and what is not.** Prices on `/market` are real on-chain clearing prices. Liquidity comes from SKUdesk bots; their fair value is a fixed reference price plus a deterministic drift, not a live feed. "Units" are warehouse-receipt ledger entries issued by the operator; physical delivery is off-chain. The settlement token is mUSDG (Test USDG, contract class `MockUSDC`), a testnet stand-in. Orders revealed early are visible to later revealers (a free-option risk, mitigated by the forfeited bond).

| Item | Value |
|---|---|
| BlindBook | [`0x8b4dFd26ab2A7Bdfd2090e434bcfB2C10A296E5d`](https://explorer.testnet.chain.robinhood.com/address/0x8b4dFd26ab2A7Bdfd2090e434bcfB2C10A296E5d) (source verified) |

## Wallet and Owner console (`/app/owner`)

Connect any injected wallet (EIP-6963 discovery, no wallet library). The engine (`apps/web/src/lib/wallet.ts`) adds Robinhood Chain Testnet to the wallet when it is missing, classifies wallet errors by numeric code, and **simulates every transaction before asking for a signature**, so a call that would revert never reaches the wallet. The owner can deposit and withdraw, change the mandate, pause the vault (the kill switch), and manage payee and payer allowlists; any other wallet is refused by the contract with its own sentence. `scripts/e2e-wallet.cjs` drives all of this with real transactions on the testnet through a scripted browser wallet.

## Navigation: one story in six steps

The menu is the story, in order: **1 Desk** (`/app`, tabs: Overview, Opportunities, Lots, Transactions, Radar, Orders), **2 Agent trade** (`/show`), **3 Agent market** (`/market`), **4 Deploy agent** (`/app/create`), **5 Limits** (Agent, Mandate, Owner console), **6 Proof** (Run metrics, Contracts, Dependencies). Every page of the app shows "Next: ..." in the top bar and a Previous/Next strip at the bottom. The order lives in one file, `apps/web/src/lib/journey.ts`, and `scripts/e2e-journey.cjs` walks it at desktop and phone width.

## Deploy your agent (`/app/create`)

One page, one transaction: a visitor connects a wallet, sets a budget and gets (1) a **mandate vault** they own, (2) a **locked ERC-4337 smart account** that is the vault's only agent, and (3) an **identity token** in an ERC-8004-style registry. The page also has a test-money faucet, funding, a gas deposit, a limits editor and the kill switch.

- `AgentFactory.createAgent` deploys `AgentAccount` and `MandateVault` (SKUdeskCore with the owner and policy set in the constructor; SKUdeskCore itself is unchanged), registers the identity and hands the vault, account and token to the caller.
- `AgentAccount` (ERC-4337 v0.7): validates the agent key's signature (low-s only), and accepts only `execute(vault, 0, <one of the ten agent functions>)`. It cannot call the token or any other contract, cannot send ETH and cannot call the vault's owner functions. The vault still enforces every spending rule on top (two layers). Gas is paid from an ETH deposit the owner makes at the EntryPoint; there is no paymaster. The account caps the gas fields and refuses any priority tip, so an agent key acting as its own bundler cannot pay itself from the deposit; it can still burn the deposit on failing operations (never the vault's money), so keep it small. The owner can withdraw it any time. The identity token is a name tag: selling it does not move control of the vault or the account. Any bundler works; our scripts submit `handleOps` themselves.
- Identity: the factory registers each agent in the **ERC-8004 Identity Registry that already exists on Robinhood Chain Testnet** (`0x8004A818…BD9e`, ERC-721, version 2.0.0, a shared contract run by someone else and upgradeable). The factory writes the vault and account into the token metadata and hands the token to the user. `AgentIdentityRegistry.sol` is our own implementation of the same Draft interface (`register`, `setAgentURI`, `setMetadata`, `getMetadata`, `setAgentWallet` with an EIP-712 or ERC-1271 proof, `getAgentWallet`, `unsetAgentWallet`); the test suite runs against it, and the deploy script uses it only on a chain that has no registry. Reputation and Validation registries are not built.
- Tests: 47 Foundry tests run against the **real EntryPoint v0.7 runtime code copied from chain 46630** (`test/fixtures/entrypoint-v0.7.hex`, installed at its canonical address); attacks covered: wrong signer, tampered call data, token transfer, any other target, ETH, every owner function, replayed nonce, direct calls, malleable signatures. The guards were mutation-tested (`python3 scripts/mutate-agents.py`: 38 guard removals, all caught; recorded earlier, not re-run since the redeploy). `bash scripts/agents-it.sh` runs the whole flow on a throwaway chain; `scripts/e2e-create.cjs` drives the page in a browser with real transactions on the testnet and then has the page-generated agent key sign real UserOperations.
- Proof run on the testnet (`apps/web/tools/agent-4337.ts`, data in `apps/web/src/data/agent4337.json`; agent 128, vault `0x9204523A99432374B7C6f08587e53bea4B8eA3bf`, locked account `0xa123b77853fB3A2B621c57E5AC6dd8A3b6254f61`): a lying UserOp is included but refused by the vault, an oversized one too, an honest one commits; seven attacks (token transfer, owner functions, ETH, a bundler tip, huge gas, a stranger's signature) are refused by the account during validation.

| Standard | Status |
|---|---|
| ERC-4337 (account, EntryPoint v0.7) | Live and exercised on chain |
| ERC-8004 Identity Registry (Draft) | Live (the registry already on the chain) |
| ERC-721, EIP-712, ERC-1271, ERC-165, EIP-1193, EIP-6963 | Live |
| ERC-8004 Reputation and Validation, ERC-7579 / ERC-6900, ERC-7715, paymasters | Not built |

| Item | Value |
|---|---|
| AgentFactory | [`0xeA8407948e8BE12Ea2365d1BEdBADf364aadaaE0`](https://explorer.testnet.chain.robinhood.com/address/0xeA8407948e8BE12Ea2365d1BEdBADf364aadaaE0) (source verified) |
| ERC-8004 Identity Registry (already on the chain, run by a third party; its implementation source is not verified) | [`0x8004A818BFB912233c491871b3d84c89A494BD9e`](https://explorer.testnet.chain.robinhood.com/address/0x8004A818BFB912233c491871b3d84c89A494BD9e) |
| TokenFaucet (1,000 mUSDG per wallet per day) | [`0x4A349Eb630157881e9c39d2eEB0Aa5879Ca764FD`](https://explorer.testnet.chain.robinhood.com/address/0x4A349Eb630157881e9c39d2eEB0Aa5879Ca764FD) (source verified) |
| ERC-4337 EntryPoint v0.7 (already on the chain) | `0x0000000071727De22E5E9d8BAf0edAc6f37da032` |

## Uniswap v4 reference pool

A standard Uniswap v4 pool on the PoolManager already on Robinhood Chain Testnet, for two test tokens: mUSDG (the settlement test token) and tIP16P (a test token that stands for units of the case). Fee 0.3%, tick spacing 60, no hook; it opened at 10.99 mUSDG per unit. The earlier tIP16P / mUSDC pool is retired. It is a secondary reference venue. It is not the sealed-bid market, nothing connects it to BlindBook, it delivers no goods, and the test tokens have no redemption right. The v4-core files are copied unmodified; our two helper contracts are small, tested on a fork and unaudited. `GET /api/v4/pool` returns the price as JSON (read-only, cached 30 s). Details, addresses and limits: `v4-pool.md`.

| Item | Value |
|---|---|
| PoolManager (already on the chain) | [`0x8366a39CC670B4001A1121B8F6A443A643e40951`](https://explorer.testnet.chain.robinhood.com/address/0x8366a39CC670B4001A1121B8F6A443A643e40951) |
| mUSDG (currency0) | [`0x0B71c1B397A9d33198e0A6a5701E12011AC84D95`](https://explorer.testnet.chain.robinhood.com/address/0x0B71c1B397A9d33198e0A6a5701E12011AC84D95) (source verified) |
| Pool id (mUSDG / tIP16P) | `0xafede3281589f6c8d26792dc3bd81603bb9ccc5ea77ce2dd97f70dbcaf5d5a54` |
| tIP16P (test token) | [`0x8875C482eC20c82bE0f62c16d6F94B92a6050a2A`](https://explorer.testnet.chain.robinhood.com/address/0x8875C482eC20c82bE0f62c16d6F94B92a6050a2A) (source verified) |

## License

MIT, see [LICENSE](../LICENSE).

## Roadmap

- Link the market to buyer payment, escrow and delivery attestation by a named verifier (the target flow's steps 5 to 7)
- A runtime that makes a user-created agent search and bid by itself
- Settle sealed-batch clearing through a Uniswap v4 pool via a hook (the reference pool above is not that)
- Stylus re-verification of the economics
- LP vault so third parties can fund the mandate
- Oracle-signed or TLS-notarized price inputs
- A real stablecoin as the settlement token (the vault takes the token address as a constructor argument)
- Stock-token treasury view and holdings on Robinhood Chain
