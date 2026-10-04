// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {Test, stdError} from 'forge-std/Test.sol';
import {SKUdeskCore} from '../src/SKUdeskCore.sol';
import {EconLib} from '../src/EconLib.sol';
import {MockUSDC} from '../src/MockUSDC.sol';

/// Executable cross-checks (tests, not a formal verification) for docs/proofs/economics.md. Every test name carries the theorem id it checks (E1..E7, F-*).
/// Run: cd packages/contracts && forge test --match-path 'test/Proofs*'

/// Independent reference of the EconLib formulas (docs/proofs/economics.md, section 1). Written differently on purpose:
/// ceil is q = a / b, then +1 if a remainder is left (EconLib uses (a + b - 1) / b), and net is built in signed arithmetic.
library Ref {
    struct R { uint256 landed; uint256 mktFee; uint256 ret; int256 net; uint256 marginBps; uint256 breakeven; uint256 maxBuy; }
    function ceil(uint256 a, uint256 b) internal pure returns (uint256 q) { q = a / b; if (a % b != 0) q += 1; }
    function quote(EconLib.Quote memory q) internal pure returns (R memory r) {
        r.landed = q.purchaseCents + q.shipCents + q.dutyCents + q.taxCents + q.procFeeCents + q.payFeeCents;
        r.mktFee = ceil(q.sellCents * q.mktFeeBps, 10_000);
        r.ret = ceil(q.sellCents * q.retBps, 10_000);
        r.net = int256(q.sellCents) - int256(r.mktFee + q.fulfillCents + r.ret + r.landed + q.chainCents);
        if (q.sellCents > 0 && r.net > 0) r.marginBps = uint256(r.net) * 10_000 / q.sellCents;
        r.breakeven = r.landed + r.mktFee + q.fulfillCents + r.ret + q.chainCents;
        r.maxBuy = q.purchaseCents + r.mktFee + q.fulfillCents + r.ret + q.chainCents; // closed form, theorem E1(vii)
    }
    /// 10^4 * (exact rational net): N = 10^4*sell - sell*mkt - sell*ret - 10^4*(fulfill + landed + chain)
    function exactNet4(EconLib.Quote memory q) internal pure returns (int256) {
        uint256 landed = q.purchaseCents + q.shipCents + q.dutyCents + q.taxCents + q.procFeeCents + q.payFeeCents;
        return int256(10_000 * q.sellCents) - int256(q.sellCents * q.mktFeeBps) - int256(q.sellCents * q.retBps) - int256(10_000 * (q.fulfillCents + landed + q.chainCents));
    }
}

/// External wrapper so a revert inside EconLib would be observable (it never is on the accepted domain: theorem E2).
contract EconProbe { function quote(EconLib.Quote memory q) external pure returns (EconLib.Result memory) { return EconLib.quote(q); } }

abstract contract EconHelpers is Test {
    uint256 constant MAXF = 1e12; uint256 constant MAXB = 10_000;
    /// via_ir may cache block.timestamp inside one call after vm.warp; the cheatcode always returns the warped time.
    function _now() internal view returns (uint256) { return vm.getBlockTimestamp(); }
    function _bq(EconLib.Quote memory q) internal pure returns (EconLib.Quote memory) {
        q.purchaseCents %= MAXF + 1; q.shipCents %= MAXF + 1; q.dutyCents %= MAXF + 1; q.taxCents %= MAXF + 1; q.procFeeCents %= MAXF + 1;
        q.payFeeCents %= MAXF + 1; q.sellCents %= MAXF + 1; q.fulfillCents %= MAXF + 1; q.chainCents %= MAXF + 1;
        q.mktFeeBps %= MAXB + 1; q.retBps %= MAXB + 1; return q;
    }
    function _field(EconLib.Quote memory q, uint256 k) internal pure returns (uint256) {
        if (k == 0) return q.purchaseCents; if (k == 1) return q.shipCents; if (k == 2) return q.dutyCents; if (k == 3) return q.taxCents;
        if (k == 4) return q.procFeeCents; if (k == 5) return q.payFeeCents; if (k == 6) return q.sellCents; if (k == 7) return q.mktFeeBps;
        if (k == 8) return q.fulfillCents; if (k == 9) return q.retBps; return q.chainCents;
    }
    function _setField(EconLib.Quote memory q, uint256 k, uint256 v) internal pure {
        if (k == 0) q.purchaseCents = v; else if (k == 1) q.shipCents = v; else if (k == 2) q.dutyCents = v; else if (k == 3) q.taxCents = v;
        else if (k == 4) q.procFeeCents = v; else if (k == 5) q.payFeeCents = v; else if (k == 6) q.sellCents = v; else if (k == 7) q.mktFeeBps = v;
        else if (k == 8) q.fulfillCents = v; else if (k == 9) q.retBps = v; else q.chainCents = v;
    }
    function _checkExact(EconLib.Quote memory q, EconLib.Result memory r) internal pure {
        Ref.R memory e = Ref.quote(q);
        // (i) landed is the plain sum; (ii)/(iii) fees are EXACTLY the ceiling of sell*bps/10^4
        require(r.landed == e.landed, 'E1 landed');
        require(r.mktFee * 10_000 >= q.sellCents * q.mktFeeBps && (r.mktFee == 0 || (r.mktFee - 1) * 10_000 < q.sellCents * q.mktFeeBps), 'E1 mktFee = ceil');
        require(r.ret * 10_000 >= q.sellCents * q.retBps && (r.ret == 0 || (r.ret - 1) * 10_000 < q.sellCents * q.retBps), 'E1 ret = ceil');
        require(r.mktFee == e.mktFee && r.ret == e.ret, 'E1 fees vs reference');
        // (iv) net in exact signed arithmetic
        require(r.net == e.net, 'E1 net');
        // (v) margin = floor(net*10^4/sell) for net >= 0 and sell > 0, else 0; and 0 <= margin <= 10^4
        if (q.sellCents > 0 && r.net >= 0) {
            uint256 n = uint256(r.net);
            require(r.marginBps * q.sellCents <= n * 10_000 && n * 10_000 < (r.marginBps + 1) * q.sellCents, 'E1 margin = floor');
        } else require(r.marginBps == 0, 'E1 margin clamp');
        require(r.marginBps <= 10_000 && r.marginBps == e.marginBps, 'E1 margin range');
        // (vi)/(vii) breakeven and the closed form of maxBuy (finding F-E2: it is NOT the break-even purchase price)
        require(r.breakeven == e.breakeven && r.maxBuy == e.maxBuy, 'E1 breakeven/maxBuy');
    }
}

