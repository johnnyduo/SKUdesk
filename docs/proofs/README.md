# Proofs of the money logic

* [economics.md](economics.md): vault economics. E1 exact formulas, E2 overflow-freedom, E3 rounding and monotonicity, E4 lie rejection and the decision function, E5 caps (including the 2× midnight bound), E6 conservation and custody, E7 TypeScript = Solidity.
* [clearing.md](clearing.md): BlindBook. C1 volume maximality and tie rule, C2 uniform price and individual rationality, C3/C4 conservation with zero dust and bonds, C5 termination and gas, C6 mirror equality, C7 the schedule partition and freeze.
* [FINDINGS.md](FINDINGS.md): everything the proofs revealed, classified as BUG, LIMITATION or PROPERTY.

## What kind of proof this is

Every theorem has a **hand-written proof**. Each proof is cross-checked in three ways:

* deterministic exhaustive enumeration on small domains;
* fuzz and invariant tests on the full accepted domain;
* mutation testing: the core mutations of the contract code are killed by the proof suite (matrix below).

This is **not** a formal verification. No SMT solver, symbolic execution or proof assistant was used. A wrong step in a hand proof could survive if no test exercises it. Each theorem also holds only under the assumptions it states (for example a standard ERC-20 token without fees or transfer hooks).

## Reproduce every check

All of these run locally and offline: no network, no keys, no deployment.

```sh
# Foundry. First delete saved failing sequences: forge replays them before a fresh campaign.
cd packages/contracts && rm -rf cache/invariant
# all proof tests (fuzz runs 1,000-4,000 per test, invariants 64-96 runs x 120-200 calls, fail-on-revert pinned inline)
forge test --match-path 'test/Proofs*'
# the whole suite (existing + proofs)
forge test

# TypeScript (run from the repo root; node >= 22 runs .ts directly)
node --test packages/economics/test/proofs.econ.test.ts apps/web/src/lib/proofs.book.test.ts
```

`scripts/verify-all.sh` stage 2 lists both TS proof files explicitly by path. It uses no glob (FINDINGS F-T2).

### The vector files

The vector files are deterministic. Regenerate them, then check that nothing changed:

```sh
node packages/contracts/test/vectors/gen-econ-vectors.mjs    # econ-vectors.json (BigInt reference, 1,791 vectors)
node packages/contracts/test/vectors/gen-book-exhaustive.mjs # book-vectors-exhaustive.json (all 3,768 books of <= 3 orders)
git diff --exit-code -- packages/contracts/test/vectors/     # byte-identical: no output, exit 0
```

What checks what:

* **Forge** only checks the vector files' size. `econ-vectors.json` must have more than 1,500 vectors (and more than 50 outside the TS-safe region, more than 500 profitable). `book-vectors-exhaustive.json` must have exactly 3,768 books, with every order consumed. Forge never regenerates the vectors.
* **The node tests** compare the committed files with a fresh in-memory regeneration (`assert.deepEqual` on the parsed JSON). This check is semantic, not byte for byte.
* **Byte identity** is shown only by the `git diff --exit-code` step above.

### Replayed failing sequences

When an invariant fails, forge saves the failing call sequence under `cache/invariant`. On the next run it **replays that sequence first**, before any fresh campaign. A replay can be a single call. The `afterInvariant` activity floors (for example "every run settled a lot") therefore apply only when the handler saw at least 50 calls. A replay then reports the original failure, not a spurious floor failure (FINDINGS F-T3). Delete `cache/invariant` to start clean.

## Test map

| Theorem | Foundry (`packages/contracts/test/`) | TypeScript |
|---|---|---|
| E1, E2 | `ProofsEconomics.t.sol`: `testFuzz_E1_E2_*`, `test_E2_*`, `invariant_E2_E4_*` | — |
| E3 | `testFuzz_E3_*`, `test_E3_*` | `proofs.econ.test.ts`: `E3: …` |
| E4 | `testFuzz_E4_*`, `test_E4_DecisionModelSweepHitsEveryOutcome` (all 13 checks, 14 outcome classes, DailyCap boundary), `invariant_E4_E5_ReplayAndDoubleMintRejectedExactly` | — |
| E5 | `test_E5_*`, `testFuzz_E5_*`, `invariant_E5_LotsAndCaps` (incl. one lot per opportunity), `invariant_E4_E5_*` | — |
| E6 | `invariant_E6_ConservationAndExactCustody`, `ProofsCustodyAssumptionsTest` | — |
| E7 | `test_E7_EconLibEqualsTheBigIntReferenceVectors` | `E7 …` (vectors, exhaustive grids, 300k random, Lemma F) |
| C1-C4 | `ProofsClearing.t.sol`: `testFuzz_C1_C4_*`, `test_C1_C4_SweepWithActivityFloor`, `invariant_C4_*` (incl. double reveal, re-clear, off-tick) | `proofs.book.test.ts`: exhaustive enumerations |
| C5 | `test_C5_FullBookWorstCasesClearInsideTheBudget` | — |
| C6 | `test_C6_ExhaustiveVectors…`, `test_C6_ExhaustiveWithUnrevealed…` | `C6 vectors…`, exhaustive tests |
| C7 | `testFuzz_C7_*` | `C7: clockAt …` |
| F-* | `test_F_*` | `F-E1`, `F-E2`, `F-E3` |

