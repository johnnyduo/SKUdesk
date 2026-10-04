// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {Test} from 'forge-std/Test.sol';
import {SKUdeskCore} from '../src/SKUdeskCore.sol';
import {EconLib} from '../src/EconLib.sol';
import {MockUSDC} from '../src/MockUSDC.sol';

/// Hero: buy 590 +42+12+8+5+2 = landed 659; sell 1099; mkt 800bps->88; ful 65; ret 200bps->22; chain 4
/// net = 1099-88-65-22-659-4 = 261 ($2.61); margin = floor(261*10000/1099) = 2374 (23.74%) >= 1800 PASS
contract Base is Test {
    SKUdeskCore public c; MockUSDC public usdc;
    address agent = address(0xA11CE); address supplier = address(0x5011); address market = address(0xBEEF);
    bytes32 constant PROD = keccak256('CASE-IP16PRO-CLEAR-MAG-001');
    bytes32 constant SNAP = keccak256('snapshot-1');
    uint256 constant CENT = 10_000;

    function setUp() public virtual {
        usdc = new MockUSDC();
        c = new SKUdeskCore(address(usdc), agent);
        usdc.mint(address(this), 10_000_000_000); // $10,000
        usdc.approve(address(c), type(uint256).max);
        c.deposit(5_000_000_000);                  // $5,000 into the vault
        c.setPayee(supplier, true);
        c.setPayer(market, true);
        usdc.mint(market, 10_000_000_000);
        vm.prank(market); usdc.approve(address(c), type(uint256).max);
        vm.warp(1_000_000);
    }
    function HQ() internal pure returns (EconLib.Quote memory) { return EconLib.Quote(590, 42, 12, 8, 5, 2, 1099, 800, 65, 200, 4); }
    function qh(EconLib.Quote memory q) internal pure returns (bytes32) { return keccak256(abi.encode(q)); }
    function commit(EconLib.Quote memory q, uint256 units, uint256 observedAt, int256 net, uint256 bps) internal returns (bytes32 oppHash) {
        vm.prank(agent);
        (oppHash,,) = c.commitOpportunity(PROD, qh(q), SNAP, observedAt, units, q, net, bps);
    }
    function commitHero(uint256 units) internal returns (bytes32) { return commit(HQ(), units, vm.getBlockTimestamp(), 261, 2374); }
}

contract EconTest is Test {
    function testMathHero() public pure {
        EconLib.Result memory r = EconLib.quote(EconLib.Quote(590, 42, 12, 8, 5, 2, 1099, 800, 65, 200, 4));
        require(r.landed == 659 && r.mktFee == 88 && r.ret == 22 && r.net == 261 && r.marginBps == 2374 && r.breakeven == 838 && r.maxBuy == 769, 'hero');
        require(EconLib.batchProfit(r.net, 240, 1800) == 60840, 'batch');
    }
    function testFuzzParity(uint256 buy, uint256 sell) public pure {
        buy = 100 + (buy % 2000); sell = 200 + (sell % 5000);
        EconLib.Result memory r = EconLib.quote(EconLib.Quote(buy, 42, 12, 8, 5, 2, sell, 800, 65, 200, 4));
        require(r.landed == buy + 69, 'landed');
        require(r.breakeven == r.landed + r.mktFee + 65 + r.ret + 4, 'breakeven');
        require(r.mktFee * 10000 >= sell * 800 && (r.mktFee - 1) * 10000 < sell * 800, 'fee is ceil');
    }
}

