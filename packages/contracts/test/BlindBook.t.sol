// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {Test} from 'forge-std/Test.sol';
import {BlindBook} from '../src/BlindBook.sol';
import {MockUSDC} from '../src/MockUSDC.sol';

/// Epoch layout used by every test: epochLen 45s, commit window [0,20), reveal window [20,35), clear allowed from 35.
contract BBBase is Test {
    MockUSDC public usdc; BlindBook public book;
    bytes32 constant M = keccak256('CASE-IP16PRO-CLEAR-MAG-001');
    uint256 constant EPOCH = 45; uint256 constant COMMIT = 20; uint256 constant REVEAL = 35; uint256 constant BOND = 2_000_000; uint256 constant CENT = 10_000;
    address a = address(0xA1); address b = address(0xB2); address c = address(0xC3); address d = address(0xD4); address e = address(0xE5);
    struct O { address who; uint8 side; uint256 price; uint256 units; bytes32 salt; uint256 idx; uint256 epoch; }
    O[] os;

    function setUp() public virtual {
        usdc = new MockUSDC();
        book = new BlindBook(address(usdc), EPOCH, COMMIT, REVEAL, BOND);
        book.listMarket(M, 1);
        address[5] memory who = [a, b, c, d, e];
        for (uint256 i = 0; i < 5; i++) {
            usdc.mint(who[i], 1_000_000_000_000);
            vm.prank(who[i]); usdc.approve(address(book), type(uint256).max);
            vm.prank(who[i]); book.deposit(1_000_000_000_000);
            book.issue(M, who[i], 1_000_000);
        }
    }
    function at(uint256 epoch, uint256 offset) internal { vm.warp(book.t0() + epoch * EPOCH + offset); }
    function commitOrder(address who, uint8 side, uint256 price, uint256 units) internal returns (uint256 idx) {
        uint256 epoch = book.currentEpoch(); bytes32 salt = keccak256(abi.encode('salt', os.length, who));
        bytes32 h = keccak256(abi.encode(M, epoch, who, side, price, units, salt));
        vm.prank(who); book.commit(M, h);
        idx = book.orderCount(M, epoch) - 1; os.push(O(who, side, price, units, salt, idx, epoch));
    }
    function revealOne(uint256 i) internal { O memory o = os[i]; vm.prank(o.who); book.reveal(M, o.epoch, o.idx, o.side, o.price, o.units, o.salt); }
    function revealAll() internal { for (uint256 i = 0; i < os.length; i++) revealOne(i); }
    function totalFree() internal view returns (uint256 s) { address[5] memory w = [a, b, c, d, e]; for (uint256 i = 0; i < 5; i++) s += book.cash(w[i]); }
    function totalUnitsFree() internal view returns (uint256 s) { address[5] memory w = [a, b, c, d, e]; for (uint256 i = 0; i < 5; i++) s += book.unitsOf(M, w[i]); }
}

