# Vault economics: proofs (EconLib + SKUdeskCore)

Scope: `packages/contracts/src/EconLib.sol`, `packages/contracts/src/SKUdeskCore.sol` (commit, lots, settle), and the TypeScript mirror `packages/economics/index.ts` (used by `apps/web/src/lib/engine.ts` and the agent in `apps/web/tools/run-agent.ts`).
Every theorem names the test that checks it. Test files:
`packages/contracts/test/ProofsEconomics.t.sol` (Foundry) and `packages/economics/test/proofs.econ.test.ts` (node). How to run them: [README.md](README.md). Findings: [FINDINGS.md](FINDINGS.md).

**What kind of proof this is.** Each theorem below has a hand-written proof. Each one is cross-checked by deterministic exhaustive enumeration on small domains, plus fuzz and invariant tests on the full accepted domain, and the test suite kills the core mutations of the code (README, mutation matrix). This is **not** a formal verification: no SMT solver, symbolic execution or proof assistant was used, so a mistake in a hand proof that the tests happen to miss is possible.

Notation: ⌊x⌋ floor, ⌈x⌉ ceiling, `a / b` in code is Solidity's integer division (floor for non-negative operands). ℕ includes 0. "Accepted domain" means the inputs that `_bounds` lets through (section 2).

---

## 1. Definitions (exact integer arithmetic)

### 1.1 Units

| Quantity | Unit | Type | Source |
|---|---|---|---|
| quote fields `purchase, ship, duty, tax, procFee, payFee, sell, fulfill, chain` | cents | `uint256` | `EconLib.Quote` (EconLib.sol:8) |
| `mktFeeBps`, `retBps`, margins | basis points (1 bps = 10⁻⁴) | `uint256` | same |
| `units` | items | `uint256` | `commitOpportunity` argument |
| vault balances (`free`, `escrow`, `totalEscrow`, `totalPaidOut`, `totalDeposited`, `totalWithdrawn`, `totalProceeds`) | token base units (6 decimals) | `uint256` | SKUdeskCore.sol:35-37 |
| `CENT` | 10⁴ base units per cent | constant | SKUdeskCore.sol:21 |

**Lemma U (cent conversion is exact).** A 6-decimal token has 10⁶ base units per dollar and 10⁶/10² = 10⁴ per cent, an integer. So converting cents to base units is the multiplication `c · 10⁴`, with no rounding. Converting back is never done by the contract (P&L is reported in base units).

### 1.2 The formulas (EconLib.sol:10-24)

Write the quote as q = (p, s, d, t, f₁, f₂, S, m, F, r, C), in struct order, so S = `sellCents`, m = `mktFeeBps`, F = `fulfillCents`, r = `retBps`, C = `chainCents`.

| Symbol | Code | Exact definition | Rounding |
|---|---|---|---|
| L (landed) | `landedOf` | L = p + s + d + t + f₁ + f₂ | none (sum) |
| M (marketplace fee) | `ceilDiv(S*m, 10000)` | M = ⌈S·m / 10⁴⌉ | **up** (cost) |
| R (return reserve) | `ceilDiv(S*r, 10000)` | R = ⌈S·r / 10⁴⌉ | **up** (cost) |
| N (net per unit) | `sell - mktFee - fulfill - ret - landed - chain` (int256) | N = S − M − F − R − L − C ∈ ℤ | none (exact signed) |
| B (`marginBps`) | `S == 0 \|\| N < 0 ? 0 : uint(N)*10000/S` | B = ⌊N·10⁴ / S⌋ if S > 0 and N ≥ 0, else 0 | **down** (profit) |
| breakeven | `landed + mktFee + fulfill + ret + chain` | L + M + F + R + C | inherits M, R |
| maxBuy | `breakeven > other ? breakeven - other : 0`, other = L − p | = p + M + F + R + C (always ≥ 0) | inherits M, R |
| spend (cents) | `r.landed * units` (SKUdeskCore.sol:128) | L·u | none |
| escrow amount (base units) | `spendCents * CENT` (SKUdeskCore.sol:184) | L·u·10⁴ | none (Lemma U) |

**Multiply before divide.** Both divisions take a full product first: `S*m` then `/10⁴` (fees), `N*10000` then `/S` (margin). Dividing first (for example ⌊N/S⌋·10⁴) would lose up to 10⁴ − 1 bps; the code never does that.