contract CommitTest is Base {
    event OpportunityCommitted(bytes32 indexed oppHash, bytes32 productHash, bytes32 quoteHash, bytes32 snapshotHash, uint256 observedAt, uint256 units, uint256 spendCents, uint256 marginBps, uint256 netCents);

    function testCommitPassesAndDerivesSpend() public {
        bytes32 id = commitHero(240);
        require(id == keccak256(abi.encode(PROD, qh(HQ()), SNAP)), 'oppHash derived on-chain');
        require(c.spentToday() == 158160, 'spend = landed * units, not agent supplied'); // 659 * 240
        (, , , uint256 spend, , bool exists, bool consumed) = c.opps(id);
        require(exists && !consumed && spend == 158160, 'stored');
    }
    function testEmitsCommitEvent() public {
        bytes32 id = keccak256(abi.encode(PROD, qh(HQ()), SNAP));
        vm.expectEmit(true, false, false, true);
        emit OpportunityCommitted(id, PROD, qh(HQ()), SNAP, vm.getBlockTimestamp(), 240, 158160, 2374, 261);
        commitHero(240);
    }
    function testLieAboutNetRevertsWithBothNumbers() public {
        EconLib.Quote memory q = HQ(); uint256 t = vm.getBlockTimestamp();
        vm.expectRevert(abi.encodeWithSelector(SKUdeskCore.MathMismatch.selector, int256(390), int256(261), uint256(2374), uint256(2374)));
        vm.prank(agent); c.commitOpportunity(PROD, qh(q), SNAP, t, 240, q, 390, 2374);
    }
    function testLieAboutMarginReverts() public {
        EconLib.Quote memory q = HQ(); uint256 t = vm.getBlockTimestamp();
        vm.expectRevert(abi.encodeWithSelector(SKUdeskCore.MathMismatch.selector, int256(261), int256(261), uint256(3500), uint256(2374)));
        vm.prank(agent); c.commitOpportunity(PROD, qh(q), SNAP, t, 240, q, 261, 3500);
    }
    function testBadQuoteHashReverts() public {
        EconLib.Quote memory q = HQ(); uint256 t = vm.getBlockTimestamp(); bytes32 wrong = keccak256('other');
        vm.expectRevert(abi.encodeWithSelector(SKUdeskCore.BadQuoteHash.selector, qh(q), wrong));
        vm.prank(agent); c.commitOpportunity(PROD, wrong, SNAP, t, 240, q, 261, 2374);
    }
    function testFutureObservationReverts() public {
        EconLib.Quote memory q = HQ(); uint256 t = vm.getBlockTimestamp() + 500;
        vm.expectRevert(abi.encodeWithSelector(SKUdeskCore.FutureObservation.selector, t, vm.getBlockTimestamp()));
        vm.prank(agent); c.commitOpportunity(PROD, qh(q), SNAP, t, 240, q, 261, 2374);
    }
    function testReplayRevertsEvenWithSameInputs() public {
        commitHero(10);
        bytes32 id = keccak256(abi.encode(PROD, qh(HQ()), SNAP));
        EconLib.Quote memory q = HQ(); uint256 t = vm.getBlockTimestamp();
        vm.expectRevert(abi.encodeWithSelector(SKUdeskCore.Replay.selector, id));
        vm.prank(agent); c.commitOpportunity(PROD, qh(q), SNAP, t, 10, q, 261, 2374);
    }
    function testStaleRevertsWithAgeAndTtl() public {
        uint256 old = vm.getBlockTimestamp(); vm.warp(old + 200);
        EconLib.Quote memory q = HQ();
        vm.expectRevert(abi.encodeWithSelector(SKUdeskCore.Stale.selector, uint256(200), uint256(180)));
        vm.prank(agent); c.commitOpportunity(PROD, qh(q), SNAP, old, 240, q, 261, 2374);
    }
    function testPerExecutionCapRevertsWithValues() public {
        EconLib.Quote memory q = HQ(); uint256 t = vm.getBlockTimestamp(); // 659 * 400 = 263,600 > 250,000
        vm.expectRevert(abi.encodeWithSelector(SKUdeskCore.SpendCap.selector, uint256(263600), uint256(250000)));
        vm.prank(agent); c.commitOpportunity(PROD, qh(q), SNAP, t, 400, q, 261, 2374);
    }
    function testDailyCapRevertsAndResetsNextDay() public {
        // distinct quotes so oppHash differs: bump snapshot via different observedAt is irrelevant; use different snapshot
        EconLib.Quote memory q = HQ(); uint256 t = vm.getBlockTimestamp();
        vm.startPrank(agent);
        c.commitOpportunity(PROD, qh(q), keccak256('a'), t, 370, q, 261, 2374); // 243,830
        c.commitOpportunity(PROD, qh(q), keccak256('b'), t, 370, q, 261, 2374); // 487,660
        vm.expectRevert(abi.encodeWithSelector(SKUdeskCore.DailyCap.selector, uint256(731490), uint256(500000)));
        c.commitOpportunity(PROD, qh(q), keccak256('c'), t, 370, q, 261, 2374);
        vm.stopPrank();
        vm.warp(vm.getBlockTimestamp() + 1 days);
        vm.prank(agent); c.commitOpportunity(PROD, qh(q), keccak256('c'), vm.getBlockTimestamp(), 370, q, 261, 2374);
        require(c.spentToday() == 243830, 'daily counter reset');
    }
    function testWeakMarginReverts() public {
        EconLib.Quote memory weak = EconLib.Quote(590, 42, 12, 8, 5, 2, 900, 800, 65, 200, 4); // net 82, margin 911 bps
        EconLib.Result memory r = EconLib.quote(weak);
        require(r.net > 0 && r.marginBps < 1800, 'precondition: profitable but under the floor');
        uint256 t = vm.getBlockTimestamp();
        vm.expectRevert(abi.encodeWithSelector(SKUdeskCore.MarginTooLow.selector, r.marginBps, uint256(1800)));
        vm.prank(agent); c.commitOpportunity(PROD, qh(weak), SNAP, t, 10, weak, r.net, r.marginBps);
    }
    function testLossMakingReverts() public {
        EconLib.Quote memory loss = EconLib.Quote(1000, 0, 0, 0, 0, 0, 500, 800, 65, 200, 4);
        EconLib.Result memory r = EconLib.quote(loss); uint256 t = vm.getBlockTimestamp();
        require(r.net < 0, 'precondition');
        vm.expectRevert(abi.encodeWithSelector(SKUdeskCore.NonPositiveNet.selector, r.net));
        vm.prank(agent); c.commitOpportunity(PROD, qh(loss), SNAP, t, 10, loss, r.net, 0);
    }
    function testQuoteFieldOutOfBoundsReverts() public {
        EconLib.Quote memory q = HQ(); q.sellCents = 2e12; uint256 t = vm.getBlockTimestamp();
        vm.expectRevert(abi.encodeWithSelector(SKUdeskCore.OutOfBounds.selector, bytes32('sellCents'), uint256(2e12)));
        vm.prank(agent); c.commitOpportunity(PROD, qh(q), SNAP, t, 10, q, 0, 0);
    }
    function testBpsOutOfBoundsReverts() public {
        EconLib.Quote memory q = HQ(); q.mktFeeBps = 10_001; uint256 t = vm.getBlockTimestamp();
        vm.expectRevert(abi.encodeWithSelector(SKUdeskCore.OutOfBounds.selector, bytes32('mktFeeBps'), uint256(10_001)));
        vm.prank(agent); c.commitOpportunity(PROD, qh(q), SNAP, t, 10, q, 0, 0);
    }
    function testZeroAndHugeUnitsRevert() public {
        EconLib.Quote memory q = HQ(); uint256 t = vm.getBlockTimestamp();
        vm.expectRevert(abi.encodeWithSelector(SKUdeskCore.BadUnits.selector, uint256(0)));
        vm.prank(agent); c.commitOpportunity(PROD, qh(q), SNAP, t, 0, q, 261, 2374);
        vm.expectRevert(abi.encodeWithSelector(SKUdeskCore.BadUnits.selector, uint256(1e9 + 1)));
        vm.prank(agent); c.commitOpportunity(PROD, qh(q), SNAP, t, 1e9 + 1, q, 261, 2374);
    }
    function testOwnerCannotActAsAgent() public {
        EconLib.Quote memory q = HQ(); uint256 t = vm.getBlockTimestamp();
        vm.expectRevert(SKUdeskCore.Unauthorized.selector);
        c.commitOpportunity(PROD, qh(q), SNAP, t, 10, q, 261, 2374); // this contract is owner, not agent
    }
    function testPausedBlocksAgent() public {
        c.pause(true);
        EconLib.Quote memory q = HQ(); uint256 t = vm.getBlockTimestamp();
        vm.expectRevert(SKUdeskCore.Paused.selector);
        vm.prank(agent); c.commitOpportunity(PROD, qh(q), SNAP, t, 10, q, 261, 2374);
    }
    /// Any wrong net is caught with MathMismatch carrying the real derived value.
    function testFuzzAnyLieIsCaught(int256 claimed) public {
        vm.assume(claimed != 261);
        EconLib.Quote memory q = HQ(); uint256 t = vm.getBlockTimestamp();
        vm.expectRevert(abi.encodeWithSelector(SKUdeskCore.MathMismatch.selector, claimed, int256(261), uint256(2374), uint256(2374)));
        vm.prank(agent); c.commitOpportunity(PROD, qh(q), SNAP, t, 240, q, claimed, 2374);
    }
}

