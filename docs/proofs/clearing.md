# BlindBook clearing: proofs

Scope: `packages/contracts/src/BlindBook.sol` (commit, reveal, clear, cash and unit ledgers) and the TypeScript mirror `apps/web/src/lib/book.ts` (`clearBook`) plus the UI clock `apps/web/src/lib/market.ts` (`clockAt`).
Tests: `packages/contracts/test/ProofsClearing.t.sol` (Foundry) and `apps/web/src/lib/proofs.book.test.ts` (node). How to run: [README.md](README.md). Findings: [FINDINGS.md](FINDINGS.md).

**What kind of proof this is.** Each theorem below has a hand-written proof. Each one is cross-checked by deterministic exhaustive enumeration on small domains, plus fuzz and invariant tests on the full accepted domain, and the test suite kills the core mutations of the code (README, mutation matrix). This is **not** a formal verification: no SMT solver, symbolic execution or proof assistant was used.

---

## 1. The clearing rule as a mathematical statement

**Inputs** for one (market m, epoch e):
* the tick τ ≥ 1 (`listMarket`, immutable per market);
* an ordered list of n ≤ `MAX_ORDERS` = 24 orders (the index is commit order, which is the time priority);
* for each order, its trader and a `revealed` flag. A revealed order also has a side σᵢ ∈ {0 = buy, 1 = sell}, a price pᵢ ∈ τ·ℕ with 1 ≤ pᵢ ≤ 10⁶ (cents), and a size uᵢ ∈ [1, 10⁶] (BlindBook.sol:104-107);
* the fixed `bond` β (immutable).

Only revealed orders take part in matching. For a price p define

* demand D(p) = Σ { uᵢ : revealed, σᵢ = 0, pᵢ ≥ p } (non-increasing in p);
* supply S(p) = Σ { uᵢ : revealed, σᵢ = 1, pᵢ ≤ p } (non-decreasing in p);
* matched volume V(p) = min(D(p), S(p)), and V* = sup over p of V(p).

**What the contract computes** (`_best`, lines 142-156; `clear`, line 132):

* vmax = max of V(pᵢ) over the revealed prices pᵢ;
* if vmax > 0: lo = min and hi = max of the revealed prices whose V equals vmax, and then **p\* = τ·⌊⌊(lo + hi)/2⌋/τ⌋**;
* if vmax = 0: p\* = 0, and there are no fills.

**Allocation** (`_allocate`, lines 159-176). An order is *eligible* on the buy side if it is a revealed buy with pᵢ ≥ p\*, and on the sell side if it is a revealed sell with pᵢ ≤ p\*. Within each side, sort the eligible orders by the key (better price first: higher for buys, lower for sells; then lower index). Then fill greedily up to vmax:
fᵢ = min(uᵢ, vmax − Σ_{orders before i} f).
This is a partial fill at the margin. Every other order gets fᵢ = 0.

**Settlement** (`_settle`, lines 178-193):
* a buyer pays p\*·fᵢ·CENT out of its lock and gets the rest of the lock back;
* a seller receives p\*·fᵢ·CENT and gets uᵢ − fᵢ units back;
* a buyer receives fᵢ units;
* an unrevealed order forfeits β to the treasury.

---

## 2. Theorem C1: volume maximality and the tie rule