**Lemma C (ceil identity).** For a ∈ ℕ, b ≥ 1: ⌊(a + b − 1)/b⌋ = ⌈a/b⌉.
*Proof.* Write a = qb + ρ, 0 ≤ ρ < b. If ρ = 0, (a + b − 1)/b = q + (b − 1)/b and the floor is q = ⌈a/b⌉. If ρ ≥ 1, a + b − 1 = (q + 1)b + (ρ − 1) with 0 ≤ ρ − 1 ≤ b − 2, so the floor is q + 1 = ⌈a/b⌉. ∎

**Closed form of maxBuy.** breakeven − other = (L + M + F + R + C) − (L − p) = p + M + F + R + C ≥ 0. So the `: 0` branch only fires when that sum is 0, where both branches give 0. This is **not** the largest purchase price that breaks even (that is p + N): see finding F-E2. Checked: `_checkExact` (E1 vii) in `testFuzz_E1_E2_...`, and `F-E2` in `proofs.econ.test.ts`.

---

## 2. Theorem E2: overflow-freedom on the accepted domain

**Bounds the contract actually enforces** (`_bounds`, SKUdeskCore.sol:141-154, called at line 126, **before** `EconLib.quote` at line 127):

* `1 ≤ units ≤ MAX_UNITS = 10⁹` (else `BadUnits`),
* each of the 9 cent fields ≤ `MAX_FIELD = 10¹²` (else `OutOfBounds(name, value)`),
* `mktFeeBps, retBps ≤ MAX_BPS = 10⁴` (else `OutOfBounds`).

Policy values (`dailySpendCap`, `maxExec`, `quoteTTL`) are arbitrary `uint256` chosen by the owner; `minMarginBps ∈ [100, 9000]` (`setPolicy`, line 91).

**Theorem E2.** On the accepted domain, no checked operation in `EconLib.quote` or `commitOpportunity` overflows or underflows and every `int256(...)` cast is exact. More precisely, with every field at its bound:

| Intermediate | Max value | vs 2²⁵⁵ ≈ 5.79·10⁷⁶ |
|---|---|---|
| S·m, S·r | 10¹²·10⁴ = 10¹⁶ | safe |
| S·m + 9999 | < 1.0001·10¹⁶ | safe |
| L | 6·10¹² | safe |
| M, R | ≤ S ≤ 10¹² (as m, r ≤ 10⁴) | safe |
| N | −10¹³ ≤ N ≤ 10¹² | safe; casts of values ≤ 6·10¹² are exact |
| N·10⁴ (only when N ≥ 0, so N ≤ S) | 10¹⁶ | safe |
| breakeven | 10¹³ | safe |
| other = L − p | ≥ 0 since L ≥ p | no underflow |
| spend = L·u | 6·10¹²·10⁹ = 6·10²¹ | safe |
| spend·CENT | 6·10²⁵ | safe |

The remaining arithmetic in the vault:

* `block.timestamp - observedAt` (line 124): guarded by `FutureObservation` (line 121).
* `spentToday + spend` (line 131): `spentToday` only grows by accepted spends (≤ 6·10²¹ each), so overflowing it needs more than (2²⁵⁶ − 6·10²¹)/(6·10²¹) > 10⁵⁵ accepted commits in one UTC day: unreachable.
* `free -= amount` (fundLot, line 188) guarded by line 186; `free -= amount` (withdraw) guarded by line 106; `escrow[lot] -= amount` (markPurchased) guarded by line 195.
* `totalEscrow -= x` (lines 197, 215, 230): by invariant I_esc (Theorem E6) `totalEscrow = Σ escrow[lot] ≥ escrow[lot] ≥ x`.
* `received = after - before` (line 213): a standard token's `transferFrom(from, core, x)` never lowers core's balance.
* `free += …`, `totalEscrow += …`: bounded by custody (E6), `free + totalEscrow ≤ balanceOf(core) ≤ totalSupply < 2²⁵⁶`.
* The four **cumulative** counters (`totalDeposited`, `totalWithdrawn`, `totalProceeds`, `totalPaidOut`) only grow. They overflow only after a cumulative flow of 2²⁵⁶ base units. With a real stablecoin that is unreachable. With the owner-mintable test token (mUSDC) the owner can do it to themselves (deposit 2²⁵⁵, withdraw, deposit 2²⁵⁵ again), after which `deposit` panics: finding **F-V8** (self-DoS, owner only).

