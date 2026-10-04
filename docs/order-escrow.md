# OrderEscrow: one product, a named verifier

## What it is

`OrderEscrow` is a contract on Robinhood Chain Testnet (chain id 46630) that lets a buyer wallet order **one product** with the payment
locked on chain until delivery is attested. The product is the iPhone 16 Pro clear MagSafe case: BlindBook market
`CASE-IP16PRO-CLEAR-MAG-001`, with a fixed `SKU` hash fixed at deployment. Money is **mUSDG**, the project's testnet stand-in token (Test USDG, 6 decimals, no value).

The flow, with who acts at each step:

1. **Buyer funds.** `createOrder(qty, maxPriceCents, shipToHash, matchBy)` locks `maxPriceCents * qty * CENT` mUSDG (CENT = 10,000 base units).
2. **Buyer matches.** `matchOrder(id, epoch, index)` points at a cleared BlindBook round and one sell fill in it. The contract checks the
   evidence (see "What matching proves" below) and records the seller and the round price.
3. **Seller accepts.** `accept(id)` locks the seller's bond.
4. **Seller ships.** `ship(id, shipmentHash)` stores a hash. The contract does not check it.
5. **Verifier attests.** `attest(id, receivedSku, ok, receiptHash)`, called by the one named verifier address.
6. **Release.** The buyer calls `release(id)` (or anyone, after the dispute window). The seller receives `priceCents * qty * CENT`, the buyer
   gets back the difference to the cap, and the seller's bond is returned.

Every other path ends in a refund by a fixed rule or a timeout. Nothing is decided off chain except the verifier's answer.

## Trust model

| Party | What it can do | What you trust it for |
| --- | --- | --- |
| Verifier | One address, fixed at deployment. Says whether goods arrived (`attest`) and rules on disputes (`resolve`). | Honesty and availability. It is the only judge of delivery. |
| Seller | Locks a bond, accepts, ships. | Nothing on chain: the bond is the cost of walking away. |
| Buyer | Funds, picks the round, releases or disputes. | Nothing: the buyer's own cap is the price guard. |
| BlindBook | Read only. The escrow reads `cleared`, `results`, `orderCount`, `getOrder`, `epochStart`. | That its round data is what it says (it is deployed and immutable). |

Roles must differ: the verifier address cannot create an order, and the seller cannot be the buyer or the verifier address. Permissionless exits
pay only the entitled buyer or seller, never the caller. **The verifier address never receives funds directly. A verifier acting through another
address (as buyer or seller) can direct any outcome, including a seller's bond, to itself: the verifier is a trusted party.** Payouts are direct
token transfers, so tokens with callbacks or blocklists are unsupported; the contract uses mUSDG only, requires the token to be the one BlindBook
uses (`WrongToken`), and rejects a token that moves a different amount than asked (`TokenMismatch`).

### What matching proves, and what it does not

> A cleared BlindBook sell fill is used only as evidence that this seller offered at or below price P in a round that began at or after the buyer
> funded. It is not an allocation of goods: those units were already sold to the BlindBook buyer and are not redeemable. The units are
> operator-issued, so the operator controls who can become a seller, and a seller may also be a bidder in that round, so P is not an
> independent market price. The buyer chooses the round; the buyer's own cap (`maxPriceCents`) is the real price guard. The `consumed`
> counter only stops one fill from backing two escrow orders; consumed is counted within this escrow contract only. The seller's acceptance, the
> bond and the named verifier are the only guards on delivery.

Two consequences worth stating plainly. The price recorded on an order is the round's single clearing price, not the seller's own ask, so two
sellers in the same round are paid the same price per unit. And a fill's size is only a counter: a fill of 2 units can back two orders of 1 unit.

### The seller bond

`bondNeeded(id) = ceil(priceCents * qty * CENT * bondBps / 10000)`, readable only while the order is `OFFERED` (it reverts in any other state). The seller must have that much free (`bondFree`) when it accepts. The bond is
slashed to the buyer only when the seller accepted and never shipped (`refundUnshipped`) or the verifier rejected the delivery or ruled for the
buyer. It is never touched by a buyer who did not get an acceptance. The bond makes walking away cost something; it does not make the delivery true.

## States