contract BlindBookFlowTest is BBBase {
    event Committed(bytes32 indexed market, uint256 indexed epoch, uint256 index, address indexed trader, bytes32 hash);
    event EpochCleared(bytes32 indexed market, uint256 indexed epoch, uint256 price, uint256 volume, uint256 buys, uint256 sells, uint256 forfeited);

    function testScheduleAndPhases() public {
        at(3, 0); require(book.currentEpoch() == 3 && book.phase() == 0, 'commit');
        at(3, 19); require(book.phase() == 0, 'still commit');
        at(3, 20); require(book.phase() == 1, 'reveal');
        at(3, 34); require(book.phase() == 1, 'still reveal');
        at(3, 35); require(book.phase() == 2, 'closed');
        at(4, 0); require(book.currentEpoch() == 4 && book.phase() == 0, 'next epoch');
    }
    function testCommitLocksOnlyTheFixedBondAndRevealsNothing() public {
        at(1, 1); uint256 before = book.cash(a);
        bytes32 h = keccak256('x'); vm.expectEmit(true, true, true, true); emit Committed(M, 1, 0, a, h);
        vm.prank(a); book.commit(M, h);
        require(before - book.cash(a) == BOND, 'only the bond is locked, whatever the order is');
        require(book.orderCount(M, 1) == 1, 'stored');
        (address t, bool revealed, , , , , ) = book.getOrder(M, 1, 0);
        require(t == a && !revealed, 'trader known, order content unknown');
    }
    function testCommitOnlyInCommitWindow() public {
        at(1, 20); vm.expectRevert(abi.encodeWithSelector(BlindBook.WrongPhase.selector, uint8(1), uint8(0)));
        vm.prank(a); book.commit(M, bytes32(uint256(1)));
    }
    function testRevealOnlyInRevealWindow() public {
        at(1, 5); commitOrder(a, 0, 100, 10);
        O memory o = os[0]; vm.expectRevert(abi.encodeWithSelector(BlindBook.WrongPhase.selector, uint8(0), uint8(1)));
        vm.prank(a); book.reveal(M, 1, 0, o.side, o.price, o.units, o.salt);
    }
    function testRevealWithWrongSaltOrFieldsFails() public {
        at(1, 5); commitOrder(a, 0, 100, 10); at(1, 25); O memory o = os[0];
        vm.expectRevert(BlindBook.BadReveal.selector); vm.prank(a); book.reveal(M, 1, 0, o.side, o.price, o.units, bytes32(uint256(7)));
        vm.expectRevert(BlindBook.BadReveal.selector); vm.prank(a); book.reveal(M, 1, 0, o.side, o.price + 1, o.units, o.salt);
        vm.expectRevert(BlindBook.BadReveal.selector); vm.prank(a); book.reveal(M, 1, 0, 1, o.price, o.units, o.salt);
    }
    function testOnlyTheCommitterCanReveal() public {
        at(1, 5); commitOrder(a, 0, 100, 10); at(1, 25); O memory o = os[0];
        vm.expectRevert(BlindBook.NotYourOrder.selector); vm.prank(b); book.reveal(M, 1, 0, o.side, o.price, o.units, o.salt);
    }
    function testRevealTwiceFails() public {
        at(1, 5); commitOrder(a, 0, 100, 10); at(1, 25); revealOne(0);
        O memory o = os[0]; vm.expectRevert(BlindBook.AlreadyRevealed.selector); vm.prank(a); book.reveal(M, 1, 0, o.side, o.price, o.units, o.salt);
    }
    function testRevealReservesBuyCashAndReturnsTheBond() public {
        at(1, 5); commitOrder(a, 0, 100, 10); uint256 afterCommit = book.cash(a); at(1, 25); revealOne(0);
        uint256 need = 100 * 10 * CENT;
        require(book.cash(a) == afterCommit + BOND - need, 'bond back, funds reserved');
    }
    function testRevealReservesSellUnits() public {
        at(1, 5); commitOrder(a, 1, 100, 10); uint256 u = book.unitsOf(M, a); at(1, 25); revealOne(0);
        require(book.unitsOf(M, a) == u - 10, 'units reserved');
    }
    function testRevealWithInsufficientFundsRevertsAndCanBeRetriedAfterTopUp() public {
        address f = address(0xF6); usdc.mint(f, 5_000_000); vm.prank(f); usdc.approve(address(book), type(uint256).max);
        vm.prank(f); book.deposit(5_000_000); // 5 tokens: enough for the 2 token bond, not for 100 * 10 cents * ... = $10 order
        at(1, 5); bytes32 salt = keccak256('f'); bytes32 h = keccak256(abi.encode(M, uint256(1), f, uint8(0), uint256(500), uint256(10), salt));
        vm.prank(f); book.commit(M, h); at(1, 25);
        vm.expectRevert(abi.encodeWithSelector(BlindBook.InsufficientCash.selector, uint256(3_000_000), uint256(50_000_000)));
        vm.prank(f); book.reveal(M, 1, 0, 0, 500, 10, salt);
        usdc.mint(f, 100_000_000); vm.prank(f); usdc.approve(address(book), type(uint256).max); vm.prank(f); book.deposit(100_000_000);
        vm.prank(f); book.reveal(M, 1, 0, 0, 500, 10, salt);
        (, bool revealed, , , , , ) = book.getOrder(M, 1, 0); require(revealed, 'retry worked');
    }
    function testBoundsTickAndSide() public {
        book.listMarket(keccak256('TICK5'), 5); at(1, 5);
        bytes32 m5 = keccak256('TICK5'); bytes32 salt = bytes32(uint256(9));
        bytes32 h = keccak256(abi.encode(m5, uint256(1), a, uint8(0), uint256(103), uint256(10), salt)); vm.prank(a); book.commit(m5, h); at(1, 25);
        vm.expectRevert(abi.encodeWithSelector(BlindBook.BadPrice.selector, uint256(103), uint256(5))); vm.prank(a); book.reveal(m5, 1, 0, 0, 103, 10, salt);
        at(2, 5); salt = bytes32(uint256(10)); h = keccak256(abi.encode(M, uint256(2), a, uint8(2), uint256(100), uint256(10), salt)); vm.prank(a); book.commit(M, h); at(2, 25);
        vm.expectRevert(abi.encodeWithSelector(BlindBook.BadSide.selector, uint8(2))); vm.prank(a); book.reveal(M, 2, 0, 2, 100, 10, salt);
        at(3, 5); salt = bytes32(uint256(11)); h = keccak256(abi.encode(M, uint256(3), a, uint8(0), uint256(100), uint256(0), salt)); vm.prank(a); book.commit(M, h); at(3, 25);
        vm.expectRevert(abi.encodeWithSelector(BlindBook.BadUnits.selector, uint256(0))); vm.prank(a); book.reveal(M, 3, 0, 0, 100, 0, salt);
        at(4, 5); salt = bytes32(uint256(12)); h = keccak256(abi.encode(M, uint256(4), a, uint8(0), uint256(1_000_001), uint256(1), salt)); vm.prank(a); book.commit(M, h); at(4, 25);
        vm.expectRevert(abi.encodeWithSelector(BlindBook.BadPrice.selector, uint256(1_000_001), uint256(1))); vm.prank(a); book.reveal(M, 4, 0, 0, 1_000_001, 1, salt);
    }
    function testBookIsCappedAt24OrdersPerMarketEpoch() public {
        at(1, 5); for (uint256 i = 0; i < 24; i++) { vm.prank(a); book.commit(M, bytes32(i + 1)); }
        vm.expectRevert(BlindBook.BookFull.selector); vm.prank(a); book.commit(M, bytes32(uint256(99)));
    }
    function testUnlistedMarketRefused() public { at(1, 5); vm.expectRevert(abi.encodeWithSelector(BlindBook.MarketNotListed.selector, bytes32(uint256(5)))); vm.prank(a); book.commit(bytes32(uint256(5)), bytes32(uint256(1))); }
    function testClearOnlyAfterTheRevealWindowAndOnlyOnce() public {
        at(1, 5); commitOrder(a, 0, 100, 10); commitOrder(b, 1, 100, 10); at(1, 25); revealAll();
        at(1, 34); vm.expectRevert(abi.encodeWithSelector(BlindBook.TooEarly.selector, book.t0() + 1 * EPOCH + 34, book.t0() + 1 * EPOCH + REVEAL)); book.clear(M, 1);
        at(1, 35); book.clear(M, 1); vm.expectRevert(BlindBook.AlreadyCleared.selector); book.clear(M, 1);
    }
    function testClearWithNoOrdersReverts() public { at(2, 40); vm.expectRevert(BlindBook.NothingToClear.selector); book.clear(M, 1); }
    function testPauseBlocksCommitAndRevealButNeverClearOrWithdraw() public {
        at(1, 5); commitOrder(a, 0, 100, 10); commitOrder(b, 1, 100, 10); at(1, 25); revealAll(); book.pause(true);
        at(2, 5); vm.expectRevert(BlindBook.Paused.selector); vm.prank(a); book.commit(M, bytes32(uint256(1)));
        at(1, 36); book.clear(M, 1); vm.prank(a); book.withdraw(1);
    }
    function testOnlyOwnerAdminActions() public {
        vm.expectRevert(BlindBook.Unauthorized.selector); vm.prank(a); book.listMarket(bytes32(uint256(8)), 1);
        vm.expectRevert(BlindBook.Unauthorized.selector); vm.prank(a); book.issue(M, a, 1);
        vm.expectRevert(BlindBook.Unauthorized.selector); vm.prank(a); book.pause(true);
        vm.expectRevert(BlindBook.Unauthorized.selector); vm.prank(a); book.withdrawTreasury(a);
    }
    function testDepositWithdrawOnlyFreeCash() public {
        at(1, 5); commitOrder(a, 0, 100, 10); at(1, 25); revealAll();
        uint256 free = book.cash(a); vm.expectRevert(abi.encodeWithSelector(BlindBook.InsufficientCash.selector, free, free + 1)); vm.prank(a); book.withdraw(free + 1);
        vm.prank(a); book.withdraw(free); require(book.cash(a) == 0, 'reserved cash stayed in the book');
    }
}