contract ProofsEconLibTest is EconHelpers {
    EconProbe probe = new EconProbe();

    /// E1 + E2: on the whole accepted domain EconLib never reverts and every output equals its exact integer definition.
    /// forge-config: default.fuzz.runs = 4000
    function testFuzz_E1_E2_ExactDefinitionsOnTheWholeAcceptedDomain(EconLib.Quote memory q) public view {
        q = _bq(q);
        try probe.quote(q) returns (EconLib.Result memory r) { _checkExact(q, r); } catch { revert('E2: EconLib reverted on an accepted input'); }
    }

    /// E2 (exhaustive corners): all 2^11 = 2048 corners of the box [0, MAX_FIELD]^9 x [0, MAX_BPS]^2. Extremes are where overflow would live.
    function test_E2_AllCornersOfTheAcceptedBox() public view {
        uint256 ok;
        for (uint256 mask = 0; mask < 2048; mask++) {
            EconLib.Quote memory q;
            for (uint256 k = 0; k < 11; k++) _setField(q, k, (mask >> k) & 1 == 1 ? (k == 7 || k == 9 ? MAXB : MAXF) : 0);
            EconLib.Result memory r = probe.quote(q); _checkExact(q, r); ok++;
        }
        require(ok == 2048, 'all corners evaluated');
    }

    /// E3 (rounding is conservative): 10^4*net <= N_exact < 10^4*net + 2*10^4, and for net > 0: margin*sell <= N_exact.
    /// forge-config: default.fuzz.runs = 4000
    function testFuzz_E3_RoundingNeverOverstatesNetOrMargin(EconLib.Quote memory q) public pure {
        q = _bq(q); EconLib.Result memory r = EconLib.quote(q); int256 n4 = Ref.exactNet4(q);
        require(r.net * 10_000 <= n4, 'E3 computed net <= exact net');
        require(n4 < r.net * 10_000 + 20_000, 'E3 computed net > exact net - 2');
        if (r.net > 0) require(int256(r.marginBps * q.sellCents) <= n4, 'E3 computed margin <= exact margin');
        // a quote the contract can accept has net > 0, so its exact net is > 0 and its exact margin >= the floor that was checked
        if (r.net > 0 && r.marginBps >= 100) require(n4 > 0 && int256(100 * q.sellCents) <= n4, 'E3 the floor holds for the exact rationals');
    }

    /// E3 (monotonicity): raising any COST input (8 cent fields or either bps) never raises net or margin.
    /// forge-config: default.fuzz.runs = 4000
    function testFuzz_E3_NetAndMarginAreMonotoneInEveryCost(EconLib.Quote memory q, uint256 which, uint256 delta) public pure {
        q = _bq(q); uint256[10] memory costs = [uint256(0), 1, 2, 3, 4, 5, 7, 8, 9, 10]; uint256 k = costs[which % 10];
        uint256 lim = (k == 7 || k == 9) ? MAXB : MAXF; uint256 v = _field(q, k); delta = bound(delta, 0, lim - v);
        EconLib.Result memory a = EconLib.quote(q); _setField(q, k, v + delta); EconLib.Result memory b = EconLib.quote(q);
        require(b.net <= a.net && b.marginBps <= a.marginBps, 'E3 monotone in costs');
    }

    /// E3 (sell price): with mkt+ret <= 10^4 the EXACT net is non-decreasing in sell and the rounded net drops by at most 1 per cent.
    /// forge-config: default.fuzz.runs = 4000
    function testFuzz_E3_SellPriceIsMonotoneUpToOneCent(EconLib.Quote memory q) public pure {
        q = _bq(q); q.retBps = bound(q.retBps, 0, MAXB - q.mktFeeBps); q.sellCents = bound(q.sellCents, 0, MAXF - 1);
        EconLib.Result memory a = EconLib.quote(q); int256 na = Ref.exactNet4(q);
        q.sellCents += 1; EconLib.Result memory b = EconLib.quote(q); int256 nb = Ref.exactNet4(q);
        require(nb >= na, 'E3 exact net non-decreasing in sell'); require(b.net >= a.net - 1, 'E3 rounded net drops at most 1');
    }
    /// E3 counterexample that strict monotonicity in sell FAILS under ceil rounding (documented, not a bug).
    function test_E3_RoundedNetIsNotMonotoneInSell() public pure {
        EconLib.Quote memory q; q.mktFeeBps = 5_000; q.retBps = 5_000;
        require(EconLib.quote(q).net == 0, 'sell 0'); q.sellCents = 1; require(EconLib.quote(q).net == -1, 'sell 1: two 1-cent ceil fees');
    }

    /// E7: EconLib equals the independent BigInt reference (test/vectors/econ-vectors.json, generated by gen-econ-vectors.mjs)
    /// on every vector, including the ones outside the TypeScript-safe region.
    function test_E7_EconLibEqualsTheBigIntReferenceVectors() public view {
        string memory j = vm.readFile('test/vectors/econ-vectors.json');
        string[11] memory f = ['.purchaseCents', '.shipCents', '.dutyCents', '.taxCents', '.procFeeCents', '.payFeeCents', '.sellCents', '.mktFeeBps', '.fulfillCents', '.retBps', '.chainCents'];
        uint256[][11] memory in_;
        for (uint256 k = 0; k < 11; k++) in_[k] = vm.parseJsonUintArray(j, f[k]);
        uint256[] memory landed = vm.parseJsonUintArray(j, '.exp_landed'); uint256[] memory fee = vm.parseJsonUintArray(j, '.exp_mktFee');
        uint256[] memory ret = vm.parseJsonUintArray(j, '.exp_ret'); int256[] memory net = vm.parseJsonIntArray(j, '.exp_net');
        uint256[] memory bps = vm.parseJsonUintArray(j, '.exp_marginBps'); uint256[] memory be = vm.parseJsonUintArray(j, '.exp_breakeven');
        uint256[] memory mb = vm.parseJsonUintArray(j, '.exp_maxBuy'); uint256[] memory safe = vm.parseJsonUintArray(j, '.tsSafe');
        uint256 unsafe; uint256 profitable;
        for (uint256 i = 0; i < landed.length; i++) {
            EconLib.Quote memory q; for (uint256 k = 0; k < 11; k++) _setField(q, k, in_[k][i]);
            EconLib.Result memory r = EconLib.quote(q);
            require(r.landed == landed[i] && r.mktFee == fee[i] && r.ret == ret[i] && r.net == net[i] && r.marginBps == bps[i] && r.breakeven == be[i] && r.maxBuy == mb[i],
                string.concat('vector ', vm.toString(i), ' differs from the BigInt reference'));
            if (safe[i] == 0) unsafe++; if (net[i] > 0) profitable++;
        }
        require(landed.length > 1500 && unsafe > 50 && profitable > 500, 'vectors are not vacuous');
    }
}