| State | Meaning | Left by |
| --- | --- | --- |
| `NONE` | No such order. | |
| `FUNDED` | Payment locked, no seller chosen. | `matchOrder` (buyer), `cancel` |
| `OFFERED` | Seller and round price recorded; waiting for the seller. | `accept` (seller), `decline` (seller), `refundUnaccepted` |
| `MATCHED` | Seller accepted and locked a bond. | `ship` (seller), `refundUnshipped` |
| `SHIPPED` | Seller reported a shipment hash. | `attest` (verifier), `refundUnverified` |
| `DELIVERED` | Verifier attested delivery; the dispute window is open. | `release`, `dispute` (buyer), `release` by anyone after the window |
| `DISPUTED` | Buyer disputed inside the window. | `resolve` (verifier), `releaseUnresolved` |
| `RELEASED` | Terminal. Seller paid, buyer refunded the difference, bond returned. The `Released` event carries the reason (`ReleaseWhy`) and the caller. | |
| `CANCELLED` | Terminal. Funded order cancelled, full refund. | |
| `REFUNDED` | Terminal. Buyer refunded in full; the bond goes to the buyer or back to the seller depending on why (`Refunded.why`). | |

`Released.why`: `BUYER` (the buyer released), `TIMEOUT` (a stranger released after the dispute window), `VERIFIER_RULED` (`resolve(true)`), `UNRESOLVED` (the verifier stayed silent after a dispute, so `releaseUnresolved` paid the seller by default: a default, not a ruling).

`Refunded.why`: `UNACCEPTED` (offer withdrawn or lapsed, bond untouched), `DECLINED` (the seller called `decline`, bond untouched), `REJECTED` (verifier said no, bond to buyer), `VERIFIER_RULED` (dispute
decided for the buyer, bond to buyer), `UNSHIPPED` (accepted, never shipped, bond to buyer), `UNVERIFIED` (verifier silent, bond back to seller).

## Timeouts

Windows are set at deployment (each between 60 seconds and 30 days). The deployment this proof used reads them back from the contract; the
defaults of `DeployOrderEscrow.s.sol` are accept 900 s (15 min), ship 1800 s (30 min), verify 1800 s (30 min), dispute 600 s (10 min), resolve 900 s (15 min), bond 20%.

| Deadline | Set by | If it passes | Who may call |
| --- | --- | --- | --- |
| `matchBy` | the buyer, at creation (up to 30 days) | `cancel` works for a stranger too; the refund still goes to the buyer | anyone |
| `acceptBy` (accept window) | `matchOrder` | `refundUnaccepted`: full refund, the fill reservation is released, bond untouched | anyone |
| `shipBy` (ship window) | `accept` | `refundUnshipped`: full refund plus the seller's bond to the buyer; the fill stays consumed | anyone |
| `verifyBy` (verify window) | `ship` | `refundUnverified`: full refund to the buyer; the seller gets only its bond back | anyone |
| `releaseAfter` (dispute window) | `attest` | the buyer can no longer dispute; `release` works for anyone | anyone |
| `resolveBy` (resolve window) | `dispute` | `releaseUnresolved`: pays the seller exactly like `release` | anyone |

Each timeout call pays only the entitled buyer or seller, never the caller.

## What is NOT trustless

- **The verifier.** One address decides whether goods arrived. If it goes silent after a shipment, the seller loses the goods and gets the bond
  back. If it goes silent after a dispute, the seller is paid. If it lies, nothing on chain can tell.
- **The shipment.** `shipmentHash` is reported by the seller agent. The contract stores it and checks nothing against a carrier or the goods.
- **The ship-to.** Stored only as `keccak256(salt, address)` computed off chain. The salt and the address reach the seller off chain.
- **The price.** The BlindBook round is evidence, not a market price (see the quoted paragraph). The buyer's cap is the real guard.
- **The seller set.** BlindBook units are issued by the operator, so the operator controls who can be a seller.
- **The token.** mUSDG is a testnet stand-in; the operator can mint it.
- **The proof itself.** The recorded proof used script-controlled wallets and operator-issued test units. The deployer key played verifier,
  BlindBook owner and token owner. **No physical goods moved**: the delivery was attested by the verifier.

The proof does not exercise `decline`, `dispute`, `resolve`, `refundUnverified` or `releaseUnresolved`; the contract tests do.

Not built in this slice: a real supplier adapter, multiple products, partial fills, a shipping-cost oracle, seller inventory proof, bid privacy
after reveal, an encrypted channel for the ship-to, a real stablecoin.

## Run the proof

The proof needs the contract on chain first. The deployer key must be the verifier, the BlindBook owner and the mUSDG owner (it is all three
today). From `apps/web`:

```
# 1. After OrderEscrow is deployed, packages/contracts/deployments/orders-46630.json must exist (DeployOrderEscrow.s.sol writes it).
# 2. Check everything without sending anything:
node --env-file=../../.env tools/order-proof.ts --dry-run
# 3. Run it (a few minutes: one BlindBook round and two or three orders; the unshipped-timeout order is skipped when the ship window is over 20 minutes):
node --env-file=../../.env tools/order-proof.ts
#    Add --wait-timeout to also run the unshipped-timeout order (waits one full ship window, 30 minutes with the defaults).
# 4. Optional: refresh the saved logs later without running the proof again:
node --env-file=../../.env tools/order-snapshot.ts
```