**Corollary E2 (the complete revert set).** Assume (A1) the token is a standard ERC-20 whose `transfer`/`transferFrom` either revert or return a 32-byte `bool` (or return nothing) and whose `balanceOf` does not revert. On the accepted domain and below the F-V8 threshold, every revert of a vault function is one of the custom errors `Unauthorized, Paused, Reentrancy, BadQuoteHash, FutureObservation, Replay, Stale, OutOfBounds, BadUnits, SpendCap, DailyCap, MathMismatch, NonPositiveNet, MarginTooLow, UnknownOpportunity, OpportunityConsumed, InsufficientFree, PayeeNotAllowed, PayerNotAllowed, ExceedsEscrow, BadTransition, TransferFailed`, or a revert raised by the token's `balanceOf` (settle, line 211). `_push`/`_pull` use a low-level `call`, so a token revert, or a `false` return, becomes `TransferFailed`. There is no `Panic`.

Outside A1: if the token returns **malformed** data (non-empty but not an ABI-encoded `bool`, for example fewer than 32 bytes or a word other than 0 or 1), `abi.decode(d, (bool))` in `_push`/`_pull` reverts with **empty** revert data. That is neither a custom error nor a Panic, so the list above is complete only under A1.

*Checked by:*
`testFuzz_E1_E2_ExactDefinitionsOnTheWholeAcceptedDomain` (4,000 runs, all of the accepted box, through an external probe so that a revert would show).
`test_E2_AllCornersOfTheAcceptedBox`: all 2¹¹ = 2,048 corners, which is where overflow would happen.
`test_E2_ExtremeLifecycleHasNoPanic`: spend ≈ 5·10²⁰ cents, escrow ≈ 5·10²⁴ base units, through fund, purchase, settle; the all-maximum corner is a clean `NonPositiveNet`.
`testFuzz_E4_CommitEqualsTheDecisionModel` and `test_E4_DecisionModelSweepHitsEveryOutcome`: the exact revert payload, never a Panic.
`invariant_E2_E4_NoPanicNoAcceptedLie`: every revert in 76,800 random handler calls (4 invariants × 96 runs × 200 calls) is classified, and the Panic count must stay 0.
`test_F_V8_CumulativeCounterOverflowIsAnOwnerSelfDoS`: the one reachable Panic.

---

## 3. Theorem E1 (exact characterisation) and Theorem E3 (rounding is conservative, monotonicity)

**Theorem E1.** For every q in the accepted domain, `EconLib.quote(q)` returns exactly the values in the table of §1.2. Equivalently:
(i) `landed` = L;
(ii) M·10⁴ ≥ S·m > (M − 1)·10⁴;
(iii) the same for R;
(iv) N is the exact signed difference;
(v) if S > 0 and N ≥ 0 then B·S ≤ N·10⁴ < (B + 1)·S, otherwise B = 0;
(vi) 0 ≤ B ≤ 10⁴;
(vii) breakeven and maxBuy match their closed forms.
*Proof.* (i), (iv), (vi) and (vii) are the code read literally, with no overflow by E2. (ii) and (iii) follow from Lemma C. (v) is the definition of floor division. For (vi): N ≤ S because every term subtracted from S is ≥ 0, so N·10⁴/S ≤ 10⁴. ∎
*Checked by:* `testFuzz_E1_E2_...` (each item asserted separately, against an independent reference `Ref` that computes ceil as `q = a/b; if (a % b != 0) q++`).

Let the **exact (rational) net** be N* = S − S·m/10⁴ − F − S·r/10⁴ − L − C ∈ ℚ, and N₄ := 10⁴·N* ∈ ℤ.

**Theorem E3 (rounding never lets the agent claim better economics).** For every accepted q:
1. N ≤ N* < N + 2, that is, 10⁴N ≤ N₄ < 10⁴N + 2·10⁴.
2. If N > 0, then B ≤ N*·10⁴/S (the computed margin never exceeds the exact margin).
3. Hence, if the vault accepts q (N > 0 and B ≥ floor ≥ 100), the exact net is > 0 and the exact margin is ≥ the floor.

*Proof.*
(1) M ≥ S·m/10⁴ and R ≥ S·r/10⁴ (ceil), so N ≤ N*. Also M < S·m/10⁴ + 1 and R < S·r/10⁴ + 1, so N > N* − 2.
(2) B ≤ N·10⁴/S ≤ N*·10⁴/S by (1).
(3) N* ≥ N > 0. For the margin, N*·10⁴/S ≥ B ≥ floor. ∎

Clamp note. For N < 0 the code returns B = 0, which is **larger** than the exact (negative) margin. That clamp can never authorize anything: `NonPositiveNet` (line 133) rejects every N ≤ 0 before the margin check (line 134). This is finding F-E5, classified as a property.

