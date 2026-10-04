<div align="center">

# SKUdesk

**Hire an AI agent with a budget it cannot exceed and numbers it cannot misreport.**

[![Live](https://img.shields.io/badge/live-skudesk.lol-d4ff00?style=flat-square&labelColor=0b0b0b)](https://skudesk.lol)
[![Chain](https://img.shields.io/badge/Robinhood_Chain_Testnet-46630-00e0b8?style=flat-square&labelColor=0b0b0b)](https://explorer.testnet.chain.robinhood.com/address/0x3799747B933Ed7FEfAd6097998749Fd95fCD8c2A)
[![Uniswap v4](https://img.shields.io/badge/Uniswap-v4-ff007a?style=flat-square&labelColor=0b0b0b)](docs/v4-pool.md)
[![ERC-8004](https://img.shields.io/badge/ERC--8004-agent_%23119-7c5cff?style=flat-square&labelColor=0b0b0b)](docs/agent-identity.md)
[![ERC-4337](https://img.shields.io/badge/ERC--4337-EntryPoint_v0.7-3b82f6?style=flat-square&labelColor=0b0b0b)](#tech-stack)
[![Foundry](https://img.shields.io/badge/Foundry-252_tests_passing-f59e0b?style=flat-square&labelColor=0b0b0b)](docs/proofs/README.md)
[![License](https://img.shields.io/badge/license-MIT-888?style=flat-square&labelColor=0b0b0b)](LICENSE)

<a href="https://skudesk.lol"><img src="assets/agent-trade.gif" alt="An AI agent proposes a trade, the contract re-derives the numbers and refuses a lie" width="100%"></a>

<sub>An agent trades a phone case under the contract's limits. It tries to claim $3.90 profit per unit; the contract derives $2.61 and reverts. Press **Watch AI trade** on <a href="https://skudesk.lol">skudesk.lol</a> to run it yourself.</sub>

</div>

---

## The idea

AI agents that spend money need limits, and every limit today still trusts the agent's own figures: its profit claim, its cost breakdown, even the spend it passes in.

SKUdesk removes that trust. The agent submits a quote of **11 integers**. The `SKUdeskCore` vault re-derives landed cost, fees, net profit, margin and spend **itself**, and reverts if the agent's claim differs by a single cent. The agent proposes, and the contract decides.

Around that core, agents compete on the same product: price feeds find offers, identity gates keep only the same SKU, and a **commit-reveal batch auction** (`BlindBook`) clears each round at **one uniform price**, on-chain.

> **Testnet prototype.** Everything runs on Robinhood Chain Testnet with a test token (mUSDG, no value). The contracts are source-verified, hand-proved and heavily tested, but not audited. See [what is real](#what-is-real).

## One run, in numbers

The hero product is an iPhone 16 Pro Clear MagSafe Case, one real agent run on chain.

| | |
|---|---|
| Buy | $5.90 + $0.42 shipping + $0.27 duty, tax and fees, landed **$6.59** per unit |
| Sell | **$10.99** per unit, 350 units |
| Net per unit | **$2.61** after marketplace fee, fulfillment and return reserve, margin **23.74%** against an 18% floor |
| Spend | **$2,306.50**, derived by the contract, under a $2,500 per-trade cap |
| Attempted lie | claimed net $3.90, contract derived $2.61: `MathMismatch(390, 261, ...)` reverts |
| Refused in total | 6 refused requests: inflated profit, replayed opportunity, stale data, bad quote hash, over the spend cap, unapproved payee |
| Transactions | 9 on chain (8 succeeded, 1 reverted by design) |
| Settled | **$913.50** counted on tokens actually received |

The settlement proceeds in this run were set by the run script, so $913.50 shows the accounting, not a market result.

## How it works

```mermaid
flowchart LR
  subgraph OFF["Off-chain · proposes, cannot move money"]
    FEEDS["Price feeds<br/>Google Shopping live · eBay, Best Buy adapters"] --> GATES["Identity gates<br/>same SKU, colour, form factor"]
    GATES --> AGENT["AI agent<br/>proposes one trade"]
  end
  subgraph ON["On-chain · Robinhood Chain Testnet 46630"]
    VAULT["SKUdeskCore<br/>re-derives net, margin, spend"]
    ESCROW["Lot escrow<br/>allowlisted payee only"]
    BOOK["BlindBook<br/>commit → reveal → clear"]
    V4["Uniswap v4 pool<br/>reference price"]
    ID["ERC-8004 identity<br/>ERC-4337 locked account"]
  end
  AGENT -- "commitOpportunity(quote, claimedNet)" --> VAULT
  VAULT -- "fundLot" --> ESCROW
  ESCROW -- "settle on tokens received" --> VAULT
  AGENT -. "registered as" .-> ID
  BOOK -. "clearing price" .-> V4
```

**A round in BlindBook** lasts 45 seconds: orders are hashes for the first 20 seconds, revealed until second 35, then one transaction clears the round at a single price. Buyers and sellers who trade all get that price; nobody is filled at a worse one.

## The math

Every formula below is implemented in `EconLib.sol` / `BlindBook.sol`, mirrored in TypeScript, and proved in [`docs/proofs`](docs/proofs/README.md).

### Vault: the contract re-derives the economics

A quote is $q=(p,s,d,t,f_1,f_2,S,m,F,r,C)$: purchase, shipping, duty, tax, processing and payment fees, sell price, marketplace fee (bps), fulfillment, return reserve (bps), chain cost. Amounts are integer cents.

$$L=p+s+d+t+f_1+f_2$$

$$M=\left\lceil\frac{S\,m}{10^{4}}\right\rceil,\qquad R=\left\lceil\frac{S\,r}{10^{4}}\right\rceil$$

$$N=S-M-F-R-L-C,\qquad B=\left\lfloor\frac{10^{4}\,N}{S}\right\rfloor$$

Fees round **up** (they are costs) and margin rounds **down** (it is profit), so rounding can never flatter the agent. Multiplication always comes before division.

The contract derives the spend itself, $\text{spend}=L\cdot u$ for $u$ units, and accepts a commitment only if all of these hold:

$$\text{claimedNet}=N\ \wedge\ N>0\ \wedge\ B\ge B_{\min}\ \wedge\ L\,u\le K_{\text{trade}}\ \wedge\ \text{spent}_{\text{day}}+L\,u\le K_{\text{day}}\ \wedge\ t-t_{\text{obs}}\le \tau_{\text{ttl}}$$

The hero lot: $L=590+42+12+8+5+2=659$, $M=\lceil 1099\cdot800/10^4\rceil=88$, $R=\lceil 1099\cdot200/10^4\rceil=22$, $F=65$, $C=4$, so

$$N=1099-88-65-22-659-4=261\ \text{cents},\qquad B=\left\lfloor\tfrac{261\cdot10^4}{1099}\right\rfloor=2374\ \text{bps}=23.74\%,\qquad \text{spend}=659\cdot350=\$2{,}306.50$$

Proven properties (E1 to E7):

- **No overflow** on the whole accepted domain: every intermediate value stays below $6\cdot10^{25}$, far under $2^{255}$.
- **Custody conservation** in every reachable state, with free funds $F$, escrow $E$, paid out $O$, deposited $D$, proceeds $P$, withdrawn $W$:

$$F+E+O=D+P-W$$

- **Rolling cap**: any 24-hour window holds at most $2K_{\text{day}}$ of commitments, and the bound is tight; a window of length $\Delta$ holds at most $\left(\lceil\Delta/86400\rceil+1\right)K_{\text{day}}$.
- **TypeScript equals Solidity** for every sell price up to $9\cdot10^{11}$ cents; above that the mirror refuses instead of disagreeing.

### BlindBook: uniform-price batch clearing

With revealed orders of side $\sigma_i$, limit price $p_i$ and size $u_i$, define demand, supply and matched volume at price $p$:

$$D(p)=\sum_{\sigma_i=\text{buy},\ p_i\ge p}u_i,\qquad S(p)=\sum_{\sigma_i=\text{sell},\ p_i\le p}u_i,\qquad V(p)=\min\bigl(D(p),S(p)\bigr)$$

Let $[lo,hi]$ be the set of prices where $V$ reaches its maximum $V^{*}$, and $\tau$ the market's tick size. The round clears at

$$p^{*}=\tau\left\lfloor\frac{lo+hi}{2\tau}\right\rfloor$$

Orders fill greedily by price then arrival order. Proven (C1 to C7):

- $V(p^{*})=V^{*}$: the cleared volume is the maximum over **all** prices, not only revealed ones.
- **Individual rationality**: no buyer pays above their limit, no seller receives below theirs.
- **Zero dust**: both sides fill exactly $V^{*}$, so buyers pay $p^{*}V^{*}$ and sellers receive $p^{*}V^{*}$.
- The TypeScript clearing mirror equals the contract on **837,930 exhaustive books per tick size**, plus 33,824 books with unrevealed orders, checked against an independent brute-force oracle.

### Uniswap v4 reference price

The reference pool is read straight from `PoolManager` storage (`extsload` of `slot0`), no indexer:

$$P_{\text{token1/token0}}=\left(\frac{\text{sqrtPriceX96}}{2^{96}}\right)^{2},\qquad \text{stable per unit}=\left(\frac{2^{96}}{\text{sqrtPriceX96}}\right)^{2}$$

The pool opened at 10.99 mUSDG per unit with $\text{sqrtPriceX96}=\left\lfloor\sqrt{100\cdot2^{192}/1099}\right\rfloor$ (tick $-23972$).

**How these were checked.** Each theorem has a hand-written proof, exhaustive enumeration on small domains, fuzz and invariant tests on the full domain, and mutation testing: the proof suite alone kills 15 of 15 core mutations. It is not formal verification; no SMT solver or proof assistant was used. What the proofs found, including real limits of the deployed contracts, is listed in [`FINDINGS.md`](docs/proofs/FINDINGS.md).

## Tech stack

| Layer | What is used |
|---|---|
| **Uniswap v4** | `PoolManager` already on the chain; mUSDG / tIP16P pool, fee 0.3%, tick spacing 60, no hook; 22 vendored v4-core files byte-identical to upstream; price read via `extsload` at `GET /api/v4/pool` |
| **ERC-8004** | Identity Registry (ERC-721 based, behind an **ERC-1967** proxy); agent **#119** registered, and `AgentFactory` registers every new agent; the agent card lives on chain as a `data:` URI |
| **ERC-4337** | `AgentAccount`, a locked smart account on **EntryPoint v0.7** that can only call its vault; tested against the real EntryPoint runtime code copied from chain 46630 |
| **Wallet and signing standards** | ERC-20 (6-decimal settlement token), ERC-721, EIP-712 and ERC-1271 (`setAgentWallet` proof), ERC-165, EIP-1193 providers, **EIP-6963** wallet discovery, **EIP-3085** one-click "Add Robinhood Chain Testnet" |
| **Contracts** | Solidity 0.8.24, Foundry, `via_ir`; `SKUdeskCore`, `EconLib`, `BlindBook`, `OrderEscrow`, `AgentFactory`, `AgentAccount`, `AgentIdentityRegistry`, `TokenFaucet`, `MandateVault` |
| **Backend** | Cloudflare Worker (Wrangler 4) with KV, D1, Rate Limiting, Cron Triggers and Static Assets |
| **Web** | Astro 4, React 18 islands, viem, TypeScript executed natively by Node 22 |
| **Data and AI** | Google Merchant API v1, SerpApi (SearchApi.io as failover), eBay Browse and Best Buy Products adapters, Gemini `gemini-3.5-flash-lite` as the proposing agent |

**Not built:** ERC-8004 Reputation and Validation registries, ERC-7579 / ERC-6900 modules, ERC-7715 permissions, paymasters.

## Tour of the product

The sidebar walks six steps. Every page reads the same finished on-chain run plus live chain state.

### Landing

<img src="assets/screens/01-landing.png" alt="SKUdesk landing page" width="100%">

Agents compete on one product in sealed rounds. The hero steps through products with their buy and sell prices.

### 1 · Desk

<img src="assets/screens/02-desk.png" alt="Desk overview" width="100%">

The story in six steps, then the result: **$913.50** profit on 350 cases, with the arithmetic per unit. Five sub-pages go deeper:

<table>
<tr>
<td width="50%"><img src="assets/screens/09-opportunities.png" alt="Opportunities"><br><b>Opportunities.</b> The committed trade with every number it rests on, line by line.</td>
<td width="50%"><img src="assets/screens/10-lots.png" alt="Lots"><br><b>Lots.</b> The lot the contract created from that opportunity, from funded to settled.</td>
</tr>
<tr>
<td width="50%"><img src="assets/screens/11-transactions.png" alt="Transactions"><br><b>Transactions.</b> The ledger: function, block, gas, status and the vault balances after each step.</td>
<td width="50%"><img src="assets/screens/12-orders.png" alt="Orders"><br><b>Orders.</b> Buyer payment, seller bond and a named verifier's delivery statement on <code>OrderEscrow</code>.</td>
</tr>
<tr>
<td width="50%"><img src="assets/screens/13-radar.png" alt="Radar"><br><b>Radar.</b> The price snapshot with the hash committed on chain; rejected offers are struck through.</td>
<td></td>
</tr>
</table>

### 2 · Agent trade

<img src="assets/screens/03-agent-trade.png" alt="Agent trade walkthrough" width="100%">

A guided replay of the finished run: mandate, agent reasoning, identity gates, contract commit, refusals, settlement. On open it re-checks all 9 transactions against the public RPC.

### 3 · Agent market

<img src="assets/screens/04-market.png" alt="BlindBook market terminal" width="100%">

The BlindBook terminal: round clock, sealed order slots, last clearing price and a price chart, all from chain events. Bots provide the liquidity and only trade while someone is watching.

### 4 · Deploy agent

<img src="assets/screens/05-deploy-agent.png" alt="Deploy your agent" width="100%">

Connect a wallet, take test tokens from the faucet, set a budget and create an agent in one transaction: a spending vault, a locked ERC-4337 account and an ERC-8004 identity.

### 5 · Limits

<img src="assets/screens/06-limits-cheat.png" alt="Try to cheat the agent" width="100%">

**Try to cheat the agent.** Change any number and the page sends it to the deployed contract as a read-only call. Here the agent claims $3.90 and the contract answers `REVERTED`.

<table>
<tr>
<td width="50%"><img src="assets/screens/07-owner-console.png" alt="Owner console"><br><b>Owner console.</b> Fund the vault, set the mandate, pause with one press. Transactions come from the owner's own wallet.</td>
<td width="50%"><img src="assets/screens/08-agent.png" alt="Agent flow"><br><b>Agent.</b> The off-chain proposal on top, the on-chain enforcement below, stepped through the six phases of the run.</td>
</tr>
</table>

### 6 · Proof

<table>
<tr>
<td width="50%"><img src="assets/screens/14-run-metrics.png" alt="Run metrics"><br><b>Run metrics.</b> Duration, model latency and gas per transaction, including the refused one.</td>
<td width="50%"><img src="assets/screens/15-contracts.png" alt="Contracts"><br><b>Contracts.</b> Every deployed address with its constructor arguments and a source-verified link.</td>
</tr>
<tr>
<td width="50%"><img src="assets/screens/16-dependencies.png" alt="Dependencies"><br><b>Dependencies.</b> Which integrations are live and which read NOT CONNECTED.</td>
<td></td>
</tr>
</table>

### Pitch deck

<img src="assets/screens/17-deck.png" alt="Pitch deck" width="100%">

The deck at [skudesk.lol/deck](https://skudesk.lol/deck/) covers the product and the six steps in 11 slides.

## On-chain

All on Robinhood Chain Testnet (chain id 46630), RPC `https://rpc.testnet.chain.robinhood.com`.

| Contract | Address |
|---|---|
| SKUdeskCore (vault) | [`0x3799747B933Ed7FEfAd6097998749Fd95fCD8c2A`](https://explorer.testnet.chain.robinhood.com/address/0x3799747B933Ed7FEfAd6097998749Fd95fCD8c2A) |
| BlindBook (sealed-bid auction) | [`0x8b4dFd26ab2A7Bdfd2090e434bcfB2C10A296E5d`](https://explorer.testnet.chain.robinhood.com/address/0x8b4dFd26ab2A7Bdfd2090e434bcfB2C10A296E5d) |
| OrderEscrow | [`0x8b4BBad117aD6a0D85D9b48Ed5526Bde9BF4Eb59`](https://explorer.testnet.chain.robinhood.com/address/0x8b4BBad117aD6a0D85D9b48Ed5526Bde9BF4Eb59) |
| AgentFactory | [`0xeA8407948e8BE12Ea2365d1BEdBADf364aadaaE0`](https://explorer.testnet.chain.robinhood.com/address/0xeA8407948e8BE12Ea2365d1BEdBADf364aadaaE0) |
| TokenFaucet | [`0x4A349Eb630157881e9c39d2eEB0Aa5879Ca764FD`](https://explorer.testnet.chain.robinhood.com/address/0x4A349Eb630157881e9c39d2eEB0Aa5879Ca764FD) |
| mUSDG (Test USDG, no value) | [`0x0B71c1B397A9d33198e0A6a5701E12011AC84D95`](https://explorer.testnet.chain.robinhood.com/address/0x0B71c1B397A9d33198e0A6a5701E12011AC84D95) |
| Uniswap v4 PoolManager (pre-existing) | [`0x8366a39CC670B4001A1121B8F6A443A643e40951`](https://explorer.testnet.chain.robinhood.com/address/0x8366a39CC670B4001A1121B8F6A443A643e40951) |
| ERC-8004 Identity Registry (pre-existing, agent #119) | [`0x8004A818BFB912233c491871b3d84c89A494BD9e`](https://explorer.testnet.chain.robinhood.com/address/0x8004A818BFB912233c491871b3d84c89A494BD9e) |
| ERC-4337 EntryPoint v0.7 (pre-existing) | [`0x0000000071727De22E5E9d8BAf0edAc6f37da032`](https://explorer.testnet.chain.robinhood.com/address/0x0000000071727De22E5E9d8BAf0edAc6f37da032) |

The vault source is `packages/contracts/src/SKUdeskCore.sol`. The deployed instance was verified on the explorer under its original name, `RobinizeCore`; the code is the same.

Uniswap v4 pool id: `0xafede3281589f6c8d26792dc3bd81603bb9ccc5ea77ce2dd97f70dbcaf5d5a54`.

Check it without trusting us, read-only, in [five minutes](docs/verify-in-5-minutes.md).

## What is real

| Piece | Status |
|---|---|
| Vault, escrow, reverts, BlindBook rounds and clearing prices | **On chain**, testnet |
| Agent run | A real Gemini run on a fixed price snapshot, replayed on `/show` |
| Google Shopping prices (SerpApi) | Live source; eBay and Best Buy read NOT CONNECTED until keys are set; Lazada and Shopee are integrated for demo purposes (fixed snapshot listings, no live API) |
| Market bidders | Six scripted bot wallets trading operator-issued test units, not tied to real stock |
| Purchase, receipt, listing, sale after escrow | **Agent-attested**; the run was paid from the owner's test wallet |
| Uniswap v4 pool | Real pool of two test tokens, no hook, not linked to BlindBook |
| Real buyers ordering real goods, agents that search and bid on their own after deploy | Not built |

Known limits of the deployed contracts (daily cap bounds commitments rather than cash-out, owner pause powers in BlindBook, agent-supplied snapshot hash) are measured and disclosed in [`docs/proofs/FINDINGS.md`](docs/proofs/FINDINGS.md) and [`docs/overview.md`](docs/overview.md).

## Run it

forge-std is a git submodule. Node 22.18 or newer is required.

```sh
git clone --recursive https://github.com/johnnyduo/SKUdesk && cd SKUdesk
npm install
(cd apps/web && npm run build)          # static site into apps/web/dist
(cd packages/contracts && forge test)   # 252 tests, fuzz and invariants included
node --test packages/economics/test/proofs.econ.test.ts apps/web/src/lib/proofs.book.test.ts
```

More: [`docs/overview.md`](docs/overview.md) (status and layout), [`docs/architecture.md`](docs/architecture.md) (trust boundaries), [`docs/proofs`](docs/proofs/README.md) (theorems), [`docs/v4-pool.md`](docs/v4-pool.md), [`docs/agent-identity.md`](docs/agent-identity.md), [`docs/order-escrow.md`](docs/order-escrow.md), [`docs/runbooks/worker-backend.md`](docs/runbooks/worker-backend.md).

## License

MIT, see [LICENSE](LICENSE).