**Lemma C1.1 (the maximum is attained at a revealed price).** For every p: V(p) ≤ max over revealed prices pᵢ of V(pᵢ). Hence vmax = V*, whether p ranges over ℕ, over τℕ, or over ℝ.
*Proof.* Take p'. If no revealed price is ≤ p', then S(p') = 0 and V(p') = 0. Otherwise let p = the largest revealed price ≤ p' (on either side). No sell price lies in (p, p'], so S(p) = S(p'). D is non-increasing, so D(p) ≥ D(p'). Therefore V(p) ≥ V(p'). ∎

**Lemma C1.2 (the maximal set is an interval with revealed endpoints).** Suppose V* > 0 and let A = {p : V(p) = V*}. Then A = [s\*, b\*], where s\* is a revealed sell price, b\* is a revealed buy price, and s\* ≤ b\*. The contract's lo equals s\* and its hi equals b\*.
*Proof.* V ≤ V* everywhere, so A = {D ≥ V*} ∩ {S ≥ V*}.
D is a non-increasing step function that only drops just above a buy price. So {D ≥ V*} = (−∞, b\*], where b\* = max{p : D(p) ≥ V*}, and b\* is a revealed buy price.
Symmetrically, {S ≥ V*} = [s\*, ∞), and s\* is a revealed sell price.
A is non-empty because V* is attained (C1.1), so s\* ≤ b\*.
lo is the smallest revealed price in A. s\* is revealed and lies in A, and nothing in A is below s\*, so lo = s\*. In the same way hi = b\*. ∎

**Lemma C1.3 (each side fills exactly V*).** If vmax > 0, then Σ_{buys} fᵢ = Σ_{sells} fᵢ = vmax.
*Proof.* The eligible buy units add up to D(p\*) ≥ V*, and the eligible sell units to S(p\*) ≥ V* (p\* ∈ A, by Theorem C1 below).
Each iteration of the `while` loop marks one more order `taken` and lowers `remaining` by min(u, remaining). Suppose the loop stopped with `remaining > 0`. That can only happen because no eligible order was left. Then every eligible order was filled completely, so the fills add up to Σ eligible ≥ vmax, which is a contradiction. ∎

**Theorem C1.** Let vmax > 0.
1. vmax = V* (the matched volume is the maximum over **all** prices).
2. p\* ∈ A ∩ τℤ. So V(p\*) = V*, and p\* lies between lo and hi.
3. p\* is the unique element of A ∩ τℤ chosen by the tie rule "**the largest tick multiple ≤ (lo + hi)/2**". Every other element of A is equally volume-maximal; the rule is a convention that picks a symmetric middle point and rounds it down.
4. The fills are exactly the sorted-prefix allocation of §1. This is price-time priority: no better-priced or earlier order on a side is left (partly) unfilled while a worse one gets a fill.

*Proof.*
(1) is C1.1.
(3): for integers x ≥ 0 and a, b ≥ 1, ⌊⌊x/a⌋/b⌋ = ⌊x/(ab)⌋. So p\* = τ·⌊(lo + hi)/(2τ)⌋ = max{kτ ≤ (lo + hi)/2}.
(2): lo is a multiple of τ and lo ≤ (lo + hi)/2, so p\* ≥ lo. Also p\* ≤ (lo + hi)/2 ≤ hi. So p\* ∈ [lo, hi] = A (C1.2).
(4): each iteration scans indices in ascending order and replaces the current choice only on a **strictly** better price. So it picks the minimum of the key (price, then index) among the untaken eligible orders. It fills min(uᵢ, remaining), which is the greedy prefix. ∎

*Checked by:*
* `testFuzz_C1_C4_RealFlowMatchesTheOracleAndConserves` (1,000 runs through the **real** commit → reveal → clear path; 1-24 orders; ticks 1/2/5/10; about 1/8 of orders unrevealed).
* `test_C1_C4_SweepWithActivityFloor`: 400 books, of which a measured run gave 361 traded, 88 full (24-order) books, 325 partial fills, 746 forfeited orders, 39 no-trade books, 198 with lo < hi (the tie rule is used), and 126 with p\* rounded strictly below the midpoint.
* The oracle in both languages evaluates V at **every tick price** (not only the revealed ones) and allocates by **sorting**, which is independent of the contract's best-search loop.
* The stateful handler runs the oracle on every clear (`invariant_C4_UnitsOracleNoPanic`: `mismatches == 0`).

---

## 3. Theorem C2: uniform price and individual rationality

**Theorem C2.** Every fill happens at p\*:
* `_settle` uses p\* for both the cost and the proceeds;
* each `Fill` event carries p\*;
* a filled buyer has pᵢ ≥ p\* and pays p\*·fᵢ·CENT ≤ pᵢ·uᵢ·CENT, which is its lock, so the refund `lockedCash − cost` is ≥ 0 and cannot underflow;
* a filled seller has pᵢ ≤ p\* and receives p\*·fᵢ·CENT ≥ pᵢ·fᵢ·CENT;
* fᵢ ≤ uᵢ;
* unfilled orders get their whole lock (cash or units) back.

*Proof.* Eligibility (line 168) and §1. ∎

*Checked by:* the same fuzz test and sweep. Every `Fill` log is decoded and must show price = p\* and units = the oracle fill. Per order: `f ≤ units` and the limit check. Exhaustively in TS, over every book in §6.

---

## 4. Theorem C3/C4: cash, units and bonds are conserved; zero dust

Buckets:
* `totalFree` = Σₐ `cash[a]`;
* `totalLocked` (cash locked by revealed buys);
* `totalBonds`;
* `treasury`.

`accounted()` = totalFree + totalLocked + totalBonds + treasury (line 73).

**Theorem C4.** In every reachable state:

* (J1) Σₐ `cash[a]` = `totalFree`.
* (J2) `totalLocked` = Σ over uncleared (m, e) of Σ over revealed buys of `lockedCash` (= pᵢ·uᵢ·CENT).
* (J3) `totalBonds` = β · #{unrevealed orders in uncleared (m, e)}.
* (J4) `token.balanceOf(book)` = `accounted()`, under A1 (exact transfers), A2 (no direct donations) and A3 (no self-transfer: `withdrawTreasury(address(book))` is excluded, because it zeroes `treasury` while the tokens stay in the book). Without A2 or A3 it is ≥.
* (J5) for every market: Σₐ `unitsOf[m][a]` + `lockedUnitsTotal[m]` = `totalIssued[m]`.
* (J6) `lockedUnitsTotal[m]` = Σ over uncleared e of Σ over revealed sells of uᵢ.

*Proof.* By induction over the transitions. Reverts change nothing.

| Function | Δ cash / totalFree | Δ totalLocked | Δ totalBonds | Δ treasury | Δ token balance | units |
|---|---|---|---|---|---|---|
| `deposit(a)` | +a | | | | +a | |
| `withdraw(a)`, a ≤ cash | −a | | | | −a | |
| `commit` | −β | | +β (new unrevealed order) | | | |
| `reveal` buy (need = p·u·CENT ≤ cash) | −need + β | +need | −β | | | |
| `reveal` sell (u ≤ unitsOf) | +β | | −β | | | unitsOf −u, locked +u |
| `clear`: unrevealed order | | | −β | +β | | |
| `clear`: revealed buy | +(lock − p\*f·CENT) | −lock | | | | buyer +f |
| `clear`: revealed sell | +p\*f·CENT | | | | | locked −u, seller +(u − f) |
| `withdrawTreasury(to)`, to ≠ book (A3) | | | | −T | −T | |
| `issue(u)` | | | | | | unitsOf +u, totalIssued +u |

For one `clear`:
* Δaccounted = −p\*·CENT·Σ_{buys} f + p\*·CENT·Σ_{sells} f = 0, by C1.3.
* ΔΣunits = Σ_{buys} f + Σ_{sells}(u − f) − Σ_{sells} u = Σ_{buys} f − Σ_{sells} f = 0, again by C1.3.

The epoch is marked cleared **before** settling (line 129), so J2, J3 and J6 drop exactly the orders that were settled. Every other row keeps each invariant. ∎

**Corollary (zero dust).** Settlement contains only integer products and no division. So Σ(buyer payments) = p\*·CENT·vmax = Σ(seller receipts) **exactly**. The dust is 0, and nobody receives a rounding remainder. The only rounding in the mechanism is the choice of p\* (round down to the tick), which moves the price but not conservation.

**Corollary (bonds).** Each order's bond is either returned at its reveal, or forfeited to the treasury at the clear of its epoch. Never both, never neither (once cleared), and the amount is exactly β.

**Corollary (no double spend, no negative balance).**
* `clear` runs at most once per (m, e) (`cleared` flag, `AlreadyCleared`), and `_settle` touches each order once.
* An order is revealed at most once (`AlreadyRevealed`), so its lock is taken and its bond refunded at most once.
* No order can be committed into, or revealed in, an epoch that is already clearable (C7 freeze).
* So each lock is created at most once and released exactly once.
* Every subtraction is guarded: `cash ≥` checks (lines 78, 90, 110, 114). J2, J3 and J6 bound `totalLocked`, `totalBonds` and `lockedUnitsTotal` from below by the amounts removed. `lockedCash ≥ cost` holds by C2.

*Checked by:*
* `invariant_C4_CustodyAndBuckets`: J1, J4 with **equality** (the handler only withdraws the treasury to an outside address, A3), and J2/J3/treasury against ghost state.
* `invariant_C4_UnitsOracleNoPanic`: J5, J6, oracle on every clear, no Panic.
* `invariant_C4_DoubleRevealReclearOffTickRejectedExactly`: the preconditions of the no-double-spend corollary and of the input domain. After every successful reveal the handler repeats the identical reveal, which must revert with exactly `AlreadyRevealed()`. After every clear it clears again, which must revert with exactly `AlreadyCleared()`. In every `cycle` it commits an off-tick buy on a tick-5 market, whose reveal must revert with exactly `BadPrice(price, 5)`; that epoch then clears normally and forfeits exactly the one bond.

All three run 64 × 120 calls with a handler that has **no `setUp`**, and each pins `fail-on-revert = true` inline, so an unexpected handler revert fails the campaign. `afterInvariant` requires commits, reveals, clears, trades, forfeits, rejected double reveals, rejected re-clears and rejected off-tick reveals in every run of normal length (≥ 50 handler calls; README explains why a replayed failing sequence is exempt).

The per-trader **exact** cash and unit deltas, treasury = β·forfeits and `sumCash + forfeits·β == 0` (zero dust) are checked in every fuzz book and sweep book. `test_C6_ExhaustiveWithUnrevealedOrdersEqualsOracle` asserts that, after clear, every lock and bond is released (`totalBonds = totalLocked = lockedUnitsTotal = 0`).

---

## 5. Theorem C5: termination and gas bound

**Theorem C5.** `clear` terminates. Counting loop-body executions (inner scans included):
* `_best`: n² (the nested scan) + n (the lo/hi scan);
* `_allocate`: each `while` iteration scans all n orders. On one side, every iteration except the last marks a new eligible order of that side taken, and the last may be a final unsuccessful scan (`!found`). So a side with kₛ eligible orders runs at most kₛ + 1 iterations, and k₀ + k₁ ≤ n gives at most (n + 2)·n = n² + 2n for both sides;
* `_settle`: n.

The tight total is 2n² + 4n, which is **1,248** for n = 24 (enforced at `commit`, line 89). The earlier per-side count, 3n² + 2n = 1,776, ignored the final unsuccessful scan but is still a valid (looser) upper bound, since (n + 2)·n ≤ 2n² for n ≥ 2.

*Checked by:* `test_C5_FullBookWorstCasesClearInsideTheBudget`. Two worst shapes: 12×12 all crossing and filling, and 23 buys × 1 sell. A measured run gave 1,737,179 and 1,763,305 gas. The test asserts < 5,000,000.

---

## 6. Theorem C6: the TypeScript mirror equals `BlindBook.clear`

**Algorithm identity** (`book.ts:9-38` vs `BlindBook.sol:142-176`):

| Step | TypeScript | Solidity |
|---|---|---|
| liveness | `revealed !== false` | `revealed` |
| V at each revealed price | `vs = orders.map(...)` with the same `>=` / `<=` sums | `_best` inner loop |
| vmax | `Math.max(0, ...vs)` | running max from 0 |
| lo, hi | min/max price over live orders with `vs[i] === volume` | the same |
| p\* | `Math.floor(Math.floor((lo+hi)/2)/tick)*tick` | `((lo+hi)/2/tick)*tick` |
| allocation | per side: strict-better scan, `Math.min(units, remaining)` | identical loop |

All TS values are integers below 24·10⁶ + 2·10⁶ < 2⁵³, so every operation is exact (Lemma F of economics.md for the two floors). So on the contract's input domain the outputs are identical. The TS code does not validate its inputs (tick multiples, bounds); inputs outside the domain are outside the theorem.

*Checked by* (three-way, Solidity = TS = oracle):
* TS exhaustive: **every** book of ≤ 4 orders over 5 tick prices × sizes 1-3 × 2 sides. That is 837,930 books per tick, for τ = 1 and τ = 3, against the oracle.
* TS exhaustive including unrevealed orders: every book of ≤ 3 orders over 32 shapes (33,824 books).
* `book-vectors-exhaustive.json` (generator `gen-book-exhaustive.mjs`, the same column format as the existing `book-vectors.json`): **all** 3,768 books of ≤ 3 orders over 3 prices × 2 sizes × 2 sides for τ ∈ {1, 2}. They are cleared by the **unchanged** contract code (through a harness that only writes the book into storage) in `test_C6_ExhaustiveVectorsSolidityEqualsTypeScriptEqualsOracle`. Each book must equal both the TS answer and the Solidity oracle. Forge checks only that the file has the complete enumeration's book **count** (3,768) and consumes every order. The node test checks that the committed file equals a fresh in-memory regeneration (`assert.deepEqual`), and byte identity is checked by re-running the generator and `git diff --exit-code` (README).
* Solidity-only exhaustive enumeration with unrevealed orders (2,379 books, τ = 2): `test_C6_ExhaustiveWithUnrevealedOrdersEqualsOracle`.
* The existing 400 random vectors (`BlindBookParityTest`) are re-checked against the oracle in TS.

Regenerate: `node packages/contracts/test/vectors/gen-book-exhaustive.mjs`.

---

## 7. Theorem C7: the schedule is a total partition; gating and freeze

The constructor requires `commitEnd < revealEnd < epochLen` (line 57), so L = `epochLen` ≥ 2. For t ≥ t0 (t0 is the deploy timestamp and block timestamps never decrease, so t < t0 cannot occur on chain):
* epoch(t) = ⌊(t − t0)/L⌋;
* off(t) = (t − t0) mod L ∈ [0, L);
* phase(t) = 0 if off < commitEnd, 1 if commitEnd ≤ off < revealEnd, 2 if revealEnd ≤ off < L.

**Theorem C7.1 (total partition).** [0, commitEnd), [commitEnd, revealEnd) and [revealEnd, L) are pairwise disjoint and their union is [0, L). So phase(t) is defined for every t ≥ t0, takes exactly one value, and has no gaps or overlaps. Also t0 + epoch·L ≤ t < t0 + (epoch + 1)·L. *Proof.* 0 ≤ commitEnd < revealEnd < L, and off ∈ [0, L). ∎ The commit window is empty when commitEnd = 0, which the constructor accepts (finding F-B4).

**Theorem C7.2 (gating).**
* `commit` succeeds only if phase = 0, and it always goes into epoch(t).
* `reveal(e, …)` succeeds only if epoch(t) = e and phase = 1.
* `clear(m, e)` succeeds only if t ≥ readyAt(e) := t0 + e·L + revealEnd.

**Theorem C7.3 (freeze).** If t ≥ readyAt(e), then no commit into e and no reveal for e can succeed at any t' ≥ t. So `clear` acts on a final order set.
*Proof.* t' ≥ readyAt(e) implies epoch(t') ≥ e. If epoch(t') = e, then off ≥ revealEnd and the phase is 2. If epoch(t') > e, a commit goes into a different epoch and a reveal for e fails the epoch check. ∎

**Liveness.** `clear` is permissionless and is **not** blocked by `pause`. `withdraw` is not blocked either. So any uncleared epoch with orders can be cleared by anyone after readyAt, with bounded gas (C5), which means every lock can always be released. Pausing does block reveals, though, and that makes pause a bond-confiscation tool (finding F-B1).

**UI clock.** `clockAt` (market.ts:22-27) returns the same epoch, phase and offset as the contract for every integer t ≥ t0. For t < t0 (clock skew) it returns a negative epoch, where the contract would revert.

*Checked by:*
* `testFuzz_C7_PhaseIsATotalPartitionForAnyValidSchedule` (2,000 random valid schedules and times).
* `testFuzz_C7_GatingFollowsThePhaseAndClearFreezesTheEpoch` (2,000 runs: exact revert payloads for reveal, commit and clear; after a clear, the order count is unchanged and a reveal reverts).
* TS `C7: clockAt…` (every integer second over 5 epochs of every schedule with L ≤ 12).
