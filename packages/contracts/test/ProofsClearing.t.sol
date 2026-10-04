// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {Test, Vm, stdError} from 'forge-std/Test.sol';
import {BlindBook} from '../src/BlindBook.sol';
import {MockUSDC} from '../src/MockUSDC.sol';

/// Executable cross-checks (tests, not a formal verification) for docs/proofs/clearing.md. Test names carry the theorem id (C1..C7, F-B*).
/// Run: cd packages/contracts && forge test --match-path 'test/Proofs*'

/// Brute-force oracle, independent of the contract's algorithm: it evaluates V(p) at EVERY tick price (not only revealed
/// prices) and allocates by SORTING (not by repeated best-search). The tie rule (p* = largest tick multiple <= (lo+hi)/2)
/// is the specification and is applied to the oracle's own lo/hi.
library Oracle {
    struct Book { uint8[] side; uint256[] price; uint256[] units; bool[] revealed; uint256 tick; uint256 maxTick; }
    function volumeAt(Book memory b, uint256 p) internal pure returns (uint256) {
        uint256 d; uint256 s;
        for (uint256 i = 0; i < b.side.length; i++) {
            if (!b.revealed[i]) continue;
            if (b.side[i] == 0) { if (b.price[i] >= p) d += b.units[i]; } else if (b.price[i] <= p) s += b.units[i];
        }
        return d < s ? d : s;
    }
    function clear(Book memory b) internal pure returns (uint256 pStar, uint256 vmax, uint256 lo, uint256 hi, uint256[] memory fills) {
        uint256 n = b.side.length; fills = new uint256[](n);
        for (uint256 k = 1; k <= b.maxTick; k++) {
            uint256 p = k * b.tick; uint256 v = volumeAt(b, p);
            if (v > vmax) { vmax = v; lo = p; hi = p; } else if (v == vmax && v > 0) hi = p;
        }
        if (vmax == 0) return (0, 0, 0, 0, fills);
        pStar = ((lo + hi) / 2 / b.tick) * b.tick;
        for (uint8 side = 0; side < 2; side++) {
            // eligible orders of this side, insertion-sorted by (better price first, then lower index)
            uint256[] memory idx = new uint256[](n); uint256 m;
            for (uint256 i = 0; i < n; i++) {
                if (!b.revealed[i] || b.side[i] != side) continue;
                if (side == 0 ? b.price[i] < pStar : b.price[i] > pStar) continue;
                uint256 j = m++;
                while (j > 0 && (side == 0 ? b.price[idx[j - 1]] < b.price[i] : b.price[idx[j - 1]] > b.price[i])) { idx[j] = idx[j - 1]; j--; }
                idx[j] = i;
            }
            uint256 rem = vmax;
            for (uint256 k = 0; k < m && rem > 0; k++) { uint256 f = b.units[idx[k]] < rem ? b.units[idx[k]] : rem; fills[idx[k]] = f; rem -= f; }
            require(rem == 0, 'oracle: the eligible side always covers vmax (lemma C1.3)');
        }
    }
}

/// The real BlindBook with one extra entry point that writes a book straight into storage, exactly as commit + reveal would
/// leave it (locks and bonds included), so the UNCHANGED clear() can be run on thousands of books cheaply.
contract ClearHarness is BlindBook {
    constructor(address t, uint256 L, uint256 ce, uint256 re, uint256 b) BlindBook(t, L, ce, re, b) {}
    function seed(bytes32 m, uint256 e, uint8[] calldata side, uint256[] calldata price, uint256[] calldata units, bool[] calldata revealed) external {
        Order[] storage os = orders[m][e];
        for (uint256 i = 0; i < side.length; i++) {
            Order memory o; o.trader = address(uint160(0x1000 + i % 5)); o.revealed = revealed[i];
            if (revealed[i]) {
                o.side = side[i]; o.price = price[i]; o.units = units[i];
                if (side[i] == 0) { o.lockedCash = price[i] * units[i] * CENT; totalLocked += o.lockedCash; } else { o.lockedUnits = units[i]; lockedUnitsTotal[m] += units[i]; }
            } else totalBonds += bond;
            os.push(o);
        }
    }
}

abstract contract ClearingBase is Test {
    MockUSDC usdc; BlindBook book;
    uint256 constant EPOCH = 45; uint256 constant COMMIT = 20; uint256 constant REVEAL = 35; uint256 constant BOND = 2_000_000; uint256 constant CENT = 10_000;
    address[5] W = [address(0xA1), address(0xB2), address(0xC3), address(0xD4), address(0xE5)];
    bytes32[4] MK = [keccak256('T1'), keccak256('T2'), keccak256('T5'), keccak256('T10')]; uint256[4] TK = [uint256(1), 2, 5, 10];
    function _now() internal view returns (uint256) { return vm.getBlockTimestamp(); }
    function _r(uint256 seed, uint256 i) internal pure returns (uint256) { return uint256(keccak256(abi.encode(seed, i))); }
    function _deploy() internal {
        usdc = new MockUSDC(); book = new BlindBook(address(usdc), EPOCH, COMMIT, REVEAL, BOND);
        for (uint256 k = 0; k < 4; k++) book.listMarket(MK[k], TK[k]);
        for (uint256 i = 0; i < 5; i++) {
            usdc.mint(W[i], 1e15); vm.prank(W[i]); usdc.approve(address(book), type(uint256).max); vm.prank(W[i]); book.deposit(1e15);
            for (uint256 k = 0; k < 4; k++) book.issue(MK[k], W[i], 1_000_000);
        }
    }
    function _at(uint256 epoch, uint256 off) internal { vm.warp(book.t0() + epoch * EPOCH + off); }
}