contract BlindBookClearingTest is BBBase {
    event Fill(bytes32 indexed market, uint256 indexed epoch, uint256 index, address indexed trader, uint8 side, uint256 units, uint256 price);
    event EpochCleared(bytes32 indexed market, uint256 indexed epoch, uint256 price, uint256 volume, uint256 buys, uint256 sells, uint256 forfeited);
    struct Snap { uint256 cash; uint256 units; }
    mapping(address => Snap) snap;
    function _snap() internal { address[5] memory w = [a, b, c, d, e]; for (uint256 i = 0; i < 5; i++) snap[w[i]] = Snap(book.cash(w[i]), book.unitsOf(M, w[i])); }
    function _dCash(address who) internal view returns (int256) { return int256(book.cash(who)) - int256(snap[who].cash); }
    function _dUnits(address who) internal view returns (int256) { return int256(book.unitsOf(M, who)) - int256(snap[who].units); }
    function _clear(uint256 epoch) internal returns (uint256 p, uint256 v) { at(epoch, 36); book.clear(M, epoch); (p, v) = book.results(M, epoch); }
    function _conserved() internal view {
        require(usdc.balanceOf(address(book)) == book.accounted(), 'token balance == free + locked + bonds + treasury');
        require(totalUnitsFree() + book.lockedUnitsTotal(M) == 5 * 1_000_000, 'units conserved');
    }

    /// buys: A 100c x10, B 90c x10 | sells: C 80c x10, D 95c x10. V = 10 on [80,100] -> p* = 90. A (best buy) trades with C (best sell) only.
    function testUniformPriceIsTheMidpointOfTheMaximalVolumeInterval() public {
        _snap();
        at(1, 5); commitOrder(a, 0, 100, 10); commitOrder(b, 0, 90, 10); commitOrder(c, 1, 80, 10); commitOrder(d, 1, 95, 10);
        at(1, 25); revealAll();
        vm.expectEmit(true, true, false, true); emit EpochCleared(M, 1, 90, 10, 2, 2, 0);
        (uint256 p, uint256 v) = _clear(1); require(p == 90 && v == 10, 'price 90 volume 10');
        require(_dCash(a) == -int256(90 * 10 * CENT) && _dUnits(a) == 10, 'A pays the uniform price 90 (not its 100 limit) and gets 10 units');
        require(_dCash(c) == int256(90 * 10 * CENT) && _dUnits(c) == -10, 'C is paid 90 (not its 80 limit)');
        require(_dCash(b) == 0 && _dUnits(b) == 0 && _dCash(d) == 0 && _dUnits(d) == 0, 'B (limit 90 but behind A) and D (ask 95 above p*) are untouched, bonds and locks returned');
        _conserved();
    }
    function testFillEventsCarryTheUniformPrice() public {
        at(1, 5); commitOrder(a, 0, 100, 10); commitOrder(c, 1, 80, 10); at(1, 25); revealAll(); at(1, 36);
        vm.expectEmit(true, true, true, true); emit Fill(M, 1, 0, a, 0, 10, 90);
        vm.expectEmit(true, true, true, true); emit Fill(M, 1, 1, c, 1, 10, 90);
        book.clear(M, 1);
    }
    function testClearingPriceIsRoundedDownToTheTick() public {
        bytes32 m5 = keccak256('TICK5'); book.listMarket(m5, 5); book.issue(m5, c, 1000); at(1, 5);
        bytes32 sa = bytes32(uint256(1)); bytes32 sc = bytes32(uint256(2));
        vm.prank(a); book.commit(m5, keccak256(abi.encode(m5, uint256(1), a, uint8(0), uint256(95), uint256(10), sa)));
        vm.prank(c); book.commit(m5, keccak256(abi.encode(m5, uint256(1), c, uint8(1), uint256(80), uint256(10), sc)));
        at(1, 25); vm.prank(a); book.reveal(m5, 1, 0, 0, 95, 10, sa); vm.prank(c); book.reveal(m5, 1, 1, 1, 80, 10, sc);
        at(1, 36); book.clear(m5, 1); (uint256 p, uint256 v) = book.results(m5, 1);
        require(p == 85 && v == 10, 'midpoint of [80,95] is 87, rounded down to the tick 85');
    }
    function testNoCrossMeansNoTradeAndEverythingIsReleased() public {
        _snap();
        at(1, 5); commitOrder(a, 0, 50, 10); commitOrder(c, 1, 60, 10); at(1, 25); revealAll();
        (uint256 p, uint256 v) = _clear(1); require(p == 0 && v == 0, 'no trade');
        require(_dCash(a) == 0 && _dCash(c) == 0 && _dUnits(a) == 0 && _dUnits(c) == 0, 'bonds, cash and units all returned');
        require(book.lastPrice(M) == 0, 'no last price yet'); _conserved();
    }
    function testPartialFillFollowsPriceTimePriority() public {
        _snap();
        at(1, 5); commitOrder(a, 0, 100, 6); commitOrder(b, 0, 100, 6); commitOrder(c, 1, 90, 8); at(1, 25); revealAll();
        (uint256 p, uint256 v) = _clear(1); require(p == 95 && v == 8, 'p* 95 volume 8');
        require(_dCash(a) == -int256(95 * 6 * CENT) && _dUnits(a) == 6, 'earlier order A is filled completely first');
        require(_dCash(b) == -int256(95 * 2 * CENT) && _dUnits(b) == 2, 'later order B gets the remaining 2');
        require(_dCash(c) == int256(95 * 8 * CENT) && _dUnits(c) == -8, 'seller filled 8'); _conserved();
    }
    function testBestPricedSellerIsFilledFirst() public {
        _snap();
        at(1, 5); commitOrder(a, 0, 100, 5); commitOrder(c, 1, 80, 5); commitOrder(d, 1, 85, 5); at(1, 25); revealAll();
        (uint256 p, ) = _clear(1); require(p == 90, 'p* 90');
        require(_dUnits(c) == -5 && _dUnits(d) == 0, 'the cheaper ask C trades, the dearer ask D does not'); _conserved();
    }
    function testUnrevealedOrderForfeitsExactlyTheBond() public {
        _snap();
        at(1, 5); commitOrder(a, 0, 100, 10); commitOrder(c, 1, 90, 10); vm.prank(e); book.commit(M, bytes32(uint256(777)));
        at(1, 25); revealOne(0); revealOne(1); vm.expectEmit(true, true, false, true); emit EpochCleared(M, 1, 95, 10, 1, 1, 1); _clear(1);
        require(book.treasury() == BOND && _dCash(e) == -int256(BOND), 'E lost exactly the bond, which now belongs to the treasury');
        require(book.cash(e) == 1_000_000_000_000 - BOND, 'E lost exactly the bond'); _conserved();
    }
    function testResultsAndLastPriceAreStored() public {
        at(1, 5); commitOrder(a, 0, 100, 10); commitOrder(c, 1, 90, 10); at(1, 25); revealAll(); _clear(1);
        require(book.lastPrice(M) == 95 && book.lastEpoch(M) == 1, 'last price tracked for the UI');
        at(2, 5); commitOrder(a, 0, 40, 10); commitOrder(c, 1, 50, 10); at(2, 25); for (uint256 i = 2; i < 4; i++) revealOne(i); _clear(2);
        require(book.lastPrice(M) == 95, 'a no-trade epoch keeps the previous last price');
    }
    function testWithdrawAfterClearReturnsProceeds() public {
        at(1, 5); commitOrder(a, 0, 100, 10); commitOrder(c, 1, 90, 10); at(1, 25); revealAll(); _clear(1);
        uint256 before = usdc.balanceOf(c); uint256 free = book.cash(c); vm.prank(c); book.withdraw(free);
        require(usdc.balanceOf(c) - before == free && book.cash(c) == 0, 'tokens really leave the book'); _conserved();
    }

    // ---------- fuzz against an independent brute-force reference (every integer price, not just the revealed ones)
    function _rnd(uint256 seed, uint256 i, uint256 mod) internal pure returns (uint256) { return uint256(keccak256(abi.encode(seed, i))) % mod; }
    function testFuzzClearingMatchesBruteForceAndSatisfiesTheProperties(uint256 seed) public {
        uint256 n = 2 + _rnd(seed, 0, 11); address[5] memory w = [a, b, c, d, e];
        _snap(); at(1, 5);
        for (uint256 i = 0; i < n; i++) commitOrder(w[_rnd(seed, 10 + i, 5)], uint8(_rnd(seed, 30 + i, 2)), 1 + _rnd(seed, 50 + i, 40), 1 + _rnd(seed, 70 + i, 15));
        at(1, 25); revealAll();
        // reference: evaluate V at EVERY integer price 1..40
        uint256 vmax; uint256 lo; uint256 hi;
        for (uint256 p = 1; p <= 40; p++) {
            uint256 dm; uint256 sp;
            for (uint256 i = 0; i < n; i++) { if (os[i].side == 0 && os[i].price >= p) dm += os[i].units; if (os[i].side == 1 && os[i].price <= p) sp += os[i].units; }
            uint256 v = dm < sp ? dm : sp; if (v > vmax) { vmax = v; lo = p; hi = p; } else if (v == vmax && v > 0) { hi = p; }
        }
        (uint256 price, uint256 vol) = _clear(1);
        require(vol == vmax, 'P1 volume is maximal');
        if (vmax == 0) { require(price == 0, 'no trade price'); } else { require(price == (lo + hi) / 2, 'price is the midpoint of the maximal interval'); }
        uint256 buyFill; uint256 sellFill; int256 cashSum; int256 unitSum;
        for (uint256 i = 0; i < n; i++) {
            (, , uint8 side, uint256 pr, uint256 un, uint256 fl, ) = book.getOrder(M, 1, os[i].idx);
            require(fl <= un, 'P4 never overfilled');
            if (fl > 0) { if (side == 0) require(pr >= price, 'P2 buy limit respected'); else require(pr <= price, 'P2 sell limit respected'); }
            if (side == 0) buyFill += fl; else sellFill += fl;
            for (uint256 j = 0; j < n; j++) {
                (, , uint8 sj, uint256 pj, uint256 uj, uint256 fj, ) = book.getOrder(M, 1, os[j].idx);
                if (sj != side || i == j || fj == 0 || fl == un) continue;
                bool iBetter = side == 0 ? (pr > pj || (pr == pj && os[i].idx < os[j].idx)) : (pr < pj || (pr == pj && os[i].idx < os[j].idx));
                require(!iBetter, 'P5 a better or earlier order is never skipped for a worse one'); uj;
            }
        }
        require(buyFill == vmax && sellFill == vmax, 'P3 both sides filled for exactly the volume');
        for (uint256 i = 0; i < 5; i++) { cashSum += _dCash(w[i]); unitSum += _dUnits(w[i]); }
        require(cashSum == 0 && unitSum == 0, 'P6/P7 cash and units conserved across the clear'); _conserved();
    }
}