**Theorem E3′ (monotonicity).**
(a) Raising any cost input (the 8 cost cent fields p, s, d, t, f₁, f₂, F, C, or m, or r) never raises N or B.
(b) If m + r ≤ 10⁴, then N₄ is non-decreasing in S, and N(S + 1) ≥ N(S) − 1.
(c) N is **not** monotone in S in general (rounding).

*Proof.*
(a) N is affine in each cent cost with coefficient −1. ⌈S·m/10⁴⌉ is non-decreasing in m. B is a non-decreasing function of N (the clamp is max(0, ·) followed by a floor).
(b) N₄(S + 1) − N₄(S) = 10⁴ − m − r ≥ 0. For the rounded values, ΔM = ⌈(S + 1)m/10⁴⌉ − ⌈Sm/10⁴⌉ ≤ ⌈m/10⁴⌉ ≤ 1 (subadditivity of ceil, and m ≤ 10⁴), and likewise ΔR ≤ 1. So ΔN = 1 − ΔM − ΔR ≥ −1.
(c) Counterexample: m = r = 5000, all costs 0. S = 0 gives N = 0. S = 1 gives M = R = 1 and N = −1. ∎

*Checked by:*
`testFuzz_E3_RoundingNeverOverstatesNetOrMargin` (4,000 runs).
`testFuzz_E3_NetAndMarginAreMonotoneInEveryCost` (4,000 runs).
`testFuzz_E3_SellPriceIsMonotoneUpToOneCent` (4,000 runs).
`test_E3_RoundedNetIsNotMonotoneInSell`.
TS: `E3: rounding never overstates…` (200,000 random BigInt cases).

---

## 4. Theorem E4: agent-lie rejection and the decision function of `commitOpportunity`

The checks run in this fixed order (SKUdeskCore.sol:115-139). The first one that fails is the revert:

1. `onlyAgent` → `Unauthorized`
2. `live` → `Paused`
3. `quoteHash == keccak256(abi.encode(q))` → `BadQuoteHash`
4. `observedAt ≤ now` → `FutureObservation`
5. `oppHash = keccak256(productHash, quoteHash, snapshotHash)` not seen before → `Replay`
6. `now − observedAt ≤ quoteTTL` → `Stale(age, ttl)`
7. bounds: `units`, then purchase, ship, duty, tax, procFee, payFee, sell, fulfill, chain, mktFeeBps, retBps → `BadUnits` / `OutOfBounds`
8. spend := L·u ≤ `maxExec` → `SpendCap(spend, maxExec)`
9. day rollover: if ⌊now/86400⌋ ≠ `dayNum`, then `spentToday` := 0. Then `spentToday + spend ≤ dailySpendCap` → `DailyCap`
10. `agentNet == N ∧ agentMarginBps == B` → `MathMismatch(agentNet, N, agentBps, B)`
11. N > 0 → `NonPositiveNet(N)`
12. B ≥ `minMarginBps` → `MarginTooLow(B, floor)`
13. effects: `spentToday += spend`; store `Opp(productHash, u, L, spend, N)`; emit; return (oppHash, B, N).

A revert undoes step 9's reset, so a rejected commit leaves no trace.

**Theorem E4 (soundness: no accepted lie).** If `commitOpportunity` returns, then `agentNet = N(q)` and `agentMarginBps = B(q)`, both computed on-chain from the very quote whose hash is `quoteHash`. In addition N > 0, B ≥ `minMarginBps`, L·u ≤ `maxExec`, and `spentToday` (after the call) ≤ `dailySpendCap`. *Proof.* Steps 3 and 8 to 12 are unconditional `revert`s on the negated conditions. ∎

**Corollary (a lie of ≥ 1 unit).** If `agentNet ≠ N` (for example N ± 1) or `agentMarginBps ≠ B` (for example B ± 1), the call reverts. It reverts with exactly `MathMismatch(agentNet, N, agentMarginBps, B)` iff checks 1-9 pass. Otherwise it reverts with the first failing earlier check (by design the on-chain tampering attempts are built to pass checks 1-9, so that `MathMismatch` is the error shown).

**Theorem E4 (completeness).** Given checks 1-9 pass and the claims are honest, the call succeeds iff N > 0 ∧ B ≥ `minMarginBps`. Together with steps 6-9: an honest quote is accepted iff TTL, bounds, both caps and both economics conditions hold.

**Scope (do not over-read).** E4 proves **arithmetic consistency** between the claim and the committed quote. It does not prove the quote is **true**. The agent chooses every input, including sell price, costs, `observedAt` and `snapshotHash`. An agent can always pass `MathMismatch` by reporting the true derived values of a fabricated quote. See findings F-V3 and F-V4, and the natspec "NOT enforced here" (SKUdeskCore.sol:17-18).