contract ProofsClearingTest is ClearingBase {
    bytes32 constant FILL = keccak256('Fill(bytes32,uint256,uint256,address,uint8,uint256,uint256)');
    function setUp() public { _deploy(); }

    struct Stats { uint256 traded; uint256 full; uint256 partials; uint256 forfeits; uint256 noTrade; uint256 ties; uint256 tickRounded; uint256 books; }
    struct Run { bytes32 m; uint256 e; uint256 n; address[] who; bytes32[] salt; Oracle.Book b; int256[5] dCash; int256[5] dUnits; uint256 treasury0; }

    /// One complete epoch through the REAL commit -> reveal -> clear path, checked against the oracle and the accounting theorems.
    function _book(uint256 seed, Stats memory st) internal {
        Run memory R; uint256 k = _r(seed, 0) % 4; R.m = MK[k]; R.b.tick = TK[k]; R.b.maxTick = 3 + _r(seed, 1) % 20;
        R.n = 1 + _r(seed, 2) % 24; if (_r(seed, 3) % 5 == 0) R.n = 24;
        R.e = book.currentEpoch() + 1; _at(R.e, 1);
        R.b.side = new uint8[](R.n); R.b.price = new uint256[](R.n); R.b.units = new uint256[](R.n); R.b.revealed = new bool[](R.n);
        R.who = new address[](R.n); R.salt = new bytes32[](R.n);
        uint256[5] memory cash0; uint256[5] memory units0;
        for (uint256 i = 0; i < 5; i++) { cash0[i] = book.cash(W[i]); units0[i] = book.unitsOf(R.m, W[i]); }
        R.treasury0 = book.treasury();
        for (uint256 i = 0; i < R.n; i++) {
            uint256 x = _r(seed, 100 + i);
            R.who[i] = W[x % 5]; R.b.side[i] = uint8((x >> 8) % 2); R.b.price[i] = R.b.tick * (1 + (x >> 16) % R.b.maxTick);
            R.b.units[i] = 1 + (x >> 32) % 15; R.b.revealed[i] = (x >> 48) % 8 != 0; R.salt[i] = keccak256(abi.encode(seed, i));
            vm.prank(R.who[i]); book.commit(R.m, keccak256(abi.encode(R.m, R.e, R.who[i], R.b.side[i], R.b.price[i], R.b.units[i], R.salt[i])));
        }
        _at(R.e, COMMIT);
        for (uint256 i = 0; i < R.n; i++) if (R.b.revealed[i]) { vm.prank(R.who[i]); book.reveal(R.m, R.e, i, R.b.side[i], R.b.price[i], R.b.units[i], R.salt[i]); }
        _at(R.e, REVEAL); vm.recordLogs(); book.clear(R.m, R.e);
        _check(R, st, cash0, units0);
    }

    function _check(Run memory R, Stats memory st, uint256[5] memory cash0, uint256[5] memory units0) internal {
        (uint256 pS, uint256 vS, uint256 lo, uint256 hi, uint256[] memory fills) = Oracle.clear(R.b);
        (uint256 p, uint256 v) = book.results(R.m, R.e);
        require(v == vS, 'C1 volume == brute-force maximum over every tick price');
        require(p == pS, 'C1 p* == the tie rule applied to the maximal interval');
        if (v > 0) require(Oracle.volumeAt(R.b, p) == v && p >= lo && p <= hi && p % R.b.tick == 0, 'C1 p* is a maximal-volume tick price');
        uint256 forfeits; uint256 buyF; uint256 sellF;
        for (uint256 i = 0; i < R.n; i++) {
            (, bool rev, uint8 side, uint256 pr, uint256 un, uint256 f, ) = book.getOrder(R.m, R.e, i);
            require(f == fills[i], 'C1 fills == oracle (price-time priority)');
            require(f <= un, 'C2 never overfilled');
            if (f > 0) require(side == 0 ? pr >= p : pr <= p, 'C2 individual rationality: limit respected');
            if (f > 0 && f < un) st.partials++;
            uint256 w = _idx(R.who[i]);
            if (!rev) { forfeits++; R.dCash[w] -= int256(BOND); continue; }
            if (side == 0) { buyF += f; R.dCash[w] -= int256(p * f * CENT); R.dUnits[w] += int256(f); }
            else { sellF += f; R.dCash[w] += int256(p * f * CENT); R.dUnits[w] -= int256(f); }
        }
        require(buyF == v && sellF == v, 'C3 both sides fill exactly the volume');
        // C2 uniform price: every Fill event carries p* and the order's fill
        Vm.Log[] memory logs = vm.getRecordedLogs(); uint256 nf;
        for (uint256 i = 0; i < logs.length; i++) if (logs[i].topics[0] == FILL) {
            (uint256 index, , uint256 units, uint256 price) = abi.decode(logs[i].data, (uint256, uint8, uint256, uint256));
            require(price == p && units == fills[index], 'C2 every fill is at the one uniform price'); nf++;
        }
        // C4 exact accounting per trader: cash moves by exactly +-p*fill*CENT and -bond per forfeited order; units by +-fill
        int256 sumCash;
        for (uint256 i = 0; i < 5; i++) {
            require(int256(book.cash(W[i])) - int256(cash0[i]) == R.dCash[i], 'C4 per-trader cash delta is exact');
            require(int256(book.unitsOf(R.m, W[i])) - int256(units0[i]) == R.dUnits[i], 'C4 per-trader unit delta is exact');
            sumCash += R.dCash[i];
        }
        require(book.treasury() - R.treasury0 == forfeits * BOND, 'C4 the treasury gains exactly the forfeited bonds');
        require(sumCash + int256(forfeits * BOND) == 0, 'C4 zero dust: buyers pay exactly what sellers receive');
        require(usdc.balanceOf(address(book)) == book.accounted(), 'C4 token balance == free + locked + bonds + treasury');
        st.books++; st.forfeits += forfeits; if (R.n == 24) st.full++;
        if (v > 0) { st.traded++; require(nf > 0, 'fills emitted'); if (lo < hi) st.ties++; if (p * 2 < lo + hi) st.tickRounded++; } else st.noTrade++;
    }
    function _idx(address a) internal view returns (uint256) { for (uint256 i = 0; i < 5; i++) if (W[i] == a) return i; revert('who'); }

    /// C1-C4 on random books of 1..24 orders (ticks 1/2/5/10, ~1/8 unrevealed) through the real commit/reveal/clear path.
    /// forge-config: default.fuzz.runs = 1000
    function testFuzz_C1_C4_RealFlowMatchesTheOracleAndConserves(uint256 seed) public {
        Stats memory st; _book(seed, st); require(st.books == 1, 'ran');
    }
    /// Non-vacuity for the same checks: 400 deterministic books with a floor on every interesting situation.
    function test_C1_C4_SweepWithActivityFloor() public {
        vm.pauseGasMetering(); Stats memory st;
        for (uint256 s = 0; s < 400; s++) _book(s, st);
        emit log_named_uint('books', st.books); emit log_named_uint('traded', st.traded); emit log_named_uint('full (24 orders)', st.full);
        emit log_named_uint('partial fills', st.partials); emit log_named_uint('forfeited orders', st.forfeits); emit log_named_uint('no-trade books', st.noTrade);
        emit log_named_uint('maximal interval wider than one price (tie rule used)', st.ties); emit log_named_uint('p* rounded below the midpoint', st.tickRounded);
        require(st.traded > 150 && st.full > 30 && st.partials > 100 && st.forfeits > 300 && st.noTrade > 10 && st.ties > 50 && st.tickRounded > 10, 'activity floor');
    }

    // ------------------------------------------------------------------ C6: exhaustive enumeration (3-way: Solidity == TS == oracle)
    function _harness() internal returns (ClearHarness hb, bytes32 m1, bytes32 m2) {
        hb = new ClearHarness(address(usdc), EPOCH, COMMIT, REVEAL, BOND); m1 = keccak256('H1'); m2 = keccak256('H2');
        hb.listMarket(m1, 1); hb.listMarket(m2, 2); vm.warp(hb.t0() + 100_000 * EPOCH); // every epoch < 100,000 is clearable
    }
    /// Every book in test/vectors/book-vectors-exhaustive.json (ALL books of <= 3 orders over 3 prices x 2 sizes x 2 sides,
    /// ticks 1 and 2: 3768 books) is cleared by the unchanged contract code and must equal the TypeScript mirror AND the oracle.
    struct Vec { uint256[] tick; uint256[] nn; uint256[] side; uint256[] price; uint256[] units; uint256[] expPrice; uint256[] expVolume; uint256[] expFill; }
    function test_C6_ExhaustiveVectorsSolidityEqualsTypeScriptEqualsOracle() public {
        vm.pauseGasMetering();
        (ClearHarness hb, bytes32 m1, bytes32 m2) = _harness();
        string memory j = vm.readFile('test/vectors/book-vectors-exhaustive.json'); Vec memory V;
        V.tick = vm.parseJsonUintArray(j, '.tick'); V.nn = vm.parseJsonUintArray(j, '.n');
        V.side = vm.parseJsonUintArray(j, '.side'); V.price = vm.parseJsonUintArray(j, '.price'); V.units = vm.parseJsonUintArray(j, '.units');
        V.expPrice = vm.parseJsonUintArray(j, '.expPrice'); V.expVolume = vm.parseJsonUintArray(j, '.expVolume'); V.expFill = vm.parseJsonUintArray(j, '.expFill');
        require(V.nn.length == 2 * (12 + 144 + 1728), 'the vector file is the complete enumeration');
        uint256 off; uint256 traded;
        for (uint256 v = 0; v < V.nn.length; v++) { if (_vecBook(hb, V.tick[v] == 1 ? m1 : m2, V, v, off)) traded++; off += V.nn[v]; }
        require(off == V.side.length && traded > 1000, 'all orders consumed; non-vacuous');
    }
    function _vecBook(ClearHarness hb, bytes32 m, Vec memory V, uint256 v, uint256 off) internal returns (bool) {
        Oracle.Book memory b; uint256 n = V.nn[v]; b.tick = V.tick[v]; b.maxTick = 3;
        b.side = new uint8[](n); b.price = new uint256[](n); b.units = new uint256[](n); b.revealed = new bool[](n);
        for (uint256 i = 0; i < n; i++) { b.side[i] = uint8(V.side[off + i]); b.price[i] = V.price[off + i]; b.units[i] = V.units[off + i]; b.revealed[i] = true; }
        hb.seed(m, v + 1, b.side, b.price, b.units, b.revealed); hb.clear(m, v + 1);
        (uint256 p, uint256 vol) = hb.results(m, v + 1); (uint256 pS, uint256 vS, , , uint256[] memory fills) = Oracle.clear(b);
        require(p == V.expPrice[v] && vol == V.expVolume[v] && p == pS && vol == vS, string.concat('book ', vm.toString(v), ': price/volume'));
        for (uint256 i = 0; i < n; i++) { (, , , , , uint256 f, ) = hb.getOrder(m, v + 1, i); require(f == V.expFill[off + i] && f == fills[i], string.concat('book ', vm.toString(v), ': fill')); }
        return vol > 0;
    }
    /// Independent Solidity-side enumeration that ALSO covers unrevealed orders: 13 order shapes (12 revealed + "unrevealed"),
    /// every book of 1..3 orders (13 + 169 + 2197 = 2379 books), tick 2 (so the tick rounding is exercised), against the oracle.
    function test_C6_ExhaustiveWithUnrevealedOrdersEqualsOracle() public {
        vm.pauseGasMetering();
        (ClearHarness hb, , bytes32 m2) = _harness(); uint256 books; uint256 traded; uint256 epoch;
        for (uint256 n = 1; n <= 3; n++) {
            uint256 total = 13 ** n;
            for (uint256 code = 0; code < total; code++) {
                Oracle.Book memory b; b.tick = 2; b.maxTick = 3;
                b.side = new uint8[](n); b.price = new uint256[](n); b.units = new uint256[](n); b.revealed = new bool[](n);
                uint256 c = code;
                for (uint256 i = 0; i < n; i++) {
                    uint256 s = c % 13; c /= 13;
                    if (s == 12) { b.revealed[i] = false; continue; }
                    b.revealed[i] = true; b.side[i] = uint8(s / 6); b.price[i] = 2 * (1 + (s % 6) / 2); b.units[i] = 1 + s % 2;
                }
                epoch++; uint256 tb = hb.treasury();
                hb.seed(m2, epoch, b.side, b.price, b.units, b.revealed); hb.clear(m2, epoch);
                (uint256 p, uint256 vol) = hb.results(m2, epoch); (uint256 pS, uint256 vS, , , uint256[] memory fills) = Oracle.clear(b);
                require(p == pS && vol == vS, 'price/volume == oracle');
                uint256 unrev;
                for (uint256 i = 0; i < n; i++) { (, , , , , uint256 f, ) = hb.getOrder(m2, epoch, i); require(f == fills[i], 'fill == oracle'); if (!b.revealed[i]) unrev++; }
                require(hb.treasury() - tb == unrev * BOND, 'C4 forfeits exactly bond per unrevealed order');
                books++; if (vol > 0) traded++;
            }
        }
        require(books == 2379 && traded > 500, 'complete and non-vacuous');
        require(hb.totalBonds() == 0 && hb.totalLocked() == 0 && hb.lockedUnitsTotal(m2) == 0, 'C4 every lock and bond released by clear');
    }

    // ------------------------------------------------------------------ C5: termination and gas
    function _gasOf(uint8[] memory side, uint256[] memory price, uint256[] memory units) internal returns (uint256 used) {
        uint256 e = book.currentEpoch() + 1; _at(e, 1); bytes32 m = MK[0];
        for (uint256 i = 0; i < side.length; i++) { vm.prank(W[i % 5]); book.commit(m, keccak256(abi.encode(m, e, W[i % 5], side[i], price[i], units[i], bytes32(i)))); }
        _at(e, COMMIT); for (uint256 i = 0; i < side.length; i++) { vm.prank(W[i % 5]); book.reveal(m, e, i, side[i], price[i], units[i], bytes32(i)); }
        _at(e, REVEAL); uint256 g = gasleft(); book.clear(m, e); used = g - gasleft();
    }
    /// C5: with n = MAX_ORDERS the loops run at most n^2 (_best) + n^2 per side (_allocate) + n (_settle) times. Two worst shapes.
    function test_C5_FullBookWorstCasesClearInsideTheBudget() public {
        uint8[] memory s = new uint8[](24); uint256[] memory p = new uint256[](24); uint256[] memory u = new uint256[](24);
        for (uint256 i = 0; i < 24; i++) { s[i] = uint8(i % 2); p[i] = i % 2 == 0 ? 1000 - i : 1 + i; u[i] = 1; } // 12 x 12, all cross, all fill
        uint256 g1 = _gasOf(s, p, u);
        for (uint256 i = 0; i < 24; i++) { s[i] = i == 23 ? 1 : 0; p[i] = i == 23 ? 1 : 1000; u[i] = i == 23 ? 23 : 1; } // 23 buys vs 1 sell
        uint256 g2 = _gasOf(s, p, u);
        emit log_named_uint('clear gas, 12x12 crossing', g1); emit log_named_uint('clear gas, 23 buys x 1 sell', g2);
        require(g1 < 5_000_000 && g2 < 5_000_000, 'C5 a full book clears within 5M gas');
    }

    // ------------------------------------------------------------------ C7: the schedule is a total partition; gating follows it
    /// forge-config: default.fuzz.runs = 2000
    function testFuzz_C7_PhaseIsATotalPartitionForAnyValidSchedule(uint256 L, uint256 ce, uint256 re, uint256 dt) public {
        L = bound(L, 2, 1e9); re = bound(re, 1, L - 1); ce = bound(ce, 0, re - 1); dt = bound(dt, 0, 1e15);
        BlindBook b = new BlindBook(address(usdc), L, ce, re, 0); vm.warp(b.t0() + dt);
        uint256 off = dt % L; uint8 ph = b.phase();
        require(ph == (off < ce ? 0 : off < re ? 1 : 2), 'C7 phase formula');
        uint256 hits = (off < ce ? 1 : 0) + (off >= ce && off < re ? 1 : 0) + (off >= re && off < L ? 1 : 0);
        require(hits == 1, 'C7 exactly one phase');
        uint256 e = b.currentEpoch(); require(e == dt / L && b.epochStart(e) <= _now() && _now() < b.epochStart(e + 1), 'C7 epoch bracket');
    }
    /// C7 gating: commit works iff phase 0; reveal of an epoch-e order works iff (epoch == e and phase 1); clear(e) works iff
    /// t >= t0 + e*L + revealEnd; and once clear is possible the order set of e is frozen (no commit to e, no reveal of e).
    /// forge-config: default.fuzz.runs = 2000
    function testFuzz_C7_GatingFollowsThePhaseAndClearFreezesTheEpoch(uint256 dt) public {
        dt = bound(dt, 0, 4 * EPOCH);
        bytes32 m = MK[0]; uint256 e = 1; _at(e, 5); bytes32 salt = keccak256('s');
        vm.prank(W[0]); book.commit(m, keccak256(abi.encode(m, e, W[0], uint8(0), uint256(100), uint256(1), salt)));
        vm.warp(_now() + dt);
        uint256 t = _now(); uint256 ce = book.currentEpoch(); uint8 ph = book.phase();
        // reveal
        bool canReveal = ce == e && ph == 1;
        if (!canReveal) vm.expectRevert(abi.encodeWithSelector(BlindBook.WrongPhase.selector, ce != e ? uint8(2) : ph, uint8(1)));
        vm.prank(W[0]); book.reveal(m, e, 0, 0, 100, 1, salt);
        // commit (always targets the CURRENT epoch)
        if (ph != 0) vm.expectRevert(abi.encodeWithSelector(BlindBook.WrongPhase.selector, ph, uint8(0)));
        vm.prank(W[1]); book.commit(m, bytes32(uint256(7)));
        if (ph == 0) require(ce != e || t < book.t0() + e * EPOCH + REVEAL, 'commit into a clearable epoch is impossible');
        // clear
        uint256 readyAt = book.t0() + e * EPOCH + REVEAL;
        if (t < readyAt) { vm.expectRevert(abi.encodeWithSelector(BlindBook.TooEarly.selector, t, readyAt)); book.clear(m, e); return; }
        uint256 n = book.orderCount(m, e); book.clear(m, e);
        // frozen: nothing can be added to or revealed in e afterwards, at any later time
        vm.warp(_now() + dt % 1000);
        vm.prank(W[1]); try book.commit(m, bytes32(uint256(8))) { } catch { }
        require(book.orderCount(m, e) == n, 'C7 epoch e is frozen once clearable');
        vm.expectRevert(); vm.prank(W[0]); book.reveal(m, e, 0, 0, 100, 1, salt);
    }

    // ------------------------------------------------------------------ findings (docs/proofs/FINDINGS.md), as executable statements
    /// F-B1: the owner pauses during the reveal window; reveal is `live` but clear is not, so EVERY committed bond of the epoch is
    /// forfeited to the treasury, which the owner withdraws. Traders who tried to reveal could not.
    function test_F_B1_PauseDuringRevealSendsEveryBondToTheOwner() public {
        bytes32 m = MK[0]; uint256 e = 1; _at(e, 5);
        for (uint256 i = 0; i < 5; i++) { vm.prank(W[i]); book.commit(m, keccak256(abi.encode(m, e, W[i], uint8(0), uint256(10), uint256(1), bytes32(i)))); }
        _at(e, COMMIT); book.pause(true);
        vm.expectRevert(BlindBook.Paused.selector); vm.prank(W[0]); book.reveal(m, e, 0, 0, 10, 1, bytes32(0));
        _at(e, REVEAL); vm.prank(W[3]); book.clear(m, e); // anyone can clear while paused
        address owner_ = address(0x0E); uint256 before = usdc.balanceOf(owner_); book.withdrawTreasury(owner_);
        require(usdc.balanceOf(owner_) - before == 5 * BOND, 'the owner collected all 5 bonds');
    }
    /// F-B2: BookFull DoS costs the attacker NOTHING but gas: fill all 24 slots, reveal harmless orders (bond refunded at reveal,
    /// lock refunded at clear). Honest traders are locked out of the epoch.
    function test_F_B2_BookFullDosCostsTheAttackerNothing() public {
        bytes32 m = MK[0]; uint256 e = 1; address x = W[4]; uint256 cash0 = book.cash(x); _at(e, 1);
        for (uint256 i = 0; i < 24; i++) { vm.prank(x); book.commit(m, keccak256(abi.encode(m, e, x, uint8(0), uint256(1), uint256(1), bytes32(i)))); }
        vm.expectRevert(BlindBook.BookFull.selector); vm.prank(W[0]); book.commit(m, bytes32(uint256(1)));
        _at(e, COMMIT); for (uint256 i = 0; i < 24; i++) { vm.prank(x); book.reveal(m, e, i, 0, 1, 1, bytes32(i)); }
        _at(e, REVEAL); book.clear(m, e);
        require(book.cash(x) == cash0, 'attacker ends with exactly its starting cash');
    }
    /// F-B3: `issue` is unlimited and unbacked: the owner mints units to itself and sells them for real cash in the next clear.
    function test_F_B3_UnbackedIssueSellsForRealCash() public {
        bytes32 m = MK[0]; address op = address(this); book.issue(m, op, 1_000);
        usdc.mint(op, BOND); usdc.approve(address(book), type(uint256).max); book.deposit(BOND);
        uint256 e = 1; _at(e, 1);
        book.commit(m, keccak256(abi.encode(m, e, op, uint8(1), uint256(100), uint256(1_000), bytes32(0))));
        vm.prank(W[0]); book.commit(m, keccak256(abi.encode(m, e, W[0], uint8(0), uint256(100), uint256(1_000), bytes32(uint256(1)))));
        _at(e, COMMIT); book.reveal(m, e, 0, 1, 100, 1_000, bytes32(0)); vm.prank(W[0]); book.reveal(m, e, 1, 0, 100, 1_000, bytes32(uint256(1)));
        _at(e, REVEAL); book.clear(m, e);
        require(book.cash(op) == BOND + 100 * 1_000 * CENT, 'the operator was paid $1,000 for units it created from nothing');
        require(book.totalIssued(m) == 5_000_000 + 1_000, 'unit conservation holds only relative to totalIssued');
    }
    /// F-B4: the constructor accepts degenerate schedules: commitEnd = 0 (commit window empty forever) and bond = 0.
    function test_F_B4_DegenerateSchedulesAreAccepted() public {
        BlindBook b = new BlindBook(address(usdc), 10, 0, 5, 0); b.listMarket(MK[0], 1);
        for (uint256 t = 0; t < 30; t++) { vm.warp(b.t0() + t); vm.expectRevert(abi.encodeWithSelector(BlindBook.WrongPhase.selector, b.phase(), uint8(0))); b.commit(MK[0], bytes32(0)); }
        require(b.bond() == 0, 'bond 0 accepted: BookFull DoS is then free even without revealing');
    }
    /// F-B5: clear with an astronomically large epoch reverts with a Panic (arithmetic overflow), not TooEarly. Harmless.
    function test_F_B5_HugeEpochClearPanicsInsteadOfTooEarly() public {
        vm.expectRevert(stdError.arithmeticError); book.clear(MK[0], type(uint256).max);
    }
}