/// Gas bound: a full book (24 orders, 12 crossing pairs) must clear well inside a block.
contract BlindBookGasTest is BBBase {
    function testClearGasWithAFullBookIsBounded() public {
        at(1, 5); address[5] memory w = [a, b, c, d, e];
        for (uint256 i = 0; i < 24; i++) commitOrder(w[i % 5], uint8(i % 2), i % 2 == 0 ? 100 - i : 60 + i, 5 + (i % 7));
        at(1, 25); revealAll(); at(1, 36);
        uint256 g = gasleft(); book.clear(M, 1); uint256 used = g - gasleft();
        emit log_named_uint('clear gas, 24 orders', used);
        require(used < 6_000_000, 'a full book clears inside a comfortable gas budget');
        (uint256 p, uint256 v) = book.results(M, 1); require(v > 0 && p > 0, 'it traded');
    }
}

/// A random walk over many epochs. The invariants must hold after every step.
contract BBHandler is BBBase {
    struct P { uint256 epoch; uint256 idx; address who; uint8 side; uint256 price; uint256 units; bytes32 salt; bool done; }
    P[] ps; mapping(uint256 => bool) clearedEpoch; uint256 nonce;
    function market() external pure returns (bytes32) { return M; }
    function sumCash() external view returns (uint256) { return totalFree(); }
    function sumUnits() external view returns (uint256) { return totalUnitsFree(); }
    function _warp(uint256 ts) internal { if (ts > vm.getBlockTimestamp()) vm.warp(ts); }
    function _who(uint256 x) internal view returns (address) { address[5] memory w = [a, b, c, d, e]; return w[x % 5]; }
    uint256 public trades;
    /// A whole epoch in one step: many orders with overlapping prices, most revealed, then cleared. Makes real trades likely.
    function _cycle(uint256 x) internal {
        _warp(book.t0() + (book.currentEpoch() + 1) * EPOCH + 1); uint256 ep = book.currentEpoch(); uint256 first = ps.length;
        uint256 n = 4 + x % 9;
        for (uint256 i = 0; i < n; i++) {
            uint256 r = uint256(keccak256(abi.encode(x, i))); address who = _who(r); uint8 side = uint8((r >> 8) % 2); uint256 price = 20 + (r >> 16) % 11; uint256 units = 1 + (r >> 32) % 8; bytes32 sl = keccak256(abi.encode(++nonce));
            vm.prank(who); try book.commit(M, keccak256(abi.encode(M, ep, who, side, price, units, sl))) returns (uint256 idx) { ps.push(P(ep, idx, who, side, price, units, sl, false)); } catch {}
        }
        _warp(book.t0() + ep * EPOCH + COMMIT);
        for (uint256 i = first; i < ps.length; i++) { ps[i].done = true; if ((x + i) % 9 != 0) { vm.prank(ps[i].who); try book.reveal(M, ep, ps[i].idx, ps[i].side, ps[i].price, ps[i].units, ps[i].salt) {} catch {} } }
        _warp(book.t0() + ep * EPOCH + REVEAL); clearedEpoch[ep] = true;
        try book.clear(M, ep) { (, uint256 v) = book.results(M, ep); if (v > 0) trades++; } catch {}
    }
    function act(uint256 kind, uint256 x) external {
        kind = kind % 8; address who = _who(x);
        if (kind >= 6) { _cycle(x); return; }
        if (kind == 0) { _warp(book.t0() + (book.currentEpoch() + 1) * EPOCH + 1); }
        else if (kind == 1) {
            if (book.phase() != 0) _warp(book.t0() + (book.currentEpoch() + 1) * EPOCH + 1);
            uint256 ep = book.currentEpoch(); if (book.orderCount(M, ep) >= 24) return;
            uint8 side = uint8(x % 2); uint256 price = 1 + (x / 2) % 30; uint256 units = 1 + (x / 64) % 10; bytes32 sl = keccak256(abi.encode(++nonce));
            vm.prank(who); try book.commit(M, keccak256(abi.encode(M, ep, who, side, price, units, sl))) returns (uint256 idx) { ps.push(P(ep, idx, who, side, price, units, sl, false)); } catch {}
        } else if (kind == 2) {
            uint256 ep = book.currentEpoch(); _warp(book.t0() + ep * EPOCH + COMMIT); if (book.phase() != 1) return;
            for (uint256 i = 0; i < ps.length; i++) if (!ps[i].done && ps[i].epoch == ep) { ps[i].done = true; if ((x + i) % 4 != 0) { vm.prank(ps[i].who); try book.reveal(M, ep, ps[i].idx, ps[i].side, ps[i].price, ps[i].units, ps[i].salt) {} catch {} } }
        } else if (kind == 3) {
            for (uint256 i = 0; i < ps.length; i++) { uint256 ep = ps[i].epoch; if (!clearedEpoch[ep]) { _warp(book.t0() + ep * EPOCH + REVEAL); clearedEpoch[ep] = true; try book.clear(M, ep) {} catch {} } }
        } else if (kind == 4) { vm.prank(who); try book.withdraw(x % 5_000_000) {} catch {} }
        else { try book.issue(M, who, x % 1000) {} catch {} }
    }
}
contract BlindBookInvariantTest is Test {
    BBHandler h;
    function setUp() public { h = new BBHandler(); h.setUp(); targetContract(address(h)); }
    function invariant_tokenBalanceEqualsInternalAccounting() public view { assertEq(h.usdc().balanceOf(address(h.book())), h.book().accounted(), 'token balance == free + locked + bonds + treasury'); }
    function invariant_freeCashMatchesTheLedger() public view { assertEq(h.sumCash(), h.book().totalFree(), 'sum of per-account cash == totalFree'); }
    function invariant_unitsAreNeverCreatedOrDestroyed() public view { assertEq(h.sumUnits() + h.book().lockedUnitsTotal(h.market()), h.book().totalIssued(h.market()), 'free + locked units == issued'); }
}