*Checked by:*
`testFuzz_E4_CommitEqualsTheDecisionModel` (3,000 runs). The model above is coded independently (`_expect`) and every outcome is compared on the exact revert payload, or on acceptance plus the stored state and return values.
The model `_expect` implements all 13 steps above, in order, including checks 1-5: a caller that is not the agent (`Unauthorized`), a paused vault (`Paused`), a tampered `quoteHash` (`BadQuoteHash(expected, got)`), `observedAt` in the future (`FutureObservation`) and a replay of an already accepted (productHash, quoteHash, snapshotHash) (`Replay(oppHash)`; the model keeps its own set of accepted opportunity hashes). It also generates DailyCap boundary cases: an honest quote whose spend is **exactly** what is left of today's cap (with `maxExec` equal to the spend) must be accepted, and the same quote one cent over must revert `DailyCap`. That pins the comparison to `>` (a `>=` would refuse the exact fill).
`test_E4_DecisionModelSweepHitsEveryOutcome`: 3,000 deterministic cases with midnight crossings. Every one of the 14 outcome classes must occur. The run is deterministic; it gives 605 accepted, 211 Stale, 186 BadUnits, 188 OutOfBounds, 459 SpendCap, 422 DailyCap, 300 MathMismatch, 39 NonPositiveNet, 7 MarginTooLow, 115 Unauthorized, 121 Paused, 127 BadQuoteHash, 99 FutureObservation and 121 Replay. 136 exact-cap fills were accepted and 149 cap + 1 cent cases refused. Lies that reach check 10 must be caught (300), and no lie may be accepted.
`testFuzz_E4_OffByOneLieIsRejected`: ±1 on net or margin gives exact `MathMismatch`, and the honest claim then passes.
`invariant_E2_E4_NoPanicNoAcceptedLie`: `liesAccepted == 0` across random sequences.
`invariant_E4_E5_ReplayAndDoubleMintRejectedExactly`: inside random sequences the handler replays accepted commits with their original `observedAt`, so checks 1-4 pass, and each replay must revert with exactly `Replay(oppHash)`.

---

## 5. Theorem E5: spend caps

Fix a policy. Let K = `dailySpendCap`, X = `maxExec`, D(t) = ⌊t/86400⌋ (UTC day; EVM time is UNIX time, so day boundaries are UTC midnights). Let 𝒞 be the set of accepted commits, each with time tᵢ and spend σᵢ = Lᵢ·uᵢ.

**(i) Per lot.** σᵢ ≤ X at commit time. A lot is minted only from an unconsumed opportunity (`mintLot`, lines 171-180, sets `consumed`), and inherits σ. Each opportunity hash is stored once (`Replay`, line 123), so it yields **at most one lot**, and Σ over lots of σ ≤ Σ over accepted commits of σ. `fundLot` escrows exactly σ·CENT (line 184). One lot can pay out at most its escrow (line 195), and `markPurchased` can run only once per lot (FUNDED → PURCHASED). So the payout of a lot is ≤ σ·CENT ≤ X·CENT.

**(ii) Per UTC day (constant K).** For every day d: S_d := Σ_{i∈𝒞, D(tᵢ)=d} σᵢ ≤ K.
*Proof (induction over accepted commits).* Invariant: after any accepted commit at day d, `dayNum = d` and `spentToday = S_d` so far. At the first accepted commit of day d, step 9 resets `spentToday` to 0 (dayNum ≠ d). Later ones add σ (step 13). Step 9 requires `spentToday + σ ≤ K`, so S_d ≤ K after every commit. ∎
With policy changes: `setPolicy` does **not** reset `spentToday`. So S_d ≤ max{K in force at the accepted commits of day d}. Lowering K below `spentToday` blocks all commits until the next UTC midnight; raising K mid-day allows more (property **F-V10**, test `test_E5_LoweringTheCapMidDayFreezesTheRestOfTheDay`).

**(iii) Rolling windows: the exact worst case is 2K, and it is attained.** For every window W = [τ, τ + 86400): Σ_{tᵢ∈W} σᵢ ≤ 2K. More generally, a window of length Δ holds at most (⌈Δ/86400⌉ + 1)·K.
*Proof.* W meets at most two UTC days (D(τ) and D(τ) + 1), and each contributes ≤ K by (ii). ∎
*Tightness:* commits of σ = K at t = 86400k − 1 and t = 86400k are both accepted, so 2K is committed within 2 seconds, and one more cent is refused on each side. This is a **property**, not a bug: the cap is stated "per UTC day, not per 24h" (`SKUdeskCore.sol:130-131` resets `spentToday` when the UTC day number changes). Finding F-V2.

