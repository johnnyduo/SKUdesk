# Findings from the proofs

Nothing in `packages/contracts/src`, `apps/web/src` or `apps/web/worker` was changed by the proof work. The deployed contracts are immutable, so every BUG below that lives in a contract is handled by disclosure in the product copy, not by a code change.

- **BUG** means the code contradicts a stated claim or intent.
- **LIMITATION** means a real trust or scope boundary that must be disclosed.
- **PROPERTY** means correct behaviour that is easy to misread.

## Vault (SKUdeskCore / EconLib)

- **F-V1 BUG (vs the design intent "maximum loss ≤ dailySpendCap per UTC day").** The daily cap limits COMMITMENTS per UTC day, not CASH-OUT. Opportunities never expire: `mintLot` and `fundLot` have no time check (SKUdeskCore.sol:171-190, while the cap counts commits at 130-131). For any k ≥ 1, an agent that committed K = dailySpendCap on each of k days can mint, fund and `markPurchased` all of them in one block. That pays k·K·CENT base units to an allowlisted payee, bounded only by `free`. The agent can then still commit a fresh K the same day. So "max loss ≤ dailySpendCap per UTC day" is false. Lots can also be funded long after their quote TTL. Committed opportunities are not re-checked against later policy either: a `setPolicy` that lowers `maxExec`, raises `minMarginBps` or shortens `quoteTTL` does not apply to them. Only `pause` (which blocks `mintLot`, `fundLot` and `markPurchased`) or withdrawing the free funds (so `fundLot` reverts `InsufficientFree`) stops them. Test: `test_F_V1_BankedCommitmentsPayKCapsInOneBlock` (k = 5).
- **F-V2 PROPERTY.** Any 24 h window holds at most 2K of commitments, and that bound is tight: commits of K at 86400j−1 and at 86400j are both accepted. A window of length Δ holds at most (⌈Δ/86400⌉+1)·K. Tests: `test_E5_MidnightAllowsExactlyTwoCapsInTwoSeconds`, `testFuzz_E5_RollingWindowNeverExceedsTwoCaps`, `invariant_E5_LotsAndCaps`.
- **F-V3 LIMITATION.** Replay protection is per (productHash, quoteHash, snapshotHash), and the agent picks snapshotHash. The same quote can therefore be committed N times; only the caps bound it (lines 122-123). Test: `test_F_V3` (20×).
- **F-V4 LIMITATION.** `observedAt` is agent-chosen. Setting it to `block.timestamp` always passes Stale (lines 121-125). Test: `test_F_V4` (year-old data accepted).
- **F-V5 LIMITATION.** `settle` proceeds are agent-chosen in [0, payer allowance], so realized P&L is agent-determined. Conservation still holds because only received tokens are credited (lines 207-218). Test: `test_F_V5`.
- **F-V6 PROPERTY.** An all-zero-cost quote is accepted with spend 0 and a lot funded with 0. Test: `test_F_V6`.
- **F-V7 LIMITATION.** `deposit` credits the nominal amount. With a fee-on-transfer token, custody breaks and the last withdraw fails (lines 100-104). Test: `test_F_V7` (1 % fee token).
- **F-V8 LIMITATION.** With the owner-mintable test token (mUSDC), the owner can push `totalDeposited` past 2^256 (deposit 2^255, withdraw, deposit again). `deposit` then panics 0x11. This is an owner self-DoS and unreachable with a real supply. Test: `test_F_V8`.
- **F-V9 PROPERTY.** `totalEscrow ≤ free` is not an invariant. `commit` never checks `free`, so an underfunded vault only makes `fundLot` revert `InsufficientFree` (liveness, not safety).
- **F-V10 PROPERTY.** `setPolicy` does not reset `spentToday`. Lowering the cap freezes commits until the next UTC midnight, so the per-day bound is the max cap in force. Test: `test_E5_LoweringTheCapMidDay...`.
- **F-V11 PROPERTY.** `cancel` and `refund` do not give back daily cap: `cancel` and `refund` leave `spentToday` unchanged (`SKUdeskCore.sol:130-135`, `:220-227`), and this is documented rather than changed.

## Economics mirror

- **F-E1 BUG (liveness, fail-closed).** The TS mirror equals EconLib only for `sellCents ≤ 9e11` (Theorem E7), but `MAX_FIELD` is 1e12. Counterexample: sell = 1e12, mktFeeBps = 9999. TS fee is 999,900,000,001; EconLib gives 999,900,000,000. `run-agent.ts:123` computes claims with the TS mirror, so the agent's honest claim gets `MathMismatch`. The earlier test vectors only went up to 1e9. Fix: use BigInt in the mirror, or cap `sellCents` at 9e11. **Resolved 2026-10-03 (TS only):** the mirror throws `RangeError('sellCents above 9e11 is outside the exact TS domain')` above 9e11. Tests: TS "F-E1" (9e11 exact, 9e11+1 raises, every unsafe vector raises).
- **F-E2 BUG (display semantics).** `maxBuy = purchase + mktFee + fulfill + ret + chain`. That is not the break-even purchase price, which is `purchase + net`. Hero case: 769 vs 851 (buying at 851 gives net 0; at 852 net −1). The `:0` clamp is dead code. Shown in `engine.ts:79` and `packages/agent/index.ts:12`. It is not used on-chain. **Resolved 2026-10-03 (display only):** `economics()` keeps `maxBuyCents` as the EconLib parity field and adds `breakEvenBuyCents = max(0, purchase + net)`, the exact break-even; `engine.ts` carries `breakEvenBuyCents` and the agent sketch says "break-even buy price". Tests: `econ.test.ts` (851; net 0 at 851, −1 at 852).
- **F-E3 LIMITATION.** TS `capitalCents` and `batchCents` are inexact above 2^53. Display only; the on-chain spend is exact.
- **F-E4 PROPERTY.** Rounded net is not monotone in sell: with m = r = 5000, sell 0→1 changes net 0→−1. It drops by at most 1 cent when m + r ≤ 1e4; the exact net is monotone.
- **F-E5 PROPERTY.** A margin of 0 for net < 0 overstates the exact negative margin, but `NonPositiveNet` always rejects first.