## Mutation matrix

Each mutant is one edit to a fresh extraction of the contracts (`git archive HEAD`), never to the repository. Each was run against the proof suite alone (`forge test --match-path 'test/Proofs*'`, 40 tests) three times with `cache/invariant` deleted, and once against the whole suite (113 tests). "Before" is the same mutant against the proof tests as they were before this revision (38 tests). The unmutated control passes 40/40 and 113/113.

| ID | Mutation (file) | Before: proof suite | Now: proof suite (3 of 3 runs) | Now: whole suite | Killed by (proof tests) |
|---|---|---|---|---|---|
| M1 | `ceilDiv` floors instead of ceiling (EconLib) | killed (12 fail) | **killed** (13 fail) | killed (35 fail) | E1/E2 fuzz, E3, E4 model and sweep, E7 vectors, the core invariants |
| M2 | allocation tie-break flipped: the later index wins equal prices (BlindBook) | killed (5) | **killed** (5) | killed (8) | C1-C4 fuzz and sweep, both C6 enumerations, `invariant_C4_UnitsOracleNoPanic` |
| M3 | `settle` credits `free += received`, dropping the escrow left (SKUdeskCore) | killed (1) | **killed** (1) | killed (2) | `invariant_E6_ConservationAndExactCustody` |
| M4 | p\* rounded **up** to the tick (BlindBook) | killed (4) | **killed** (4) | killed (6) | C1-C4 fuzz and sweep, both C6 enumerations |
| M5 | DailyCap `>` becomes `>=` (SKUdeskCore) | killed (3) | **killed** (5) | killed (5) | E4 model (exact-cap fill must be accepted) and sweep, E5 midnight and lower-cap tests, F-V1 |
| M6 | no daily reset of `spentToday` (SKUdeskCore) | killed (4) | **killed** (8) | killed (9) | E4 sweep (midnight crossings), E5 tests, F-V1, the core invariants |
| M7 | `MarginTooLow` check removed (SKUdeskCore) | killed (3) | **killed** (3) | killed (4) | E4 model and sweep, `test_E2_ExtremeLifecycleHasNoPanic` |
| M9 | `Replay` check removed (SKUdeskCore) | **survived** (0) | **killed** (6) | killed (7) | E4 model and sweep (replay cases), `invariant_E4_E5_ReplayAndDoubleMintRejectedExactly`, `invariant_E5_LotsAndCaps` |
| M10 | `o.consumed = true` removed from `mintLot` (SKUdeskCore) | **survived** (0) | **killed** (4) | killed (5) | `invariant_E4_E5_ReplayAndDoubleMintRejectedExactly`, `invariant_E5_LotsAndCaps` (one lot per opportunity, opportunity marked consumed) |
| M12 | `AlreadyRevealed` check removed (BlindBook) | **survived** (0) | **killed** (3) | killed (4) | all three `invariant_C4_*` (double reveal must be `AlreadyRevealed`; buckets and locked units drift) |
| M13 | `price % tick` check removed (BlindBook) | **survived** (0) | **killed** (3) | killed (4) | `invariant_C4_DoubleRevealReclearOffTickRejectedExactly` (off-tick reveal must be `BadPrice`), `invariant_C4_CustodyAndBuckets` |
| M14 | `AlreadyCleared` check removed (BlindBook) | **survived** (0) | **killed** (3) | killed (4) | all three `invariant_C4_*` (re-clear must be `AlreadyCleared`) |
| M15 | `refund` drops the escrow (`free += left` removed) (SKUdeskCore) | killed (1) | **killed** (1) | killed (4) | `invariant_E6_ConservationAndExactCustody` |
| M17 | overfill: `f = remaining` instead of `min(units, remaining)` (BlindBook) | killed (7) | **killed** (8) | killed (12) | C1-C4 fuzz and sweep, C5, both C6 enumerations, `invariant_C4_UnitsOracleNoPanic` |
| M18 | margin rounded **up** (`ceilDiv(net·10⁴, sell)`) (EconLib) | killed (17) | **killed** (18) | killed (39) | E1/E2 fuzz, E3, E4, E5, E7 vectors, F-V*, all four core invariants |

**Result recorded earlier: the proof suite alone killed 15 of 15 mutants.** None survived. The mutation runner and its logs are not committed, so this was not re-run for the submission and cannot be reproduced from the repo alone. Two notes:

* M3 and M15 are killed by a single proof test, the E6 conservation invariant. The kill is reliable, not lucky: any `lifecycle` call that settles or refunds a lot with escrow left breaks conservation, and the shrunk counterexample is one call.
* The review said M5 was killed only by the unit boundary tests. For the mutant used here (`spentToday + spend >= dailySpendCap`), the earlier proof tests already killed it through `test_E5_MidnightAllowsExactlyTwoCapsInTwoSeconds`, which commits exactly one cap. The E4 model now also pins the boundary directly: a spend that fills the remaining cap exactly must be accepted, and one more cent must revert `DailyCap`.

The mutation runner and its raw logs are not committed (they live outside the repository). Re-create a mutant by applying one row's edit to a copy of `packages/contracts`, then run the two forge commands above in that copy.