**(iv) Cash-out is *not* bounded per day (finding F-V1).** Opportunities never expire: `mintLot` and `fundLot` have no time check. Nor are they re-checked against the current policy: lowering `maxExec`, raising `minMarginBps` or shortening `quoteTTL` with `setPolicy` does not affect opportunities that are already committed. Only `pause` (which blocks `mintLot`, `fundLot` and `markPurchased`) or withdrawing the free funds (so `fundLot` reverts `InsufficientFree`) stops them. The cap therefore bounds the **rate of commitments**, not the rate of payouts. What is true: total payouts to payees over the vault's life ≤ CENT·Σ_d S_d ≤ CENT·K·(number of days with commits). Within one block, an agent who banked commitments over k days can fund and pay **k·K·CENT** base units (bounded only by `free`), and can then still commit a fresh K that same day. This contradicts the design intent that "maximum loss is therefore ≤ dailySpendCap per UTC day". See FINDINGS F-V1.

**(v) "Total escrow ≤ free" is not an invariant, and not intended.** What holds is that every escrow was free at the moment it was funded (`fundLot` requires `amount ≤ free`, line 186), so `free` never goes negative. Funding all free gives `totalEscrow > free = 0`. `commitOpportunity` does not check `free` at all. An under-funded vault makes `fundLot` revert `InsufficientFree`: a liveness effect, never a safety one. The money invariants are the ones in E6.

*Checked by:*
`test_E5_MidnightAllowsExactlyTwoCapsInTwoSeconds` (tightness).
`testFuzz_E5_RollingWindowNeverExceedsTwoCaps` (1,000 random schedules, all windows).
`invariant_E5_LotsAndCaps` (per-lot cap, per-day sum, every rolling 24 h ≤ 2K after every step; the handler crosses midnight in every run of normal length, enforced by `afterInvariant`). It also checks the preconditions of (i): every lot's opportunity exists and is marked consumed, the lot's spend equals that opportunity's spend, at most one lot per opportunity (the handler's own ghost count, so a contract that forgets to mark an opportunity consumed is caught), and Σ lot spend ≤ Σ committed spend.
`invariant_E4_E5_ReplayAndDoubleMintRejectedExactly`: the handler mints every opportunity a second time, and each second mint must revert with exactly `OpportunityConsumed(oppHash)`.
`test_F_V1_BankedCommitmentsPayKCapsInOneBlock` (k = 5).
`test_E5_LoweringTheCapMidDayFreezesTheRestOfTheDay`.

---

## 6. Theorem E6: conservation (induction over every transition)

Let F = `free`, E = `totalEscrow`, O = `totalPaidOut`, D = `totalDeposited`, W = `totalWithdrawn`, P = `totalProceeds`, eₗ = `escrow[l]`, oₗ = `paidOut[l]`, σₗ = `lots[l].spendCents`.

**Theorem E6.** In every reachable state:
* (I_cons) F + E + O = D + P − W.
* (I_esc) E = Σₗ eₗ and O = Σₗ oₗ.
* (I_lot) for status CREATED: eₗ = oₗ = 0. For status ∈ {FUNDED, PURCHASED, RECEIVED, LISTED, SOLD, CANCELLED}: eₗ + oₗ = σₗ·CENT. For SETTLED or REFUNDED: eₗ = 0 and oₗ ≤ σₗ·CENT.

*Proof.* By induction over transactions. The constructor sets everything to 0. A reverted call changes nothing. The successful state changes:

| Function | ΔF | ΔE | ΔO | ΔD | ΔW | ΔP | per-lot |
|---|---|---|---|---|---|---|---|
| `deposit(a)` (100-104) | +a | | | +a | | | |
| `withdraw(a)` (105-110), a ≤ F | −a | | | | +a | | |
| `fundLot(l)` (183-190), CREATED→FUNDED, x = σₗ·CENT ≤ F | −x | +x | | | | | eₗ: 0 → x (it was 0: no function writes eₗ before FUNDED) |
| `markPurchased(l,·,a)` (193-200), FUNDED→PURCHASED, a ≤ eₗ | | −a | +a | | | | eₗ −a, oₗ +a |
| `settle(l,·,·)` (207-218), SOLD→SETTLED, ρ = received, λ = eₗ | +ρ+λ | −λ | | | | +ρ | eₗ → 0 |
| `refund(l)` (227-232), CANCELLED→REFUNDED, λ = eₗ | +λ | −λ | | | | | eₗ → 0 |
| `commitOpportunity`, `mintLot`, `markReceived/Listed/Sold`, `cancel`, `set*`, `pause` | 0 | 0 | 0 | 0 | 0 | 0 | status only |