## BlindBook

- **F-B1 BUG (owner can confiscate bonds).** `reveal` is `live` but `clear` is not. If the owner pauses during the reveal window and keeps the pause until `revealEnd`, the bond of every order that was **still unrevealed** at that point (up to 24·bond per market-epoch) goes to the treasury at `clear`, and `withdrawTreasury` takes it. Orders revealed before the pause already got their bond back and are settled normally. This contradicts P9/P14 (lines 65-66, 97, 123, 182). Test: `test_F_B1`.
- **F-B2 LIMITATION (cheap DoS).** An attacker fills all 24 slots, then reveals harmless orders (buy 1 @ 1 tick). The bonds come back at reveal and the locks at clear, so the attacker ends with exactly its starting cash. The cost is gas plus tied-up capital: 24·bond during the commit phase, then 24·tick·CENT (the buy locks) from reveal to clear, so at most 24·max(bond, tick·CENT) at any time in an epoch. Honest traders get `BookFull`, so the forfeited-bond mitigation does not deter this (line 89). Test: `test_F_B2`.
- **F-B3 LIMITATION.** `issue` is unlimited and unbacked: the owner can sell minted units for real cash. Unit conservation holds only relative to `totalIssued`. Test: `test_F_B3`.
- **F-B4 LIMITATION.** The constructor accepts `commitEnd = 0` (dead market) and `bond = 0`. Test: `test_F_B4`.
- **F-B5 PROPERTY.** `clear` with a huge epoch panics 0x11 instead of `TooEarly`. Harmless. Test: `test_F_B5`.
- **F-B6 LIMITATION.** Early reveals are visible to later revealers, and a late revealer can move s*/b* to shift p* within the volume-maximal set.
- **F-B7 LIMITATION.** BlindBook's `deposit` also credits the nominal amount (same issue as F-V7).

## Test infrastructure

- **F-T1 BUG.** `Handler` (RobinizeV2.t.sol:315) and `BBHandler` (BlindBook.t.sol:277) inherit a public `setUp` that the fuzzer calls mid-run: 865 of 2560 and 1283 of 2560 calls. The new handlers have no `setUp`, restrict their selectors and assert activity in `afterInvariant`.
- **F-T2 LIMITATION.** The TS proof files were not in any npm glob; they needed adding to `scripts/verify-all.sh` stage 2. **Resolved 2026-10-03:** stage 2 now lists both files explicitly by path (`packages/economics/test/proofs.econ.test.ts` and `apps/web/src/lib/proofs.book.test.ts`); it uses no glob.
- **F-T3 BUG (resolved 2026-10-03).** Forge first replays a saved failing invariant sequence from `cache/invariant`. Such a replay can be a single call, and the activity floors in `afterInvariant` then failed even on correct code. The floors now apply only when the handler saw at least 50 calls, and the README's reproduce steps start with `rm -rf packages/contracts/cache/invariant`.
- **F-T4 BUG (resolved 2026-10-03).** Five guards that the theorems rely on were killed only by older unit tests, not by the proof suite: the `Replay` check, `consumed = true` in `mintLot`, `AlreadyRevealed`, the `price % tick` check and `AlreadyCleared`. The DailyCap `>` boundary was likewise covered only by unit boundary tests. The proof handlers now attack each guard and assert the exact revert, the E4 model covers checks 1-5 and the cap boundary, and every mutation in the README matrix is killed by the proof suite alone.

## What was proved with no finding

E1-E7 and C1-C7 as stated in `economics.md` and `clearing.md`, under the assumptions stated there (A1-A4 for the vault, A1-A3 for the book). These are hand-written proofs, each cross-checked by deterministic exhaustive enumeration on small domains plus fuzz and invariant tests on the full accepted domain, with the core mutations killed. They are not formally verified: no SMT solver, symbolic execution or proof assistant was used.

## How the product copy treats these (2026-10-03)

The contracts are deployed and immutable, so these are disclosed, not patched: F-V1/F-V2 (daily cap bounds commitments, up to 2× in a rolling day, not cash-out), F-V3 (replay per snapshotHash), F-V4 (agent-supplied `observedAt`), F-V5 (agent-chosen proceeds, pulled as real tokens from the payer), F-B1/F-B3 (owner powers: pause during reveal forfeits bonds, `issue` is unlimited). A contract revision that fixes F-V1 (expiry on `mintLot`/`fundLot`) and F-B1 (`clear` not forfeiting while paused) would need a redeploy and is out of scope for the current testnet build.