/// Differential test: 400 random books are cleared by the real contract and compared, order by order, with the TypeScript
/// mirror (apps/web/src/lib/book.ts) whose answers are stored in test/vectors/book-vectors.json.
contract BlindBookParityTest is BBBase {
    bytes32 constant M5 = keccak256('TICK5-PARITY');
    function testContractMatchesTheTypeScriptMirrorOnRandomBooks() public {
        book.listMarket(M5, 5);
        string memory j = vm.readFile('test/vectors/book-vectors.json');
        uint256[] memory tick = vm.parseJsonUintArray(j, '.tick'); uint256[] memory nn = vm.parseJsonUintArray(j, '.n');
        uint256[] memory actor = vm.parseJsonUintArray(j, '.actor'); uint256[] memory side = vm.parseJsonUintArray(j, '.side');
        uint256[] memory price = vm.parseJsonUintArray(j, '.price'); uint256[] memory units = vm.parseJsonUintArray(j, '.units');
        uint256[] memory expPrice = vm.parseJsonUintArray(j, '.expPrice'); uint256[] memory expVolume = vm.parseJsonUintArray(j, '.expVolume'); uint256[] memory expFill = vm.parseJsonUintArray(j, '.expFill');
        address[5] memory w = [a, b, c, d, e]; uint256 off; uint256 traded;
        for (uint256 v = 0; v < nn.length; v++) {
            bytes32 m = tick[v] == 5 ? M5 : M; uint256 epoch = v + 1;
            for (uint256 i = 0; i < 5; i++) { book.issue(m, w[i], 100_000); }
            at(epoch, 5);
            for (uint256 i = 0; i < nn[v]; i++) {
                address who = w[actor[off + i]]; bytes32 salt = keccak256(abi.encode(v, i));
                vm.prank(who); book.commit(m, keccak256(abi.encode(m, epoch, who, uint8(side[off + i]), price[off + i], units[off + i], salt)));
            }
            at(epoch, 25);
            for (uint256 i = 0; i < nn[v]; i++) { address who = w[actor[off + i]]; vm.prank(who); book.reveal(m, epoch, i, uint8(side[off + i]), price[off + i], units[off + i], keccak256(abi.encode(v, i))); }
            at(epoch, 36); book.clear(m, epoch);
            (uint256 p, uint256 vol) = book.results(m, epoch);
            require(p == expPrice[v] && vol == expVolume[v], string.concat('vector ', vm.toString(v), ' price/volume differ from the TypeScript mirror'));
            for (uint256 i = 0; i < nn[v]; i++) { (, , , , , uint256 filled, ) = book.getOrder(m, epoch, i); require(filled == expFill[off + i], string.concat('vector ', vm.toString(v), ' order ', vm.toString(i), ' fill differs')); }
            if (vol > 0) traded++;
            off += nn[v];
        }
        require(traded > 100, 'the vectors exercise real trades');
    }
}