/// Commit-path proofs (E2 bounds, E4 decision model / agent-lie rejection, E5 caps) on a fresh vault per test.
contract ProofsCommitTest is EconHelpers {
    SKUdeskCore c; MockUSDC usdc;
    address agent = address(0xA11CE); address supplier = address(0x5011); address market = address(0xBEEF);
    bytes32 constant PROD = keccak256('PROOF-PRODUCT');
    uint256 constant CENT = 10_000;

    function setUp() public {
        vm.warp(1_000_000_000);
        usdc = new MockUSDC(); c = new SKUdeskCore(address(usdc), agent);
        usdc.mint(address(this), type(uint128).max); usdc.approve(address(c), type(uint256).max); c.deposit(1e30);
        c.setPayee(supplier, true); c.setPayer(market, true);
        usdc.mint(market, type(uint128).max); vm.prank(market); usdc.approve(address(c), type(uint256).max);
    }
    function qh(EconLib.Quote memory q) internal pure returns (bytes32) { return keccak256(abi.encode(q)); }

    // ------------------------------------------------------------------ E4: the complete decision function of commitOpportunity
    /// pre: 0 none, 1 caller is not the agent, 2 vault paused, 3 quoteHash tampered, 4 observedAt in the future, 5 replay of an
    /// accepted (productHash, quoteHash, snapshotHash), 6 spend fills the daily cap EXACTLY (and maxExec exactly), 7 one cent over.
    struct Case { EconLib.Quote q; uint256 units; uint256 age; int256 claimNet; uint256 claimBps; bytes32 snap; uint8 pre; address caller; bool paused; bytes32 h; uint256 obs; }
    mapping(bytes32 => bool) seenOpp; EconLib.Quote lastQ; bytes32 lastSnap; bool hasLast;
    function _r(uint256 seed, uint256 i) internal pure returns (uint256) { return uint256(keccak256(abi.encode(seed, i))); }
    /// A small honest commit, used when a replay case needs an already accepted opportunity to replay.
    function _seedReplayTarget(uint256 seed) internal {
        c.setPolicy(type(uint128).max, type(uint128).max, 100, 600);
        EconLib.Quote memory q = EconLib.Quote(10, 0, 0, 0, 0, 0, 100, 0, 0, 0, 0); Ref.R memory e = Ref.quote(q); bytes32 snap = keccak256(abi.encode('replay-target', seed));
        vm.prank(agent); (bytes32 id,,) = c.commitOpportunity(PROD, qh(q), snap, _now(), 1, q, e.net, e.marginBps);
        seenOpp[id] = true; lastQ = q; lastSnap = snap; hasLast = true;
    }
    function _gen(uint256 seed) internal returns (Case memory k, uint8 mode) {
        mode = uint8(_r(seed, 0) % 10);
        uint256 pd = _r(seed, 30) % 24; k.pre = pd < 7 ? uint8(pd + 1) : 0;
        if (k.pre == 5 && !hasLast) _seedReplayTarget(seed);
        // policy: may change before every case; spentToday is NOT reset by setPolicy (the model knows this)
        uint256 ttl = _r(seed, 1) % 600;
        c.setPolicy(_r(seed, 2) % 4_000_000, _r(seed, 3) % 2_000_000, 100 + _r(seed, 4) % 3_000, ttl);
        EconLib.Quote memory q;
        if (_r(seed, 5) % 5 == 0) { q = _bq(EconLib.Quote(_r(seed, 6), _r(seed, 7), _r(seed, 8), _r(seed, 9), _r(seed, 10), _r(seed, 11), _r(seed, 12), _r(seed, 13), _r(seed, 14), _r(seed, 15), _r(seed, 16))); }
        else {
            uint256 s = 100 + _r(seed, 6) % 20_000; uint256 m = s / 14 + 1;
            q = EconLib.Quote(_r(seed, 7) % m, _r(seed, 8) % m, _r(seed, 9) % m, _r(seed, 10) % m, _r(seed, 11) % m, _r(seed, 12) % m, s, _r(seed, 13) % 2_000, _r(seed, 14) % m, _r(seed, 15) % 1_000, _r(seed, 16) % m);
            if (_r(seed, 24) % 6 == 0) q.purchaseCents = s - _r(seed, 25) % (s / 2); // loss-making or thin: reaches NonPositiveNet
        }
        uint256 uk = _r(seed, 17) % 21;
        k.units = uk == 0 ? 0 : uk == 1 ? 1e9 + 1 + _r(seed, 18) % 1e9 : uk == 2 ? 1 + _r(seed, 18) % 1e9 : 1 + _r(seed, 18) % 100;
        k.age = mode == 9 ? ttl + 1 + _r(seed, 19) % 100 : _r(seed, 19) % (ttl + 1);
        if (mode == 8) { uint256 f = _r(seed, 20) % 11; _setField(q, f, (f == 7 || f == 9 ? MAXB : MAXF) + 1 + _r(seed, 21) % 1000); }
        Ref.R memory e = Ref.quote(q); k.q = q; k.claimNet = e.net; k.claimBps = e.marginBps;
        if (mode == 5) k.claimNet = e.net + (_r(seed, 22) % 2 == 0 ? int256(1) : -int256(1 + _r(seed, 23) % 3));
        if (mode == 6) k.claimBps = e.marginBps + 1 + _r(seed, 22) % 3;
        if (mode == 7) k.claimNet = int256(_r(seed, 22) % 1e15) - 5e14;
        k.snap = keccak256(abi.encode('snap', seed));
        if (k.pre == 5) { k.q = lastQ; k.snap = lastSnap; e = Ref.quote(k.q); k.claimNet = e.net; k.claimBps = e.marginBps; }
        if (k.pre == 6 || k.pre == 7) {
            // DailyCap / SpendCap boundary: an honest, clearly profitable quote whose spend equals what is left of today's cap
            // (pre 6: accepted, so `>` is the comparison) or exceeds it by one cent (pre 7: DailyCap). maxExec == spend exactly.
            uint256 p = 1_000 + _r(seed, 31) % 1_000;
            k.q = EconLib.Quote(p, 1, 1, 1, 1, 1, 3 * p + 10, 800, 1, 200, 1); k.units = 1 + _r(seed, 32) % 50; mode = 0;
            e = Ref.quote(k.q); k.claimNet = e.net; k.claimBps = e.marginBps;
            uint256 spend = e.landed * k.units; uint256 spent = _now() / 1 days != c.dayNum() ? 0 : c.spentToday();
            c.setPolicy(spent + spend - (k.pre == 7 ? uint256(1) : 0), spend, 100, ttl); k.age = _r(seed, 35) % (ttl + 1);
        }
        k.caller = k.pre == 1 ? address(0xBAD) : agent; k.paused = k.pre == 2;
        k.h = k.pre == 3 ? bytes32(uint256(qh(k.q)) ^ (1 + _r(seed, 33) % 255)) : qh(k.q);
        k.obs = k.pre == 4 ? _now() + 1 + _r(seed, 34) % 1_000 : _now() - k.age;
    }
    /// The model: the exact revert payload commitOpportunity must produce (empty = must succeed). Derived from the spec, not the
    /// source: checks 1-13 of docs/proofs/economics.md section 4, in order.
    function _expect(Case memory k) internal view returns (bytes memory) {
        if (k.caller != agent) return abi.encodeWithSelector(SKUdeskCore.Unauthorized.selector);
        if (k.paused) return abi.encodeWithSelector(SKUdeskCore.Paused.selector);
        if (k.h != qh(k.q)) return abi.encodeWithSelector(SKUdeskCore.BadQuoteHash.selector, qh(k.q), k.h);
        if (k.obs > _now()) return abi.encodeWithSelector(SKUdeskCore.FutureObservation.selector, k.obs, _now());
        bytes32 id = keccak256(abi.encode(PROD, k.h, k.snap));
        if (seenOpp[id]) return abi.encodeWithSelector(SKUdeskCore.Replay.selector, id);
        uint256 ttl = c.quoteTTL(); uint256 age = _now() - k.obs;
        if (age > ttl) return abi.encodeWithSelector(SKUdeskCore.Stale.selector, age, ttl);
        if (k.units == 0 || k.units > 1e9) return abi.encodeWithSelector(SKUdeskCore.BadUnits.selector, k.units);
        bytes32[11] memory names = [bytes32('purchaseCents'), 'shipCents', 'dutyCents', 'taxCents', 'procFeeCents', 'payFeeCents', 'sellCents', 'fulfillCents', 'chainCents', 'mktFeeBps', 'retBps'];
        uint256[11] memory order = [uint256(0), 1, 2, 3, 4, 5, 6, 8, 10, 7, 9];
        for (uint256 i = 0; i < 11; i++) { uint256 v = _field(k.q, order[i]); if (v > (i >= 9 ? MAXB : MAXF)) return abi.encodeWithSelector(SKUdeskCore.OutOfBounds.selector, names[i], v); }
        Ref.R memory e = Ref.quote(k.q); uint256 spend = e.landed * k.units;
        if (spend > c.maxExec()) return abi.encodeWithSelector(SKUdeskCore.SpendCap.selector, spend, c.maxExec());
        uint256 spent = _now() / 1 days != c.dayNum() ? 0 : c.spentToday();
        if (spent + spend > c.dailySpendCap()) return abi.encodeWithSelector(SKUdeskCore.DailyCap.selector, spent + spend, c.dailySpendCap());
        if (e.net != k.claimNet || e.marginBps != k.claimBps) return abi.encodeWithSelector(SKUdeskCore.MathMismatch.selector, k.claimNet, e.net, k.claimBps, e.marginBps);
        if (e.net <= 0) return abi.encodeWithSelector(SKUdeskCore.NonPositiveNet.selector, e.net);
        if (e.marginBps < c.minMarginBps()) return abi.encodeWithSelector(SKUdeskCore.MarginTooLow.selector, e.marginBps, c.minMarginBps());
        return '';
    }
    /// Runs one case against the real contract and checks the exact outcome. Returns the outcome class (0 = accepted, else selector).
    function _run(Case memory k) internal returns (bytes4 outcome) {
        bytes memory want = _expect(k);
        uint256 spentBefore = _now() / 1 days != c.dayNum() ? 0 : c.spentToday();
        if (k.paused) c.pause(true);
        if (want.length > 0) {
            vm.expectRevert(want); vm.prank(k.caller);
            c.commitOpportunity(PROD, k.h, k.snap, k.obs, k.units, k.q, k.claimNet, k.claimBps);
            if (k.paused) c.pause(false);
            return bytes4(want);
        }
        vm.prank(k.caller);
        (bytes32 id, uint256 m, int256 n) = c.commitOpportunity(PROD, k.h, k.snap, k.obs, k.units, k.q, k.claimNet, k.claimBps);
        Ref.R memory e = Ref.quote(k.q);
        require(id == keccak256(abi.encode(PROD, k.h, k.snap)) && m == e.marginBps && n == e.net, 'E4 return values');
        require(c.spentToday() == spentBefore + e.landed * k.units, 'E4 spentToday += derived spend');
        (, uint256 u, uint256 landed, uint256 spend, int256 net, bool exists, bool consumed) = c.opps(id);
        require(exists && !consumed && u == k.units && landed == e.landed && spend == e.landed * k.units && net == e.net, 'E4 stored opportunity');
        seenOpp[id] = true; lastQ = k.q; lastSnap = k.snap; hasLast = true;
        return bytes4(0);
    }

    /// E4: for random quotes, policies, ages and claims (honest, off-by-one lies, wild lies, out-of-bounds, stale), the contract's
    /// outcome (exact revert payload or acceptance + state) equals the model. Implies: no Panic on the accepted domain (E2).
    /// forge-config: default.fuzz.runs = 3000
    function testFuzz_E4_CommitEqualsTheDecisionModel(uint256 seed) public {
        (Case memory k, ) = _gen(seed); _run(k);
    }
    /// E4 non-vacuity: the same model over 3000 deterministic cases, with every outcome class required to occur.
    function test_E4_DecisionModelSweepHitsEveryOutcome() public {
        uint256[14] memory cnt; bytes4[14] memory cls = [bytes4(0), SKUdeskCore.Stale.selector, SKUdeskCore.BadUnits.selector, SKUdeskCore.OutOfBounds.selector,
            SKUdeskCore.SpendCap.selector, SKUdeskCore.DailyCap.selector, SKUdeskCore.MathMismatch.selector, SKUdeskCore.NonPositiveNet.selector, SKUdeskCore.MarginTooLow.selector,
            SKUdeskCore.Unauthorized.selector, SKUdeskCore.Paused.selector, SKUdeskCore.BadQuoteHash.selector, SKUdeskCore.FutureObservation.selector, SKUdeskCore.Replay.selector];
        string[14] memory names = ['accepted', 'Stale', 'BadUnits', 'OutOfBounds', 'SpendCap', 'DailyCap', 'MathMismatch', 'NonPositiveNet', 'MarginTooLow',
            'Unauthorized', 'Paused', 'BadQuoteHash', 'FutureObservation', 'Replay'];
        uint256 liesCaught; uint256 honestAccepted; uint256 exactCapAccepted; uint256 capPlusOneRefused;
        for (uint256 i = 0; i < 3000; i++) {
            if (i % 97 == 0) vm.warp(_now() + 1 days); // crosses UTC midnight: the model must apply the reset
            (Case memory k, uint8 mode) = _gen(i); bytes4 o = _run(k);
            for (uint256 j = 0; j < 14; j++) if (o == cls[j]) cnt[j]++;
            if (mode >= 5 && mode <= 7 && o == SKUdeskCore.MathMismatch.selector) liesCaught++;
            if (mode < 5 && k.pre == 0 && o == bytes4(0)) honestAccepted++;
            if (k.pre == 6 && o == bytes4(0)) exactCapAccepted++;
            if (k.pre == 7 && o == SKUdeskCore.DailyCap.selector) capPlusOneRefused++;
            require(!(mode >= 5 && mode <= 7 && o == bytes4(0)), 'E4: a lie was accepted');
        }
        for (uint256 j = 0; j < 14; j++) { emit log_named_uint(names[j], cnt[j]); require(cnt[j] > 0, string.concat('outcome class never reached: ', names[j])); }
        emit log_named_uint('honest accepted', honestAccepted); emit log_named_uint('lies caught by MathMismatch', liesCaught);
        emit log_named_uint('spend == remaining daily cap: accepted', exactCapAccepted); emit log_named_uint('remaining cap + 1 cent: DailyCap', capPlusOneRefused);
        require(liesCaught > 100 && honestAccepted > 100 && exactCapAccepted > 20 && capPlusOneRefused > 20, 'non-vacuous');
    }

    /// E4 (lie by exactly one unit): any honest-passing quote with net or margin off by +-1 reverts MathMismatch with the true values.
    /// forge-config: default.fuzz.runs = 3000
    function testFuzz_E4_OffByOneLieIsRejected(uint256 s, uint256 buy, uint8 which) public {
        c.setPolicy(type(uint128).max, type(uint128).max, 100, 180);
        s = bound(s, 1_000, 1e12); buy = bound(buy, 0, s / 2);
        EconLib.Quote memory q = EconLib.Quote(buy, 0, 0, 0, 0, 0, s, 800, 0, 200, 0);
        Ref.R memory e = Ref.quote(q); vm.assume(e.net > 0 && e.marginBps >= 100);
        int256 n = e.net; uint256 b = e.marginBps; which %= 4;
        if (which == 0) n += 1; else if (which == 1) n -= 1; else if (which == 2) b += 1; else b -= 1;
        vm.expectRevert(abi.encodeWithSelector(SKUdeskCore.MathMismatch.selector, n, e.net, b, e.marginBps));
        vm.prank(agent); c.commitOpportunity(PROD, qh(q), bytes32(s), _now(), 1, q, n, b);
        vm.prank(agent); c.commitOpportunity(PROD, qh(q), bytes32(s), _now(), 1, q, e.net, e.marginBps); // the honest claim passes
    }

    // ------------------------------------------------------------------ E2: extreme but accepted values through the whole lifecycle
    function test_E2_ExtremeLifecycleHasNoPanic() public {
        c.setPolicy(type(uint256).max, type(uint256).max, 100, type(uint256).max);
        // largest profitable landed with sell = MAX_FIELD and zero fees: landed = 1e12 - 1, net = 1; spend = landed * 1e9 ~ 1e21 cents
        EconLib.Quote memory q = EconLib.Quote(MAXF - 1 - 5, 1, 1, 1, 1, 1, MAXF, 0, 0, 0, 0);
        Ref.R memory e = Ref.quote(q); require(e.net == 1 && e.marginBps == 0, 'precondition');
        vm.expectRevert(abi.encodeWithSelector(SKUdeskCore.MarginTooLow.selector, uint256(0), uint256(100)));
        vm.prank(agent); c.commitOpportunity(PROD, qh(q), bytes32(0), _now(), 1e9, q, 1, 0);
        q.purchaseCents = MAXF / 2; e = Ref.quote(q); // margin ~ 50%
        vm.prank(agent); (bytes32 id,,) = c.commitOpportunity(PROD, qh(q), bytes32(0), _now(), 1e9, q, e.net, e.marginBps);
        vm.startPrank(agent); uint256 lot = c.mintLot(id); c.fundLot(lot);
        uint256 amt = e.landed * 1e9 * CENT; require(c.escrow(lot) == amt && amt < 1e26, 'escrow = spend*CENT <= 6e25');
        c.markPurchased(lot, supplier, amt); c.markReceived(lot); c.markListed(lot); c.markSold(lot);
        c.settle(lot, market, 1e12 * 1e9 * CENT); vm.stopPrank();
        require(c.free() + c.totalEscrow() + c.totalPaidOut() == c.totalDeposited() + c.totalProceeds() - c.totalWithdrawn(), 'E6 holds at the extremes');
        // the worst corner (every field at its maximum, units at the maximum) is a clean NonPositiveNet, never a panic
        EconLib.Quote memory w = EconLib.Quote(MAXF, MAXF, MAXF, MAXF, MAXF, MAXF, MAXF, MAXB, MAXF, MAXB, MAXF);
        Ref.R memory we = Ref.quote(w);
        vm.expectRevert(abi.encodeWithSelector(SKUdeskCore.NonPositiveNet.selector, we.net));
        vm.prank(agent); c.commitOpportunity(PROD, qh(w), bytes32(uint256(1)), _now(), 1e9, w, we.net, 0);
    }

    // ------------------------------------------------------------------ E5: caps
    function _honest(uint256 landed, uint256 tag) internal returns (bytes32 id) {
        EconLib.Quote memory q = EconLib.Quote(landed, 0, 0, 0, 0, 0, landed * 2 + 10, 0, 0, 0, 0); Ref.R memory e = Ref.quote(q);
        vm.prank(agent); (id,,) = c.commitOpportunity(PROD, qh(q), bytes32(tag), _now(), 1, q, e.net, e.marginBps);
    }
    /// E5(iii): the per-UTC-day cap allows exactly 2*cap within two consecutive seconds across midnight, and not one cent more.
    function test_E5_MidnightAllowsExactlyTwoCapsInTwoSeconds() public {
        uint256 cap = 300_000; c.setPolicy(cap, cap, 100, 180);
        uint256 midnight = (_now() / 1 days + 1) * 1 days;
        vm.warp(midnight - 1); _honest(cap, 1);
        vm.expectRevert(abi.encodeWithSelector(SKUdeskCore.DailyCap.selector, cap + 1, cap)); _honestExpectFail(1, 2);
        vm.warp(midnight); _honest(cap, 3);
        vm.expectRevert(abi.encodeWithSelector(SKUdeskCore.DailyCap.selector, cap + 1, cap)); _honestExpectFail(1, 4);
        // 2 * cap committed in the window [midnight-1, midnight], i.e. within 2 seconds; the bound 2*cap is attained (tight)
    }
    function _honestExpectFail(uint256 landed, uint256 tag) internal {
        EconLib.Quote memory q = EconLib.Quote(landed, 0, 0, 0, 0, 0, landed * 2 + 10, 0, 0, 0, 0); Ref.R memory e = Ref.quote(q);
        vm.prank(agent); c.commitOpportunity(PROD, qh(q), bytes32(tag), _now(), 1, q, e.net, e.marginBps);
    }
    /// E5(iii): over random schedules, per-UTC-day sums <= cap and every rolling 24h window <= 2*cap.
    /// forge-config: default.fuzz.runs = 1000
    function testFuzz_E5_RollingWindowNeverExceedsTwoCaps(uint256 seed) public {
        uint256 cap = 200_000; c.setPolicy(cap, cap, 100, 180);
        uint256[] memory ts = new uint256[](40); uint256[] memory sp = new uint256[](40); uint256 n;
        for (uint256 i = 0; i < 40; i++) {
            vm.warp(_now() + _r(seed, i) % 30_000);
            uint256 landed = 1 + _r(seed, 100 + i) % 120_000;
            EconLib.Quote memory q = EconLib.Quote(landed, 0, 0, 0, 0, 0, landed * 2 + 10, 0, 0, 0, 0); Ref.R memory e = Ref.quote(q);
            vm.prank(agent);
            try c.commitOpportunity(PROD, qh(q), bytes32(i), _now(), 1, q, e.net, e.marginBps) { ts[n] = _now(); sp[n] = landed; n++; } catch {}
        }
        for (uint256 i = 0; i < n; i++) {
            uint256 day; uint256 win;
            for (uint256 j = 0; j < n; j++) { if (ts[j] / 1 days == ts[i] / 1 days) day += sp[j]; if (ts[j] >= ts[i] && ts[j] < ts[i] + 1 days) win += sp[j]; }
            require(day <= cap, 'E5 per UTC day <= cap'); require(win <= 2 * cap, 'E5 rolling 24h <= 2*cap');
        }
        require(n > 0, 'some commits succeeded');
    }
    /// E5(ii): lowering the cap mid-day does not reset the counter: the vault refuses everything until the next UTC midnight.
    function test_E5_LoweringTheCapMidDayFreezesTheRestOfTheDay() public {
        c.setPolicy(500_000, 500_000, 100, 180); _honest(400_000, 1);
        c.setPolicy(100_000, 500_000, 100, 180);
        vm.expectRevert(abi.encodeWithSelector(SKUdeskCore.DailyCap.selector, uint256(400_001), uint256(100_000))); _honestExpectFail(1, 2);
        vm.warp((_now() / 1 days + 1) * 1 days); _honest(100_000, 3);
    }
    /// FINDING F-V1: the daily cap limits COMMITMENTS per UTC day, not CASH-OUT per day. Opportunities never expire, so
    /// commitments banked over k days can all be funded and paid to a payee in ONE block: k * cap * CENT base units.
    function test_F_V1_BankedCommitmentsPayKCapsInOneBlock() public {
        uint256 cap = 250_000; uint256 k = 5; c.setPolicy(cap, cap, 100, 180);
        bytes32[] memory ids = new bytes32[](k);
        for (uint256 d = 0; d < k; d++) { ids[d] = _honest(cap, 100 + d); vm.warp(_now() + 1 days); }
        uint256 paid0 = c.totalPaidOut(); uint256 t = _now();
        vm.startPrank(agent);
        for (uint256 d = 0; d < k; d++) { uint256 lot = c.mintLot(ids[d]); c.fundLot(lot); c.markPurchased(lot, supplier, cap * CENT); }
        vm.stopPrank();
        require(_now() == t && c.totalPaidOut() - paid0 == k * cap * CENT, 'k caps paid out within one block');
        _honest(cap, 999); // and a full fresh cap can still be committed the same day: exposure created today = (k + 1) * cap
    }

    // ------------------------------------------------------------------ audit items, stated as checks (docs/proofs/FINDINGS.md)
    /// F-V3: replay protection is per (productHash, quoteHash, snapshotHash); the agent picks snapshotHash, so the SAME quote
    /// commits N times with N different snapshot hashes. Only the caps bound it.
    function test_F_V3_SameQuoteCommitsUnderFreshSnapshotHashes() public {
        c.setPolicy(type(uint128).max, type(uint128).max, 100, 180);
        EconLib.Quote memory q = EconLib.Quote(590, 42, 12, 8, 5, 2, 1099, 800, 65, 200, 4);
        for (uint256 i = 0; i < 20; i++) { vm.prank(agent); c.commitOpportunity(PROD, qh(q), keccak256(abi.encode(i)), _now(), 10, q, 261, 2374); }
        require(c.spentToday() == 20 * 6590, '20 commits of one quote');
    }
    /// F-V4: freshness is self-reported: observedAt = _now() always passes Stale, whatever the real age of the data.
    function test_F_V4_ObservedAtIsAgentChosen() public {
        EconLib.Quote memory q = EconLib.Quote(590, 42, 12, 8, 5, 2, 1099, 800, 65, 200, 4); uint256 trueObservation = _now() - 365 days;
        vm.expectRevert(abi.encodeWithSelector(SKUdeskCore.Stale.selector, uint256(365 days), uint256(180)));
        vm.prank(agent); c.commitOpportunity(PROD, qh(q), bytes32(0), trueObservation, 10, q, 261, 2374);
        vm.prank(agent); c.commitOpportunity(PROD, qh(q), bytes32(0), _now(), 10, q, 261, 2374); // same year-old data, claimed fresh
    }
    /// F-V5: proceeds are agent-chosen within the payer's allowance: settle(…, 0) books a full loss; conservation still holds.
    function test_F_V5_AgentChoosesProceeds() public {
        c.setPolicy(type(uint128).max, type(uint128).max, 100, 180);
        bytes32 id = _honest(1_000, 7);
        vm.startPrank(agent); uint256 lot = c.mintLot(id); c.fundLot(lot); c.markPurchased(lot, supplier, 1_000 * CENT);
        c.markReceived(lot); c.markListed(lot); c.markSold(lot); c.settle(lot, market, 0); vm.stopPrank();
        require(c.totalProceeds() == 0 && c.totalPaidOut() == 1_000 * CENT, 'realized = -spend, chosen by the agent');
        require(c.free() + c.totalEscrow() + c.totalPaidOut() == c.totalDeposited() + c.totalProceeds() - c.totalWithdrawn(), 'E6');
    }
    /// F-V6: an all-zero-cost quote is accepted: spend 0, a lot funded with 0 (no money at risk; a free event-log entry).
    function test_F_V6_ZeroSpendOpportunityIsAccepted() public {
        EconLib.Quote memory q = EconLib.Quote(0, 0, 0, 0, 0, 0, 100, 0, 0, 0, 0);
        vm.prank(agent); (bytes32 id, uint256 m, int256 n) = c.commitOpportunity(PROD, qh(q), bytes32(0), _now(), 1e9, q, 100, 10_000);
        require(m == 10_000 && n == 100, '100% margin');
        vm.startPrank(agent); uint256 lot = c.mintLot(id); c.fundLot(lot); vm.stopPrank(); require(c.escrow(lot) == 0, 'zero escrow');
    }
}