// ====================================================================== C4: stateful accounting proof over many epochs
/// Handler WITHOUT setUp (see ProofsEconomics.t.sol). The handler is the book owner. Ghost state mirrors the theorem's buckets.
contract BookHandler is Test {
    MockUSDC public usdc; BlindBook public book; bytes32 public constant M = keccak256('INV');
    uint256 constant EPOCH = 45; uint256 constant COMMIT = 20; uint256 constant REVEAL = 35; uint256 public constant BOND = 2_000_000; uint256 constant CENT = 10_000;
    address[5] W = [address(0xA1), address(0xB2), address(0xC3), address(0xD4), address(0xE5)];
    struct P { uint256 epoch; uint256 idx; address who; uint8 side; uint256 price; uint256 units; bytes32 salt; bool revealed; bool tried; }
    P[] ps; mapping(uint256 => uint256[]) byEpoch; uint256[] epochs; mapping(uint256 => bool) seen; mapping(uint256 => bool) public done;
    uint256 public ghostBonds; uint256 public ghostLocked; uint256 public ghostTreasury; uint256 public ghostLockedUnits; uint256 nonce;
    uint256 public commits; uint256 public reveals; uint256 public clears; uint256 public trades; uint256 public forfeits; uint256 public mismatches; uint256 public panics;
    // Preconditions of C4 (each lock created once, released once) and of the C1 domain (prices are tick multiples), attacked on
    // purpose: a second reveal, a second clear and an off-tick reveal must each revert with EXACTLY the documented error.
    bytes32 public constant M5 = keccak256('INV-TICK5'); uint256 public constant TICK5 = 5;
    uint256 public doubleRevealsRejected; uint256 public reclearsRejected; uint256 public offTickRejected; uint256 public guardViolations; uint256 public calls;
    modifier counted() { calls++; _; }

    constructor() {
        usdc = new MockUSDC(); book = new BlindBook(address(usdc), EPOCH, COMMIT, REVEAL, BOND); book.listMarket(M, 1); book.listMarket(M5, TICK5);
        for (uint256 i = 0; i < 5; i++) {
            usdc.mint(W[i], 1e14); vm.prank(W[i]); usdc.approve(address(book), type(uint256).max); vm.prank(W[i]); book.deposit(1e13);
            book.issue(M, W[i], 100_000);
        }
    }
    function _now() internal view returns (uint256) { return vm.getBlockTimestamp(); }
    function _rec(bytes memory d) internal { if (d.length >= 4 && bytes4(d) == bytes4(0x4e487b71)) panics++; }
    /// Counts an attempt that must revert with exactly `want`: success or any other revert data is a guard violation.
    function _mustRevert(bool ok, bytes memory d, bytes memory want) internal returns (bool) {
        if (!ok) _rec(d);
        if (!ok && keccak256(d) == keccak256(want)) return true;
        guardViolations++; return false;
    }
    function sumCash() external view returns (uint256 s) { for (uint256 i = 0; i < 5; i++) s += book.cash(W[i]); s += book.cash(address(this)); }
    function sumUnits() external view returns (uint256 s) { for (uint256 i = 0; i < 5; i++) s += book.unitsOf(M, W[i]); }

    function _commitOne(uint256 x) internal { _commitSpec(W[x % 5], uint8((x >> 8) % 2), 20 + (x >> 16) % 15, 1 + (x >> 32) % 9); }
    function _commitSpec(address who, uint8 side, uint256 price, uint256 units) internal {
        if (book.phase() != 0) vm.warp(book.t0() + (book.currentEpoch() + 1) * EPOCH + 1);
        uint256 e = book.currentEpoch(); bytes32 salt = keccak256(abi.encode(++nonce));
        vm.prank(who);
        try book.commit(M, keccak256(abi.encode(M, e, who, side, price, units, salt))) returns (uint256 idx) {
            ps.push(P(e, idx, who, side, price, units, salt, false, false)); byEpoch[e].push(ps.length - 1);
            if (!seen[e]) { seen[e] = true; epochs.push(e); }
            ghostBonds += BOND; commits++;
        } catch (bytes memory d) { _rec(d); }
    }
    /// skipLast: leave exactly the last order unrevealed (cycle); otherwise leave every order with (x + k) % 7 == 0 unrevealed.
    function _revealEpoch(uint256 e, uint256 x, bool skipLast) internal {
        uint256[] storage l = byEpoch[e];
        for (uint256 k = 0; k < l.length; k++) {
            P storage o = ps[l[k]]; if (o.tried) continue; o.tried = true;
            if (skipLast ? k == l.length - 1 : (x % 7 + k) % 7 == 0) continue; // left unrevealed on purpose: must forfeit exactly the bond
            vm.prank(o.who);
            try book.reveal(M, e, o.idx, o.side, o.price, o.units, o.salt) {
                o.revealed = true; reveals++; ghostBonds -= BOND;
                if (o.side == 0) ghostLocked += o.price * o.units * CENT; else ghostLockedUnits += o.units;
                // the identical reveal again: must be AlreadyRevealed (else the lock would be taken and the bond refunded twice)
                vm.prank(o.who);
                (bool ok, bytes memory d2) = address(book).call(abi.encodeCall(BlindBook.reveal, (M, e, o.idx, o.side, o.price, o.units, o.salt)));
                if (_mustRevert(ok, d2, abi.encodeWithSelector(BlindBook.AlreadyRevealed.selector))) doubleRevealsRejected++;
            } catch (bytes memory d) { _rec(d); }
        }
    }
    function _clearEpoch(uint256 e) internal {
        if (done[e] || byEpoch[e].length == 0) return;
        uint256 readyAt = book.t0() + e * EPOCH + REVEAL; if (_now() < readyAt) vm.warp(readyAt);
        try book.clear(M, e) {
            done[e] = true; clears++;
            uint256[] storage l = byEpoch[e]; uint256 n = l.length;
            Oracle.Book memory b; b.tick = 1; b.maxTick = 40;
            b.side = new uint8[](n); b.price = new uint256[](n); b.units = new uint256[](n); b.revealed = new bool[](n);
            for (uint256 k = 0; k < n; k++) {
                P storage o = ps[l[k]]; b.side[k] = o.side; b.price[k] = o.price; b.units[k] = o.units; b.revealed[k] = o.revealed;
                if (!o.revealed) { ghostBonds -= BOND; ghostTreasury += BOND; forfeits++; }
                else if (o.side == 0) ghostLocked -= o.price * o.units * CENT; else ghostLockedUnits -= o.units;
            }
            (uint256 pS, uint256 vS, , , uint256[] memory fills) = Oracle.clear(b); (uint256 p, uint256 v) = book.results(M, e);
            if (p != pS || v != vS) mismatches++;
            for (uint256 k = 0; k < n; k++) { (, , , , , uint256 f, ) = book.getOrder(M, e, ps[l[k]].idx); if (f != fills[k]) mismatches++; }
            if (v > 0) trades++;
            // a second clear of the same epoch: must be AlreadyCleared (else every lock would be released twice)
            (bool ok, bytes memory d2) = address(book).call(abi.encodeCall(BlindBook.clear, (M, e)));
            if (_mustRevert(ok, d2, abi.encodeWithSelector(BlindBook.AlreadyCleared.selector))) reclearsRejected++;
        } catch (bytes memory d) { _rec(d); }
    }

    // ---- actions
    function commit(uint256 x) external counted { _commitOne(x); }
    function reveal(uint256 x) external counted {
        uint256 e = book.currentEpoch(); uint8 ph = book.phase();
        if (ph == 0) { vm.warp(book.t0() + e * EPOCH + COMMIT); ph = 1; }
        if (ph == 1) _revealEpoch(e, x, false);
    }
    function clearOldest() external counted { for (uint256 i = 0; i < epochs.length; i++) if (!done[epochs[i]]) { _clearEpoch(epochs[i]); return; } }
    /// One whole epoch: many overlapping orders, most revealed, then cleared. Makes trades certain.
    function cycle(uint256 x) external counted {
        for (uint256 i = 0; i < 5; i++) if (book.cash(W[i]) < 1e10) { vm.prank(W[i]); book.deposit(1e11); } // undo any drain by withdraw()
        vm.warp(book.t0() + (book.currentEpoch() + 1) * EPOCH + 1); uint256 e = book.currentEpoch();
        _commitSpec(W[x % 5], 0, 34, 1 + x % 9); _commitSpec(W[(x % 5 + 1) % 5], 1, 20, 1 + (x >> 8) % 9); // one certain cross
        uint256 n = 2 + x % 12; for (uint256 i = 0; i < n; i++) _commitOne(uint256(keccak256(abi.encode(x, i))));
        // an off-tick buy on the tick-5 market: committed (the hash hides the price), its reveal must be BadPrice(price, 5)
        address ow = W[(x >> 16) % 5]; uint256 op = TICK5 * (4 + (x >> 24) % 10) + 1 + (x >> 32) % 4; bytes32 os = keccak256(abi.encode('off', ++nonce));
        vm.prank(ow); book.commit(M5, keccak256(abi.encode(M5, e, ow, uint8(0), op, uint256(1), os))); ghostBonds += BOND;
        vm.warp(book.t0() + e * EPOCH + COMMIT); _revealEpoch(e, x, true);
        vm.prank(ow);
        (bool ok, bytes memory d) = address(book).call(abi.encodeCall(BlindBook.reveal, (M5, e, 0, uint8(0), op, uint256(1), os)));
        if (_mustRevert(ok, d, abi.encodeWithSelector(BlindBook.BadPrice.selector, op, TICK5))) offTickRejected++;
        for (uint256 i = 0; i < epochs.length; i++) if (!done[epochs[i]]) _clearEpoch(epochs[i]);
        // the off-tick order stayed unrevealed, so clearing the tick-5 epoch forfeits exactly its bond
        uint256 readyAt = book.t0() + e * EPOCH + REVEAL; if (_now() < readyAt) vm.warp(readyAt);
        try book.clear(M5, e) { ghostBonds -= BOND; ghostTreasury += BOND; } catch (bytes memory d3) { _rec(d3); guardViolations++; }
    }
    function deposit(uint256 i, uint256 x) external counted { address w = W[i % 5]; x = bound(x, 0, 1e12); vm.prank(w); try book.deposit(x) {} catch (bytes memory d) { _rec(d); } }
    function withdraw(uint256 i, uint256 x) external counted { address w = W[i % 5]; x = bound(x, 0, book.cash(w) + 1); vm.prank(w); try book.withdraw(x) {} catch (bytes memory d) { _rec(d); } }
    function issue(uint256 i, uint256 x) external counted { book.issue(M, W[i % 5], bound(x, 0, 10_000)); }
    function withdrawTreasury() external counted { book.withdrawTreasury(address(0x7EA)); ghostTreasury = 0; }
    function warp(uint256 dt) external counted { vm.warp(_now() + bound(dt, 0, 3 * EPOCH)); }
}