Env: `ROBINHOOD_RPC`, `DEPLOYER_PRIVATE_KEY` (the verifier / owner key). `--eth 0.002` sets the gas sent to each wallet, `--skip-timeout`
skips the unshipped-timeout order, `--wait-timeout` runs it even when the ship window is long, `--guard 3` sets the seconds waited after a BlindBook phase boundary.

What it does, in order: refuses unless the chain is 46630 and the deployment file exists and matches the chain; generates four fresh wallets
(buyer, seller A, seller B, one bidder) into `apps/web/.env.proof-wallets.json`; sends each a little ETH and mints each mUSDG; the owner issues
units to both sellers; both sellers lock a bond; the buyer funds two or three orders **before** the round starts; in one BlindBook epoch the sellers
commit and reveal sells at different prices and the bidder commits and reveals a larger buy; it clears the round and asserts `filled >= qty`
before every `matchOrder`; order 1 goes to the cheaper filled ask and runs accept, ship, attest, release with payout, refund and bond checks;
order 2 is withdrawn by the buyer (`refundUnaccepted`); order 3 (only when the ship window is 20 minutes or less, or with `--wait-timeout`) is accepted and never shipped, and an unrelated wallet calls `refundUnshipped`
after the ship window. It writes `apps/web/src/data/orders.json`.

Keys and progress live in `apps/web/.env.proof-wallets.json` and `.env.proof-state.json`. Both match the `.env.*` rule in `.gitignore`, so they
are never committed, and the script never prints a key. Every transaction is recorded before its receipt is awaited: if the run stops, run the
same command again and finished steps are skipped. If the keeper is running, its bot orders share the hero market's round; the script handles
that (the round summary in `orders.json` says how many other orders were in it) and a missed round is retried in the next epoch, up to three.

## Verify on the explorer

Base URL: <https://explorer.testnet.chain.robinhood.com>. Every transaction in `orders.json` is `/tx/<hash>`.

1. Open the contract at `/address/<escrow>` (address in `orders.json` and `deployments/orders-46630.json`). Read `verifier()`: it is the
   operator address named on the page. Read `MARKET()`, `SKU()`, `bondBps()` and the five windows.
2. Read `getOrder(id)` for an order: status, buyer, seller, price, `funded`, `bondLocked`, hashes. Status numbers follow the table above.
3. Open an order's transactions in order and read the logs: `OrderCreated`, `Offered` (round, index, price), `Accepted`, `Shipped`, `Attested`,
   `Released` or `Refunded` with its reason.
4. Compare `Released.paid` with `priceCents * qty * 10,000` and `refundedToBuyer` with `funded - paid`. Check the mUSDG `Transfer` logs in
   the same transaction.
5. For the price evidence, open the BlindBook round: its `EpochCleared` log has the round price, and `getOrder(market, epoch, index)` on
   BlindBook shows the seller's fill. Remember what that evidence is and is not.
6. `consumedAt(epoch, index)` shows how many units of that fill back live or settled orders.

The page `/app/orders` shows the same data: it reads the saved snapshot and then the newest logs from the RPC, and falls back to the snapshot if
the RPC is unreachable.

## Recorded proof (2026-10-03, 16:52 to 16:54 UTC)

Escrow `0x8b4BBad117aD6a0D85D9b48Ed5526Bde9BF4Eb59` (source-verified; deploy block 128,256,841). Script `apps/web/tools/order-proof.ts`; every transaction hash is in `apps/web/src/data/orders.json`.

| Step | Result |
|---|---|
| Round | BlindBook epoch 102 cleared at one price, 11.20 mUSDG, 10 units; both seller agents were filled |
| Order 1 | Buyer funded 13.34 mUSDG (cap); matched to the cheaper winner; seller accepted and locked a 2.24 mUSDG bond; shipped (hash only); the verifier attested delivery; the buyer released |
| Order 1 payout | Seller +11.20 mUSDG; buyer refund +2.14 mUSDG (cap minus price); bond returned to the seller |
| Order 2 | Matched, then withdrawn by the buyer before acceptance (`refundUnaccepted`): full 13.34 mUSDG back, the fill reservation released |
| Escrow balance after | 5.336 mUSDG = the two sellers' free bonds, nothing stranded |

Not covered on chain by this run: the unshipped timeout (needs a 30 minute wait, pass `--wait-timeout`), `decline`, dispute and the other timeout exits. They are covered by the 70 Foundry tests. The proof wallets are script-controlled, the seller units are operator-issued, and no goods moved.

After a proof run, refresh the saved snapshot with `node --env-file=../../.env tools/order-snapshot.ts` (it reads from a few blocks behind the head; the proof script's own write can miss the last events).