/// A token that burns 1% on every transfer (fee-on-transfer), to show which assumption the custody theorem needs.
contract FeeToken {
    mapping(address => uint256) public balanceOf; mapping(address => mapping(address => uint256)) public allowance;
    function mint(address to, uint256 a) external { balanceOf[to] += a; }
    function approve(address s, uint256 a) external returns (bool) { allowance[msg.sender][s] = a; return true; }
    function transfer(address to, uint256 a) external returns (bool) { _mv(msg.sender, to, a); return true; }
    function transferFrom(address f, address to, uint256 a) external returns (bool) { allowance[f][msg.sender] -= a; _mv(f, to, a); return true; }
    function _mv(address f, address to, uint256 a) internal { balanceOf[f] -= a; balanceOf[to] += a - a / 100; }
}

contract ProofsCustodyAssumptionsTest is Test {
    /// F-V7: deposit() credits the NOMINAL amount (only settle() measures what arrived). With a fee-on-transfer token the
    /// ledger exceeds custody and the last withdrawal fails: the custody theorem needs assumption A1 (exact transfers).
    function test_F_V7_FeeOnTransferTokenBreaksCustody() public {
        FeeToken t = new FeeToken(); SKUdeskCore c = new SKUdeskCore(address(t), address(0xA11CE));
        t.mint(address(this), 1_000_000); t.approve(address(c), type(uint256).max); c.deposit(1_000_000);
        require(c.free() == 1_000_000 && t.balanceOf(address(c)) == 990_000, 'free 1,000,000 but only 990,000 in custody');
        vm.expectRevert(SKUdeskCore.TransferFailed.selector); c.withdraw(1_000_000);
    }
    /// F-V8: the cumulative counters are monotone; with an owner-mintable token (MockUSDC) the owner can push totalDeposited
    /// past 2^256 by cycling deposit/withdraw, after which deposit() panics. Unreachable with a real supply (needs 2^256 base units).
    function test_F_V8_CumulativeCounterOverflowIsAnOwnerSelfDoS() public {
        MockUSDC u = new MockUSDC(); SKUdeskCore c = new SKUdeskCore(address(u), address(0xA11CE));
        uint256 half = 2 ** 255; u.mint(address(this), half); u.approve(address(c), type(uint256).max);
        c.deposit(half); c.withdraw(half);
        vm.expectRevert(stdError.arithmeticError); c.deposit(half);
    }
}