contract LotTest is Base {
    event Settled(uint256 indexed lotId, uint256 proceedsBase, uint256 paidOutBase, int256 realizedBase);

    function _toPurchased(uint256 units, uint256 payBase) internal returns (uint256 lot) {
        bytes32 id = commitHero(units);
        vm.startPrank(agent);
        lot = c.mintLot(id);
        c.fundLot(lot);
        c.markPurchased(lot, supplier, payBase);
        vm.stopPrank();
    }
    function testMintRequiresCommittedOpportunity() public {
        vm.expectRevert(abi.encodeWithSelector(SKUdeskCore.UnknownOpportunity.selector, bytes32(uint256(1))));
        vm.prank(agent); c.mintLot(bytes32(uint256(1)));
    }
    function testOpportunityMintsOnlyOnce() public {
        bytes32 id = commitHero(120);
        vm.startPrank(agent);
        c.mintLot(id);
        vm.expectRevert(abi.encodeWithSelector(SKUdeskCore.OpportunityConsumed.selector, id));
        c.mintLot(id);
        vm.stopPrank();
    }
    function testFundMovesExactCommittedSpendFromVault() public {
        bytes32 id = commitHero(240);
        uint256 freeBefore = c.free();
        vm.startPrank(agent); uint256 lot = c.mintLot(id); c.fundLot(lot); vm.stopPrank();
        uint256 expected = 158160 * CENT; // 1,581,600,000 base units = $1,581.60
        require(c.escrow(lot) == expected, 'escrow equals committed spend');
        require(c.free() == freeBefore - expected, 'vault free decreased');
        require(c.totalEscrow() == expected, 'total escrow');
        require(usdc.balanceOf(address(c)) == 5_000_000_000, 'tokens stay in vault custody');
    }
    function testFundRevertsWhenVaultUnderfunded() public {
        c.withdraw(4_900_000_000); // leave $100
        bytes32 id = commitHero(240);
        vm.startPrank(agent); uint256 lot = c.mintLot(id);
        vm.expectRevert(abi.encodeWithSelector(SKUdeskCore.InsufficientFree.selector, uint256(100_000_000), uint256(1_581_600_000)));
        c.fundLot(lot);
        vm.stopPrank();
    }
    function testPayeeMustBeAllowlisted() public {
        bytes32 id = commitHero(120);
        vm.startPrank(agent); uint256 lot = c.mintLot(id); c.fundLot(lot);
        vm.expectRevert(abi.encodeWithSelector(SKUdeskCore.PayeeNotAllowed.selector, address(0xBAD)));
        c.markPurchased(lot, address(0xBAD), 1_000_000);
        vm.stopPrank();
    }
    function testCannotPayMoreThanEscrow() public {
        bytes32 id = commitHero(120); // 659*120 = 79,080 cents = 790,800,000 base
        vm.startPrank(agent); uint256 lot = c.mintLot(id); c.fundLot(lot);
        vm.expectRevert(abi.encodeWithSelector(SKUdeskCore.ExceedsEscrow.selector, uint256(790_800_001), uint256(790_800_000)));
        c.markPurchased(lot, supplier, 790_800_001);
        vm.stopPrank();
    }
    function testFullLifecycleRealMoney() public {
        // 240 units, spend $1,581.60 escrowed, pay supplier the purchase+ship etc. = $1,581.60 (all landed cost)
        uint256 lot = _toPurchased(240, 1_581_600_000);
        require(usdc.balanceOf(supplier) == 1_581_600_000, 'supplier actually paid');
        vm.startPrank(agent); c.markReceived(lot); c.markListed(lot); c.markSold(lot); vm.stopPrank();
        // marketplace remits 240 * (1099 - 88 marketplace fee) = 242,640 cents = $2,426.40
        uint256 proceeds = 242_640 * CENT;
        uint256 freeBefore = c.free();
        vm.expectEmit(true, false, false, true);
        emit Settled(lot, proceeds, 1_581_600_000, int256(proceeds) - int256(1_581_600_000));
        vm.prank(agent); c.settle(lot, market, proceeds);
        require(c.free() == freeBefore + proceeds, 'proceeds returned to vault free balance');
        require(uint256(c.statusOf(lot)) == uint256(SKUdeskCore.LS.SETTLED), 'settled');
        require(c.totalProceeds() == proceeds && c.totalPaidOut() == 1_581_600_000, 'counters');
    }
    function testSettleRequiresAllowlistedPayerAndRealTransfer() public {
        uint256 lot = _toPurchased(120, 790_800_000);
        vm.startPrank(agent); c.markReceived(lot); c.markListed(lot); c.markSold(lot);
        vm.expectRevert(abi.encodeWithSelector(SKUdeskCore.PayerNotAllowed.selector, address(0xBAD)));
        c.settle(lot, address(0xBAD), 1);
        vm.stopPrank();
        vm.prank(market); usdc.approve(address(c), 0);
        vm.prank(agent); vm.expectRevert(); c.settle(lot, market, 1_000_000); // no allowance: cannot invent proceeds
    }
    function testSettleCanRecordALoss() public {
        uint256 lot = _toPurchased(120, 790_800_000);
        vm.startPrank(agent); c.markReceived(lot); c.markListed(lot); c.markSold(lot);
        vm.expectEmit(true, false, false, true);
        emit Settled(lot, 500_000_000, 790_800_000, int256(500_000_000) - int256(790_800_000));
        c.settle(lot, market, 500_000_000);
        vm.stopPrank();
    }
    function testCancelThenRefundReturnsOnlyUnspentEscrow() public {
        uint256 lot = _toPurchased(120, 500_000_000); // 790.8 escrowed, 500 paid out, 290.8 remains
        uint256 freeBefore = c.free();
        vm.startPrank(agent); c.markReceived(lot); c.markListed(lot); c.cancel(lot); c.refund(lot); vm.stopPrank();
        require(c.free() == freeBefore + 290_800_000, 'only remaining escrow refunded, not the 500 already spent');
        require(c.escrow(lot) == 0 && c.totalEscrow() == 0, 'escrow cleared');
    }
    function testCancelFundedThenRefundReturnsAll() public {
        bytes32 id = commitHero(120);
        uint256 freeBefore = c.free();
        vm.startPrank(agent); uint256 lot = c.mintLot(id); c.fundLot(lot); c.cancel(lot); c.refund(lot); vm.stopPrank();
        require(c.free() == freeBefore, 'full refund');
    }
    function testIllegalTransitionsRevert() public {
        bytes32 id = commitHero(120);
        vm.startPrank(agent);
        uint256 lot = c.mintLot(id);
        vm.expectRevert(abi.encodeWithSelector(SKUdeskCore.BadTransition.selector, SKUdeskCore.LS.CREATED, SKUdeskCore.LS.SOLD));
        c.markSold(lot);
        vm.expectRevert(abi.encodeWithSelector(SKUdeskCore.BadTransition.selector, SKUdeskCore.LS.CREATED, SKUdeskCore.LS.REFUNDED));
        c.refund(lot);
        c.fundLot(lot);
        vm.expectRevert(abi.encodeWithSelector(SKUdeskCore.BadTransition.selector, SKUdeskCore.LS.FUNDED, SKUdeskCore.LS.FUNDED));
        c.fundLot(lot);
        vm.stopPrank();
    }
    function testReceivedCannotBeCancelledOnlyListed() public {
        uint256 lot = _toPurchased(120, 100_000_000);
        vm.startPrank(agent); c.markReceived(lot);
        vm.expectRevert(abi.encodeWithSelector(SKUdeskCore.BadTransition.selector, SKUdeskCore.LS.RECEIVED, SKUdeskCore.LS.CANCELLED));
        c.cancel(lot);
        vm.stopPrank();
    }
    function testOwnerWithdrawOnlyFromFreeBalance() public {
        bytes32 id = commitHero(240);
        vm.prank(agent); uint256 lot = c.mintLot(id);
        vm.prank(agent); c.fundLot(lot);
        uint256 f = c.free();
        vm.expectRevert(abi.encodeWithSelector(SKUdeskCore.InsufficientFree.selector, f, f + 1));
        c.withdraw(f + 1);
        c.withdraw(f);
        require(c.escrow(lot) == 158160 * CENT, 'escrowed funds untouched by owner withdrawal');
    }
    function testOnlyOwnerAdminAndOnlyAgentActions() public {
        vm.expectRevert(SKUdeskCore.Unauthorized.selector); vm.prank(agent); c.setPolicy(1, 1, 1800, 180);
        vm.expectRevert(SKUdeskCore.Unauthorized.selector); vm.prank(agent); c.setPayee(address(1), true);
        vm.expectRevert(SKUdeskCore.Unauthorized.selector); vm.prank(agent); c.withdraw(1);
        vm.expectRevert(SKUdeskCore.Unauthorized.selector); c.mintLot(bytes32(0)); // owner is not the agent
    }
    function testSetPolicyBounds() public {
        vm.expectRevert(abi.encodeWithSelector(SKUdeskCore.OutOfBounds.selector, bytes32('minMarginBps'), uint256(50)));
        c.setPolicy(500000, 250000, 50, 180);
    }
}