Every row keeps (F + E + O) − (D + P − W) unchanged, and keeps E − Σeₗ and O − Σoₗ unchanged. For I_lot, `_move` (159-168) allows only the listed edges. Funding sets eₗ + oₗ = x. A purchase moves value between eₗ and oₗ. Settle and refund zero eₗ. ∎

**Theorem E6′ (custody).** Assume
* (A1) the token moves exactly the requested amount on `transfer`/`transferFrom` (no fee, no rebase);
* (A2) nobody sends tokens to the vault except through `deposit`/`settle`;
* (A3) the vault is not an allowlisted payee;
* (A4) the token has no transfer hooks: a token call runs no code of anyone else, so every vault transaction is atomic with respect to the vault.

Then `token.balanceOf(core) = F + E`. Without A2 or A3, `≥` holds instead.
*Proof.* Same induction, now with the token balance as a column. By A4 no other vault function runs in the middle of a transition, so each row of the table is one indivisible step. `deposit` and `settle` pull exactly a (A1, and `settle` measures `received` itself). `withdraw` and `markPurchased` push exactly a, and the pushed tokens leave the vault (A3). No other function moves tokens. ∎

**Reentrancy note (informal; the theorem assumes A4).** `markPurchased` follows checks-effects-interactions: it checks the payee and the escrow, moves the status and updates every counter before `_push`. `deposit` and `withdraw` also update state before their one token call. `deposit`, `withdraw`, `markPurchased` and `settle` share one `nonReentrant` lock, so none of them can be re-entered from a token call. The functions without the lock (`commitOpportunity`, `mintLot`, `fundLot`, `markReceived/Listed/Sold`, `cancel`, `refund`) are `onlyAgent`. Only the agent could re-enter them, and none of them moves tokens. The owner-only setters move no tokens either.

**A1 is required.** With a 1% fee-on-transfer token, `deposit(10⁶)` credits F = 10⁶ but only 990,000 arrive, and the final withdrawal fails (finding F-V7, test `test_F_V7_FeeOnTransferTokenBreaksCustody`). mUSDC satisfies A1.

**Corollary (no function lets free go negative).** F is `uint256`, so a negative value would be an underflow. Every decrease of F is guarded (lines 106, 186). Under E2 there is no Panic, so no sequence of calls reaches F < 0.

*Checked by:*
`invariant_E6_ConservationAndExactCustody`: I_cons, custody **with equality**, payee balance = O, payer outflow = P, I_esc. 96 runs × 200 calls. The handler has **no `setUp`** (the existing `Handler`/`BBHandler` inherit a public `setUp` that the fuzzer calls mid-run: 865 of 2,560 calls in the existing vault campaign. See FINDINGS F-T1).
`invariant_E5_LotsAndCaps` (I_lot).
`afterInvariant` requires that commits, rejected lies, funding, purchases, settles, refunds, midnight crossings, rejected replays and rejected second mints each happened in **every** run of normal length (≥ 50 handler calls; see README on replayed failing sequences). Every invariant pins `fail-on-revert = true` inline, so a handler call that reverts unexpectedly fails the campaign.
The extreme-value lifecycle in `test_E2_ExtremeLifecycleHasNoPanic`.

---

## 7. Theorem E7: TypeScript ↔ Solidity equivalence

**Formula identity.** `packages/economics/index.ts:9-29` is the same expression tree as EconLib.sol:10-24:

| Output | TypeScript | Solidity |
|---|---|---|
| landed | `purchase + inboundShip + importDuty + tax + procurementFee + paymentFee` | `purchase + ship + duty + tax + procFee + payFee` |
| fees | `ceilDiv(a,b) = Math.floor((a + b - 1) / b)` on `sell * bps` | `(a + b - 1) / b` on `sell * bps` |
| net | `sell - mktFee - fulfillment - ret - landed - chainCost` | same order, int256 |
| marginBps | `sell > 0 && net > 0 ? Math.floor(net*10000 / sell) : 0` | `sell == 0 \|\| net < 0 ? 0 : net*10000 / sell` (equal: at net = 0 both give 0) |
| breakeven, maxBuy | same sums and the same `>` clamp | same |

The only difference is the number type: IEEE-754 doubles instead of uint256/int256.