// ====================================================================== E6: stateful conservation proof (induction, checked)
/// Handler WITHOUT setUp (the existing handlers inherit a public setUp that the invariant fuzzer calls mid-run, resetting state).
/// The handler is the vault owner. Every revert is classified; a Panic (0x4e487b71) is a theorem violation (E2).
contract CoreHandler is Test {
    SKUdeskCore public c; MockUSDC public usdc;
    address public constant agent = address(0xA11CE); address public constant supplier = address(0x5011); address public constant market = address(0xBEEF);
    uint256 public constant CAP = 400_000; uint256 public constant MAXEXEC = 150_000; uint256 public constant CENT = 10_000; uint256 public constant MARKET_FUNDS = 1e18;
    bytes32[] public oppIds; uint256[] public lotIds; uint256 nonce; bool flip;
    uint256[] public cts; uint256[] public csp; // every accepted commit: timestamp and spend (cents)
    uint256 public commitsOk; uint256 public liesRejected; uint256 public liesAccepted; uint256 public funded; uint256 public purchased;
    uint256 public settled; uint256 public refunded; uint256 public midnights; uint256 public withdrawals; uint256 public deposits; uint256 public panics;
    // Preconditions of E5(i)/E6 (one lot per opportunity, replay protection), attacked on purpose. Ghost state is the handler's
    // own record: what the contract SHOULD have done, so a contract that forgets a guard is caught here, not only in a unit test.
    struct Com { EconLib.Quote q; bytes32 snap; uint256 obs; uint256 units; int256 net; uint256 bps; }
    mapping(bytes32 => Com) com; mapping(bytes32 => uint256) public lotsOf;
    uint256 public maxLotsPerOpp; uint256 public committedSpend; uint256 public guardViolations;
    uint256 public replaysRejected; uint256 public doubleMintsRejected; uint256 public calls;
    modifier counted() { calls++; _; }

    constructor() {
        vm.warp(1_000_000_000);
        usdc = new MockUSDC(); c = new SKUdeskCore(address(usdc), agent);
        c.setPolicy(CAP, MAXEXEC, 1800, 180); c.setPayee(supplier, true); c.setPayer(market, true);
        usdc.mint(address(this), 1e18); usdc.approve(address(c), type(uint256).max); c.deposit(5e12);
        usdc.mint(market, MARKET_FUNDS); vm.prank(market); usdc.approve(address(c), type(uint256).max);
    }
    function _now() internal view returns (uint256) { return vm.getBlockTimestamp(); }
    function nLots() external view returns (uint256) { return lotIds.length; }
    function nCommits() external view returns (uint256) { return cts.length; }
    function commitLog() external view returns (uint256[] memory, uint256[] memory) { return (cts, csp); }
    function _rec(bytes memory d) internal { if (d.length >= 4 && bytes4(d) == bytes4(0x4e487b71)) panics++; }
    /// good = a quote that always clears the 1800 bps floor and, with units <= 200, the per-lot cap (net >= 352, spend <= 113,600).
    function _quote(uint256 x, bool good) internal pure returns (EconLib.Quote memory q, int256 net, uint256 bps) {
        uint256 buy = 400 + x % (good ? 100 : 400); q = EconLib.Quote(buy, 42, 12, 8, 5, 2, 1099 + (x >> 16) % 600, 800, 65, 200, 4);
        Ref.R memory e = Ref.quote(q); net = e.net; bps = e.marginBps;
    }
    function _commit(uint256 x, bool lie, bool good, uint256 units) internal returns (bytes4 out, bytes32 id) {
        (EconLib.Quote memory q, int256 net, uint256 bps) = _quote(x, good);
        if (lie) { if ((x >> 40) % 2 == 0) net += 1 + int256((x >> 48) % 5); else bps += 1; }
        vm.prank(agent);
        bytes32 snap = keccak256(abi.encode(++nonce));
        try c.commitOpportunity(keccak256('P'), keccak256(abi.encode(q)), snap, _now(), units, q, net, bps) returns (bytes32 i, uint256, int256) {
            if (lie) liesAccepted++;
            (, , , uint256 spend, , , ) = c.opps(i); cts.push(_now()); csp.push(spend); commitsOk++; oppIds.push(i);
            com[i] = Com(q, snap, _now(), units, net, bps); committedSpend += spend; return (bytes4(0), i);
        } catch (bytes memory d) { _rec(d); out = bytes4(d); if (out == bytes4(0)) out = bytes4(0xffffffff); if (lie && out == SKUdeskCore.MathMismatch.selector) liesRejected++; }
    }
    /// Mint a lot. Expected outcome from the ghost alone: a committed opportunity mints exactly once (the handler never pauses and
    /// always calls as the agent); every later attempt must revert with exactly OpportunityConsumed(oppHash).
    function _mint(bytes32 opp) internal returns (uint256 lot, bool ok) {
        bool wasMinted = lotsOf[opp] > 0;
        vm.prank(agent);
        try c.mintLot(opp) returns (uint256 id) {
            lotsOf[opp]++; if (lotsOf[opp] > maxLotsPerOpp) maxLotsPerOpp = lotsOf[opp];
            lotIds.push(id); if (wasMinted) guardViolations++; return (id, true);
        } catch (bytes memory d) {
            _rec(d);
            if (wasMinted && keccak256(d) == keccak256(abi.encodeWithSelector(SKUdeskCore.OpportunityConsumed.selector, opp))) doubleMintsRejected++;
            else guardViolations++;
        }
    }
    /// Re-submit an accepted commit with the identical (productHash, quoteHash, snapshotHash) and its original observedAt, so checks
    /// 1-4 pass: it must revert with exactly Replay(oppHash) (check 5), whatever the time and the caps.
    function _replay(bytes32 opp) internal {
        Com storage k = com[opp]; EconLib.Quote memory q = k.q;
        vm.prank(agent);
        try c.commitOpportunity(keccak256('P'), keccak256(abi.encode(q)), k.snap, k.obs, k.units, q, k.net, k.bps) returns (bytes32, uint256, int256) { guardViolations++; }
        catch (bytes memory d) {
            _rec(d);
            if (keccak256(d) == keccak256(abi.encodeWithSelector(SKUdeskCore.Replay.selector, opp))) replaysRejected++; else guardViolations++;
        }
    }
    function _nextDay() internal { vm.warp((_now() / 1 days + 1) * 1 days + 1); midnights++; }
    function _lot(uint256 i) internal view returns (uint256) { return lotIds[i % lotIds.length]; }
    function _status(uint256 id) internal view returns (SKUdeskCore.LS s) { (, , , , , s) = c.lots(id); }

    // ---- actions (the only selectors the fuzzer may call)
    function commit(uint256 x, bool lie) external counted { _commit(x, lie, false, 1 + (x >> 32) % 300); }
    /// Mints from a random committed opportunity: the first mint must succeed, every later one must revert OpportunityConsumed.
    function mint(uint256 i) external counted { if (oppIds.length == 0) return; _mint(oppIds[i % oppIds.length]); }
    /// Replays a random accepted commit: must revert with exactly Replay(oppHash).
    function replay(uint256 i) external counted { if (oppIds.length == 0) return; _replay(oppIds[i % oppIds.length]); }
    function fund(uint256 i) external counted { if (lotIds.length == 0) return; vm.prank(agent); try c.fundLot(_lot(i)) { funded++; } catch (bytes memory d) { _rec(d); } }
    function purchase(uint256 i, uint256 amt) external counted {
        if (lotIds.length == 0) return; uint256 id = _lot(i); amt = bound(amt, 0, c.escrow(id) + 1);
        vm.prank(agent); try c.markPurchased(id, supplier, amt) { purchased++; } catch (bytes memory d) { _rec(d); }
    }
    function advance(uint256 i) external counted {
        if (lotIds.length == 0) return; uint256 id = _lot(i); vm.startPrank(agent);
        try c.markReceived(id) {} catch (bytes memory d) { _rec(d); } try c.markListed(id) {} catch (bytes memory d) { _rec(d); } try c.markSold(id) {} catch (bytes memory d) { _rec(d); }
        vm.stopPrank();
    }
    function settle(uint256 i, uint256 proceeds) external counted {
        if (lotIds.length == 0) return; uint256 id = _lot(i); proceeds = bound(proceeds, 0, 2 * MAXEXEC * CENT);
        vm.prank(agent); try c.settle(id, market, proceeds) { settled++; } catch (bytes memory d) { _rec(d); }
    }
    function cancelRefund(uint256 i) external counted {
        if (lotIds.length == 0) return; uint256 id = _lot(i); vm.startPrank(agent);
        try c.cancel(id) {} catch (bytes memory d) { _rec(d); } try c.refund(id) { refunded++; } catch (bytes memory d) { _rec(d); }
        vm.stopPrank();
    }
    function deposit(uint256 x) external counted { x = bound(x, 0, 1e13); try c.deposit(x) { deposits++; } catch (bytes memory d) { _rec(d); } }
    function withdraw(uint256 x) external counted { x = bound(x, 0, c.free() + 1); try c.withdraw(x) { withdrawals++; } catch (bytes memory d) { _rec(d); } }
    /// Jump to one second before the next UTC midnight, commit, cross midnight, commit again.
    function midnight(uint256 x) external counted {
        vm.warp((_now() / 1 days + 1) * 1 days - 1); _commit(x, false, true, 1 + (x >> 32) % 200);
        vm.warp(_now() + 1); midnights++; _commit(x >> 8, false, true, 1 + (x >> 40) % 200);
    }
    function warp(uint256 dt) external counted { vm.warp(_now() + bound(dt, 0, 3 days)); }
    /// A whole honest lifecycle plus one lie that must be rejected with MathMismatch, one replay of the accepted commit (must be
    /// Replay) and one second mint of its opportunity (must be OpportunityConsumed). Deterministic success: if today's cap is used
    /// up it moves to the next UTC day. Alternates settle / cancel+refund so both closing paths run in every campaign.
    function lifecycle(uint256 x, uint256 pay, uint256 proceeds) external counted {
        uint256 units = 1 + (x >> 32) % 200;
        (bytes4 o, bytes32 id) = _commit(x, false, true, units);
        if (o != bytes4(0)) { _nextDay(); (o, id) = _commit(x, false, true, units); require(o == bytes4(0), 'good quote on a fresh day'); }
        (o, ) = _commit(x, true, true, 1);
        if (o != SKUdeskCore.MathMismatch.selector) { _nextDay(); (o, ) = _commit(x, true, true, 1); require(o == SKUdeskCore.MathMismatch.selector, 'a lie under every cap is rejected'); }
        (uint256 lot, bool ok) = _mint(id); require(ok, 'a fresh opportunity mints');
        _replay(id); _mint(id);
        (, , uint256 spend, , , ) = c.lots(lot);
        if (c.free() < spend * CENT) c.deposit(spend * CENT);
        vm.startPrank(agent);
        c.fundLot(lot); funded++;
        pay = bound(pay, 0, c.escrow(lot)); c.markPurchased(lot, supplier, pay); purchased++;
        flip = !flip;
        if (flip) { c.markReceived(lot); c.markListed(lot); c.markSold(lot); c.settle(lot, market, bound(proceeds, 0, 2 * MAXEXEC * CENT)); settled++; }
        else { c.cancel(lot); c.refund(lot); refunded++; }
        vm.stopPrank();
    }
}