/// Handler drives random legal-ish actions; invariants prove no value is created or destroyed.
contract Handler is Base {
    uint256 public lots; uint256 public salt;
    function act(uint256 a, uint256 x) external {
        a = a % 7; x = bound(x, 1, 400);
        vm.startPrank(agent);
        if (a == 0) { _try(x); }
        else if (a == 1 && lots > 0) { uint256 id = 1 + (x % lots); try c.fundLot(id) {} catch {} }
        else if (a == 2 && lots > 0) { uint256 id = 1 + (x % lots); try c.markPurchased(id, supplier, (x * 1_000_000) % (c.escrow(id) + 1)) {} catch {} }
        else if (a == 3 && lots > 0) { uint256 id = 1 + (x % lots); try c.markReceived(id) {} catch {} try c.markListed(id) {} catch {} try c.markSold(id) {} catch {} }
        else if (a == 4 && lots > 0) { uint256 id = 1 + (x % lots); try c.settle(id, market, x * 5_000_000) {} catch {} }
        else if (a == 5 && lots > 0) { uint256 id = 1 + (x % lots); try c.cancel(id) {} catch {} try c.refund(id) {} catch {} }
        vm.stopPrank();
        if (a == 6) { try c.withdraw(x * 1_000_000) {} catch {} }
    }
    /// Drives a lot through the whole lifecycle so settle/refund paths are actually exercised by the invariants.
    uint256 public settled; uint256 public refunded;
    function happyPath(uint256 x, uint256 pay, uint256 proceeds, bool cancelInstead) external {
        x = bound(x, 1, 379);
        EconLib.Quote memory q = HQ();
        bytes32 id;
        vm.startPrank(agent);
        try c.commitOpportunity(PROD, qh(q), keccak256(abi.encode(++salt)), vm.getBlockTimestamp(), x, q, 261, 2374) returns (bytes32 i, uint256, int256) { id = i; } catch { vm.stopPrank(); vm.warp(vm.getBlockTimestamp() + 1 days); return; }
        uint256 lot = c.mintLot(id); lots = lot;
        try c.fundLot(lot) {} catch { vm.stopPrank(); return; }
        pay = bound(pay, 0, c.escrow(lot));
        c.markPurchased(lot, supplier, pay);
        if (cancelInstead) { c.cancel(lot); c.refund(lot); refunded++; vm.stopPrank(); return; }
        c.markReceived(lot); c.markListed(lot); c.markSold(lot);
        c.settle(lot, market, bound(proceeds, 0, 5_000_000_000)); settled++;
        vm.stopPrank();
    }
    function _try(uint256 units) internal {
        EconLib.Quote memory q = HQ();
        try c.commitOpportunity(PROD, qh(q), keccak256(abi.encode(++salt)), vm.getBlockTimestamp(), units, q, 261, 2374) returns (bytes32 id, uint256, int256) {
            try c.mintLot(id) returns (uint256 lotId) { lots = lotId; } catch {}
        } catch {}
    }
}
contract InvariantTest is Test {
    Handler h;
    function setUp() public { h = new Handler(); h.setUp(); targetContract(address(h)); }
    function invariant_custodyCoversFreePlusEscrow() public view {
        SKUdeskCore c = h.c();
        assertGe(h.usdc().balanceOf(address(c)), c.free() + c.totalEscrow());
    }
    function invariant_valueConservation() public view {
        SKUdeskCore c = h.c();
        assertEq(c.free() + c.totalEscrow() + c.totalPaidOut(), c.totalDeposited() + c.totalProceeds() - c.totalWithdrawn());
    }
}