contract ProofsBookInvariantTest is Test {
    BookHandler h; BlindBook book; MockUSDC usdc;
    function setUp() public {
        h = new BookHandler(); book = h.book(); usdc = h.usdc(); targetContract(address(h));
        bytes4[] memory s = new bytes4[](9);
        s[0] = BookHandler.commit.selector; s[1] = BookHandler.reveal.selector; s[2] = BookHandler.clearOldest.selector; s[3] = BookHandler.cycle.selector;
        s[4] = BookHandler.deposit.selector; s[5] = BookHandler.withdraw.selector; s[6] = BookHandler.issue.selector; s[7] = BookHandler.withdrawTreasury.selector;
        s[8] = BookHandler.warp.selector;
        targetSelector(FuzzSelector({addr: address(h), selectors: s}));
    }
    /// C4: token custody and the four buckets, after every transition.
    /// forge-config: default.invariant.runs = 64
    /// forge-config: default.invariant.depth = 120
    /// forge-config: default.invariant.fail-on-revert = true
    function invariant_C4_CustodyAndBuckets() public view {
        assertEq(usdc.balanceOf(address(book)), book.accounted(), 'balance == free + locked + bonds + treasury');
        assertEq(h.sumCash(), book.totalFree(), 'sum cash == totalFree');
        assertEq(book.totalBonds(), h.ghostBonds(), 'totalBonds == bond * unrevealed orders of uncleared epochs');
        assertEq(book.totalLocked(), h.ghostLocked(), 'totalLocked == sum of locks of revealed buys in uncleared epochs');
        assertEq(book.treasury(), h.ghostTreasury(), 'treasury == forfeited bonds since the last withdrawal');
    }
    /// C4 (units) + C1 (oracle on every clear) + no panic.
    /// forge-config: default.invariant.runs = 64
    /// forge-config: default.invariant.depth = 120
    /// forge-config: default.invariant.fail-on-revert = true
    function invariant_C4_UnitsOracleNoPanic() public view {
        assertEq(h.sumUnits() + book.lockedUnitsTotal(h.M()), book.totalIssued(h.M()), 'free + locked units == issued');
        assertEq(book.lockedUnitsTotal(h.M()), h.ghostLockedUnits(), 'locked units == sum of revealed sells in uncleared epochs');
        assertEq(h.mismatches(), 0, 'every clear equals the oracle'); assertEq(h.panics(), 0, 'no Panic');
    }
    /// C4 preconditions: every double reveal reverted AlreadyRevealed, every re-clear AlreadyCleared, every off-tick reveal
    /// BadPrice(price, tick), and the off-tick order's epoch cleared normally.
    /// forge-config: default.invariant.runs = 64
    /// forge-config: default.invariant.depth = 120
    /// forge-config: default.invariant.fail-on-revert = true
    function invariant_C4_DoubleRevealReclearOffTickRejectedExactly() public view { assertEq(h.guardViolations(), 0, 'reveal/clear/tick guards'); }
    /// Non-vacuity floors, applied only to a campaign of normal length (a replay of a saved failing sequence from cache/invariant
    /// can be one call long and must show the original failure, not a spurious floor failure).
    function afterInvariant() public view {
        if (h.calls() < 50) return;
        require(h.doubleRevealsRejected() > 0 && h.reclearsRejected() > 0 && h.offTickRejected() > 0, 'activity floor: guard attempts');
        require(h.commits() > 0 && h.reveals() > 0 && h.clears() > 0, 'activity floor: commit/reveal/clear');
        require(h.trades() > 0, 'activity floor: trades'); require(h.forfeits() > 0, 'activity floor: forfeits');
    }
}