**Lemma F (floor of a double quotient).** For integers a ≥ 0, b ≥ 1 with a + b ≤ 2⁵³: `Math.floor(a / b)` = ⌊a/b⌋.
*Proof.* a and b are exactly representable. Write a = qb + ρ. If ρ = 0, a/b = q < 2⁵³ is exact and the correctly rounded division returns q. If ρ ≥ 1, the true quotient x = q + ρ/b lies in [q, q + 1 − 1/b]. Rounding is monotone and q, q + 1 are representable, so fl(x) ∈ [q, q + 1]. fl(x) = q + 1 would need q + 1 − x ≤ ½·ulp just below q + 1, which is ≤ (q + 1)·2⁻⁵³. But q + 1 − x ≥ 1/b, and 1/b > (q + 1)·2⁻⁵³ ⇔ b(q + 1) < 2⁵³. That holds because b(q + 1) = a − ρ + b ≤ a + b − 1 < 2⁵³. So ⌊fl(x)⌋ = q. ∎

**Theorem E7.** On the accepted domain restricted to S = `sellCents` ≤ 9·10¹¹ (the TS-safe region D_TS), `economics()` returns exactly EconLib's `landed, mktFee, ret, net, marginBps, breakeven, maxBuy`.
*Proof.* Every integer the TS code forms is below 2⁵³ ≈ 9.007·10¹⁵:
* S·m ≤ 9·10¹⁵;
* S·m + 9999 and (S·m + 9999) + 10⁴ ≤ 9·10¹⁵ + 19,999;
* sums ≤ 10¹³;
* N·10⁴ ≤ S·10⁴ ≤ 9·10¹⁵ (for N > 0, N ≤ S), and N·10⁴ + S ≤ 9.0009·10¹⁵.

So additions, subtractions and multiplications are exact, and both divisions meet Lemma F's premise. The expression trees are identical, so the values are identical. ∎

**Outside D_TS it fails (finding F-E1).** S = 10¹², m = 9999: S·m + 9999 = 9,999,000,000,009,999 is odd and > 2⁵³, so it rounds to …010,000. TS then returns M = 999,900,000,001, while EconLib returns 999,900,000,000. An agent that computes its claim with the TS library gets `MathMismatch` on an **honest** quote. This is fail-closed: a liveness bug, not a safety bug. **Resolution (2026-10-03):** `economics()` now throws `RangeError('sellCents above 9e11 is outside the exact TS domain')` for `sellCents > 9e11`, so the mirror refuses instead of returning a figure that is a cent off. `capitalCents`/`batchCents` (TS only) are inexact once L·u > 2⁵³ (finding F-E3, display only; the contract's `spend` is exact).

*Checked by* (three-way: TS = BigInt reference = Solidity):
* `gen-econ-vectors.mjs` builds 1,791 vectors from a BigInt implementation. Its independence from EconLib is in the **number type only**: it copies EconLib's ceiling formula `(a + b − 1) / b` and expression tree. So it catches every float/overflow difference, but it would share a semantic mistake in the formula. The semantic check of the ceiling is on the Solidity side: the `Ref` library computes it a different way (`q = a / b`, then +1 if a remainder is left), and `_checkExact` brackets each fee directly (M·10⁴ ≥ S·m > (M − 1)·10⁴). They include one-field sweeps over the domain edges from three baselines, ceil boundaries, 700 log-uniform full-domain cases, 700 realistic cases and 101 outside D_TS. Solidity: `test_E7_EconLibEqualsTheBigIntReferenceVectors` (all 1,791). TS: `E7: the TS mirror equals the BigInt reference…` (all 1,598 TS-safe ones; every unsafe vector must make the mirror raise `RangeError`). The node test checks that the committed file parses to exactly the same columns as a fresh in-memory regeneration (`assert.deepEqual`). Forge only checks that the file is not vacuous (> 1,500 vectors, > 50 outside D_TS, > 500 profitable). Byte identity is checked by re-running the generator and `git diff --exit-code` (README).
* Exhaustive small grid: 1,327,104 quotes (TS == BigInt on every output). Exhaustive ceil: all S ∈ [0, 150] × all m ∈ [0, 10⁴] (1,510,151 cases).
* 300,000 random quotes over D_TS, a third of them hugging S = 9·10¹¹.
* Lemma F: 10⁶ random cases with a + b within 2²⁰ of 2⁵³.
* `F-E1: sellCents = 1e12 ...` asserts the BigInt/EconLib fee 999,900,000,000, that the mirror raises `RangeError` at 1e12, and the boundary: 9e11 equals the reference, 9e11 + 1 raises.

Regenerate vectors: `node packages/contracts/test/vectors/gen-econ-vectors.mjs` (deterministic, seed 46631).