contract ProofsCoreInvariantTest is Test {
    CoreHandler h; SKUdeskCore c; MockUSDC usdc;
    function setUp() public {
        h = new CoreHandler(); c = h.c(); usdc = h.usdc(); targetContract(address(h));
        bytes4[] memory s = new bytes4[](13);
        s[0] = CoreHandler.commit.selector; s[1] = CoreHandler.mint.selector; s[2] = CoreHandler.fund.selector; s[3] = CoreHandler.purchase.selector;
        s[4] = CoreHandler.advance.selector; s[5] = CoreHandler.settle.selector; s[6] = CoreHandler.cancelRefund.selector; s[7] = CoreHandler.deposit.selector;
        s[8] = CoreHandler.withdraw.selector; s[9] = CoreHandler.midnight.selector; s[10] = CoreHandler.warp.selector; s[11] = CoreHandler.lifecycle.selector;
        s[12] = CoreHandler.replay.selector;
        targetSelector(FuzzSelector({addr: address(h), selectors: s}));
    }
    /// E6: free + totalEscrow + totalPaidOut == totalDeposited + totalProceeds - totalWithdrawn; custody is exact; ledgers agree.
    /// forge-config: default.invariant.runs = 96
    /// forge-config: default.invariant.depth = 200
    /// forge-config: default.invariant.fail-on-revert = true
    function invariant_E6_ConservationAndExactCustody() public view {
        assertEq(c.free() + c.totalEscrow() + c.totalPaidOut(), c.totalDeposited() + c.totalProceeds() - c.totalWithdrawn(), 'E6 conservation');
        assertEq(usdc.balanceOf(address(c)), c.free() + c.totalEscrow(), 'E6 custody: balance == free + escrow (std token, no donations)');
        assertEq(usdc.balanceOf(h.supplier()), c.totalPaidOut(), 'every paid-out token reached the allowlisted payee');
        assertEq(h.MARKET_FUNDS() - usdc.balanceOf(h.market()), c.totalProceeds(), 'proceeds == tokens actually pulled from the payer');
        uint256 se; uint256 sp; uint256 n = c.nextLot();
        for (uint256 i = 1; i <= n; i++) { se += c.escrow(i); sp += c.paidOut(i); }
        assertEq(se, c.totalEscrow(), 'totalEscrow == sum escrow[lot]'); assertEq(sp, c.totalPaidOut(), 'totalPaidOut == sum paidOut[lot]');
    }
    /// E5 + per-lot accounting: each lot holds exactly its committed spend between funding and closing; caps hold per day and per 24h.
    /// forge-config: default.invariant.runs = 96
    /// forge-config: default.invariant.depth = 200
    /// forge-config: default.invariant.fail-on-revert = true
    function invariant_E5_LotsAndCaps() public view {
        uint256 n = c.nextLot(); uint256 lotSpend;
        for (uint256 i = 1; i <= n; i++) {
            (uint256 units, uint256 landed, uint256 spend, , bytes32 opp, SKUdeskCore.LS s) = c.lots(i);
            assertEq(spend, landed * units, 'spend derived'); assertLe(spend, h.MAXEXEC(), 'per-lot cap');
            (, , , uint256 oSpend, , bool exists, bool consumed) = c.opps(opp);
            assertTrue(exists && consumed, 'a lot exists only for a committed opportunity, marked consumed'); assertEq(spend, oSpend, 'lot spend == its opportunity spend');
            lotSpend += spend;
            uint256 e = c.escrow(i); uint256 p = c.paidOut(i);
            if (s == SKUdeskCore.LS.CREATED) assertEq(e + p, 0, 'unfunded lot holds nothing');
            else if (s == SKUdeskCore.LS.SETTLED || s == SKUdeskCore.LS.REFUNDED) { assertEq(e, 0, 'closed lot holds no escrow'); assertLe(p, spend * 10_000, 'paid <= committed'); }
            else assertEq(e + p, spend * 10_000, 'open lot: escrow + paid == committed spend * CENT');
        }
        assertLe(h.maxLotsPerOpp(), 1, 'at most one lot per opportunity');
        assertLe(lotSpend, h.committedSpend(), 'sum of lot spend <= sum of committed spend');
        assertLe(c.spentToday(), h.CAP(), 'spentToday <= cap');
        // commits are logged in time order (time only moves forward), so two pointers give every per-day and rolling-24h sum in O(m)
        (uint256[] memory ts, uint256[] memory sp) = h.commitLog(); uint256 m = ts.length;
        uint256 day; uint256 win; uint256 j;
        for (uint256 i = 0; i < m; i++) {
            if (i == 0 || ts[i] / 1 days != ts[i - 1] / 1 days) day = 0;
            day += sp[i]; assertLe(day, h.CAP(), 'per UTC day <= cap');
            win += sp[i]; while (ts[j] + 1 days <= ts[i]) { win -= sp[j]; j++; }
            assertLe(win, 2 * h.CAP(), 'every rolling 24h window <= 2 * cap');
        }
    }
    /// E2 + E4 inside random sequences: no checked-arithmetic panic ever; no lie ever accepted.
    /// forge-config: default.invariant.runs = 96
    /// forge-config: default.invariant.depth = 200
    /// forge-config: default.invariant.fail-on-revert = true
    function invariant_E2_E4_NoPanicNoAcceptedLie() public view { assertEq(h.panics(), 0, 'no Panic'); assertEq(h.liesAccepted(), 0, 'no lie accepted'); }
    /// E4 check 5 + E5(i) preconditions: every replay reverted with exactly Replay(oppHash) and every second mint with exactly
    /// OpportunityConsumed(oppHash); every first mint succeeded.
    /// forge-config: default.invariant.runs = 96
    /// forge-config: default.invariant.depth = 200
    /// forge-config: default.invariant.fail-on-revert = true
    function invariant_E4_E5_ReplayAndDoubleMintRejectedExactly() public view { assertEq(h.guardViolations(), 0, 'replay / double-mint guard'); }
    /// Non-vacuity: every run must really exercise the transitions the theorems talk about. The floors apply only to a campaign of
    /// normal length: forge first replays a saved failing sequence from cache/invariant, which can be a single call, and such a
    /// replay must report the original failure, not a spurious activity-floor failure.
    function afterInvariant() public view {
        if (h.calls() < 50) return;
        require(h.replaysRejected() > 0 && h.doubleMintsRejected() > 0, 'activity: replay/double-mint attempts');
        require(h.commitsOk() > 0 && h.liesRejected() > 0 && h.funded() > 0 && h.purchased() > 0, 'activity: commit/lie/fund/purchase');
        require(h.settled() > 0 && h.refunded() > 0 && h.midnights() > 0, 'activity: settle/refund/midnight');
    }
}
