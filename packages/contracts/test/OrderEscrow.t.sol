// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {Test} from 'forge-std/Test.sol';
import {BlindBook} from '../src/BlindBook.sol';
import {MockUSDC} from '../src/MockUSDC.sol';
import {OrderEscrow} from '../src/OrderEscrow.sol';
import {DeployOrderEscrow} from '../script/DeployOrderEscrow.s.sol';

interface ITok {
    function mint(address to, uint256 amount) external;
    function approve(address spender, uint256 amount) external returns (bool);
    function balanceOf(address a) external view returns (uint256);
    function totalSupply() external view returns (uint256);
}

/// Token that burns 1% on transferFrom: the escrow must refuse it (balance-delta check).
contract FeeToken {
    mapping(address => uint256) public balanceOf; mapping(address => mapping(address => uint256)) public allowance; uint256 public totalSupply;
    function mint(address to, uint256 a) external { totalSupply += a; balanceOf[to] += a; }
    function approve(address s, uint256 a) external returns (bool) { allowance[msg.sender][s] = a; return true; }
    function transfer(address to, uint256 a) external returns (bool) { balanceOf[msg.sender] -= a; balanceOf[to] += a; return true; }
    function transferFrom(address from, address to, uint256 a) external returns (bool) {
        allowance[from][msg.sender] -= a; balanceOf[from] -= a; uint256 fee = a / 100; totalSupply -= fee; balanceOf[to] += a - fee; return true;
    }
}

/// Token that signals failure by returning false (no revert) while `failing`.
contract FalseToken {
    mapping(address => uint256) public balanceOf; mapping(address => mapping(address => uint256)) public allowance; uint256 public totalSupply; bool public failing;
    function setFailing(bool f) external { failing = f; }
    function mint(address to, uint256 a) external { totalSupply += a; balanceOf[to] += a; }
    function approve(address s, uint256 a) external returns (bool) { allowance[msg.sender][s] = a; return true; }
    function transfer(address to, uint256 a) external returns (bool) { if (failing) return false; balanceOf[msg.sender] -= a; balanceOf[to] += a; return true; }
    function transferFrom(address from, address to, uint256 a) external returns (bool) { if (failing) return false; allowance[from][msg.sender] -= a; balanceOf[from] -= a; balanceOf[to] += a; return true; }
}

/// Token with a callback: once armed, the next transfer/transferFrom first calls `target` with `data` (as the token), and records the outcome.
contract ReentrantToken {
    mapping(address => uint256) public balanceOf; mapping(address => mapping(address => uint256)) public allowance; uint256 public totalSupply;
    address public target; bytes public data; bool public onTransfer; bool public onTransferFrom;
    uint256 public attempts; bool public lastOk; bytes public lastRet;
    function arm(address t, bytes calldata d, bool xfer, bool xferFrom) external { target = t; data = d; onTransfer = xfer; onTransferFrom = xferFrom; }
    function mint(address to, uint256 a) external { totalSupply += a; balanceOf[to] += a; }
    function approve(address s, uint256 a) external returns (bool) { allowance[msg.sender][s] = a; return true; }
    function _hook(bool flag) internal { if (flag && target != address(0)) { address t = target; target = address(0); attempts++; (lastOk, lastRet) = t.call(data); } }
    function _move(address from, address to, uint256 a) internal { balanceOf[from] -= a; balanceOf[to] += a; }
    function transfer(address to, uint256 a) external returns (bool) { _hook(onTransfer); _move(msg.sender, to, a); return true; }
    function transferFrom(address from, address to, uint256 a) external returns (bool) {
        _hook(onTransferFrom); if (from != address(this)) allowance[from][msg.sender] -= a; _move(from, to, a); return true;
    }
}

// Real BlindBook + real MockUSDC. Book epoch layout: epochLen 45, commit [0,20), reveal [20,35), clear from 35.
// Standard round _std(): bidder buys 10 @120, seller A sells 5 @80, seller B sells 5 @90 -> V=10 on [90,120], p*=105, A and B filled 5 each.
contract EscrowBase is Test {
    MockUSDC usdc; BlindBook book; ITok tok; OrderEscrow escrow;
    bytes32 constant M = keccak256('CASE-IP16PRO-CLEAR-MAG-001');
    bytes32 constant M2 = keccak256('CASE-OTHER-001');
    bytes32 constant SKU = keccak256(abi.encode('SKU1', 'iPhone 16 Pro Clear MagSafe Case', 'iPhone 16 Pro', 'new-sealed'));
    bytes32 constant SHIPTO = keccak256('salt+address (opaque)');
    bytes32 constant SHIPMENT = keccak256('tracking-123'); bytes32 constant RECEIPT = keccak256('receipt-1');
    uint256 constant CENT = 10_000; uint256 constant EPOCH = 45;
    uint256 constant ACCEPT = 600; uint256 constant SHIP = 1000; uint256 constant VERIFY = 800; uint256 constant DISPUTE = 120; uint256 constant RESOLVE = 300; uint256 constant BPS = 2000;
    uint256 constant P0 = 105;                                    // standard clearing price in cents
    uint256 constant PAY = P0 * 2 * CENT; uint256 constant FUND = 120 * 2 * CENT; uint256 constant BOND_N = PAY * BPS / 10_000;   // qty 2, cap 120
    address buyer = address(0xB0B); address sA = address(0xA11CE); address sB = address(0xB11CE); address bidder = address(0xB1D);
    address verifier = address(0x7E1F); address stranger = address(0x57A); address mallory = address(0xBAD);
    mapping(uint256 => mapping(address => uint256)) askIdx;     // epoch => seller => book order index
    struct O { address who; uint8 side; uint256 price; uint256 units; bytes32 salt; uint256 idx; }
    O[] pend; struct Ask { address who; uint256 units; uint256 price; }
    mapping(uint256 => uint8) prevSeen; uint256 violations; bool strictSteps;

    function setUp() public virtual { usdc = new MockUSDC(); _useToken(ITok(address(usdc))); }
    function _newEscrow(address t) internal returns (OrderEscrow) { return new OrderEscrow(t, address(book), M, SKU, verifier, BPS, ACCEPT, SHIP, VERIFY, DISPUTE, RESOLVE); }
    /// A fresh BlindBook and a fresh escrow, both on token `t` (the escrow requires the book's own token).
    function _useToken(ITok t) internal {
        tok = t; book = new BlindBook(address(t), EPOCH, 20, 35, 2_000_000); book.listMarket(M, 1); book.listMarket(M2, 1);
        address[4] memory bk = [bidder, sA, sB, verifier];
        for (uint256 i = 0; i < 4; i++) {
            t.mint(bk[i], 1_000_000_000_000); vm.prank(bk[i]); t.approve(address(book), type(uint256).max); vm.prank(bk[i]); book.deposit(1_000_000_000_000);
            book.issue(M, bk[i], 1_000_000); book.issue(M2, bk[i], 1_000_000);
        }
        escrow = _newEscrow(address(t));
        address[5] memory w = [buyer, sA, sB, mallory, bidder];
        for (uint256 i = 0; i < 5; i++) { t.mint(w[i], 100_000_000_000_000); vm.prank(w[i]); t.approve(address(escrow), type(uint256).max); }
    }
    function at(uint256 epoch, uint256 off) internal { vm.warp(book.t0() + epoch * EPOCH + off); }
    function _asks1(address w, uint256 u, uint256 p) internal pure returns (Ask[] memory a) { a = new Ask[](1); a[0] = Ask(w, u, p); }
    function _asks2(address w, uint256 u, uint256 p, address w2, uint256 u2, uint256 p2) internal pure returns (Ask[] memory a) { a = new Ask[](2); a[0] = Ask(w, u, p); a[1] = Ask(w2, u2, p2); }
    function _none() internal pure returns (Ask[] memory a) { a = new Ask[](0); }
    function _co(bytes32 m, uint256 e, address who, uint8 side, uint256 price, uint256 units) internal returns (uint256 idx) {
        bytes32 salt = keccak256(abi.encode('salt', e, pend.length, who)); bytes32 h = keccak256(abi.encode(m, e, who, side, price, units, salt));
        vm.prank(who); book.commit(m, h); idx = book.orderCount(m, e) - 1; pend.push(O(who, side, price, units, salt, idx));
    }
    /// One real BlindBook round on market `m` in epoch `e`: optional bid by `bidder`, then the asks; reveal; optionally clear.
    function _epochOn(bytes32 m, uint256 e, uint256 bidUnits, uint256 bidPrice, Ask[] memory asks, bool doClear) internal {
        delete pend; at(e, 5);
        if (bidUnits > 0) _co(m, e, bidder, 0, bidPrice, bidUnits);
        for (uint256 i = 0; i < asks.length; i++) { uint256 ix = _co(m, e, asks[i].who, 1, asks[i].price, asks[i].units); if (m == M) askIdx[e][asks[i].who] = ix; }
        at(e, 25); for (uint256 i = 0; i < pend.length; i++) { O memory o = pend[i]; vm.prank(o.who); book.reveal(m, e, o.idx, o.side, o.price, o.units, o.salt); }
        at(e, 36); if (doClear) book.clear(m, e);
    }
    function _epoch(uint256 bidUnits, uint256 bidPrice, Ask[] memory asks) internal returns (uint256 e) { e = book.currentEpoch() + 1; _epochOn(M, e, bidUnits, bidPrice, asks, true); }
    function _std() internal returns (uint256 e) { e = _epoch(10, 120, _asks2(sA, 5, 80, sB, 5, 90)); }
    function _mk(address who, uint256 qty, uint256 cap) internal returns (uint256 id) { vm.prank(who); id = escrow.createOrder(qty, cap, SHIPTO, block.timestamp + 1 days); }
    function _bond(address who, uint256 amt) internal { vm.prank(who); escrow.depositBond(amt); }
    function _o(uint256 id) internal view returns (OrderEscrow.Order memory) { return escrow.getOrder(id); }
    function _bal(address a) internal view returns (uint256) { return tok.balanceOf(a); }

    // ---- scenario steps (buyer = `buyer`, qty 2, cap 120, seller A, price 105)
    function _offered() internal returns (uint256 id, uint256 e) { id = _mk(buyer, 2, 120); e = _std(); vm.prank(buyer); escrow.matchOrder(id, e, askIdx[e][sA]); }
    function _matched() internal returns (uint256 id, uint256 e) { (id, e) = _offered(); _bond(sA, 10_000_000); vm.prank(sA); escrow.accept(id); }
    function _shipped() internal returns (uint256 id, uint256 e) { (id, e) = _matched(); vm.prank(sA); escrow.ship(id, SHIPMENT); }
    function _delivered() internal returns (uint256 id, uint256 e) { (id, e) = _shipped(); vm.prank(verifier); escrow.attest(id, SKU, true, RECEIPT); }

    // ---- invariants
    function _liveF(OrderEscrow.Status s) internal pure returns (bool) { return s != OrderEscrow.Status.NONE && s != OrderEscrow.Status.RELEASED && s != OrderEscrow.Status.CANCELLED && s != OrderEscrow.Status.REFUNDED; }
    function _liveB(OrderEscrow.Status s) internal pure returns (bool) { return s == OrderEscrow.Status.MATCHED || s == OrderEscrow.Status.SHIPPED || s == OrderEscrow.Status.DELIVERED || s == OrderEscrow.Status.DISPUTED; }
    function _held(OrderEscrow.Order memory o) internal pure returns (bool) {   // the order still reserves its fill units
        OrderEscrow.Status s = o.status;
        return s == OrderEscrow.Status.OFFERED || s == OrderEscrow.Status.MATCHED || s == OrderEscrow.Status.SHIPPED || s == OrderEscrow.Status.DELIVERED || s == OrderEscrow.Status.DISPUTED || s == OrderEscrow.Status.RELEASED || (s == OrderEscrow.Status.REFUNDED && o.bondLocked > 0);
    }
    function _holders() internal view returns (address[10] memory h) { h = [buyer, sA, sB, bidder, verifier, stranger, mallory, address(escrow), address(book), address(tok)]; }
    /// Invariants 1 (ledger), 3 (consumed), 4 and 5 (nothing leaks to the verifier, a stranger or anyone else; conservation of the token).
    function _checkStatic() internal view {
        uint256 n = escrow.nextId(); uint256 sum;
        for (uint256 i = 1; i <= n; i++) { OrderEscrow.Order memory o = _o(i); if (_liveF(o.status)) sum += o.funded; if (_liveB(o.status)) sum += o.bondLocked; }
        address[10] memory h = _holders(); for (uint256 i = 0; i < 7; i++) sum += escrow.bondFree(h[i]);
        assertEq(tok.balanceOf(address(escrow)), sum, 'inv1: balance == live funded + live bond + free bond');
        for (uint256 i = 1; i <= n; i++) {
            OrderEscrow.Order memory o = _o(i); if (o.seller == address(0)) continue;
            uint256 held;
            for (uint256 j = 1; j <= n; j++) { OrderEscrow.Order memory p = _o(j); if (p.seller != address(0) && p.matchEpoch == o.matchEpoch && p.matchIndex == o.matchIndex && _held(p)) held += p.qty; }
            uint256 used = escrow.consumedAt(o.matchEpoch, o.matchIndex);
            (, , , , , uint256 filled, ) = book.getOrder(M, o.matchEpoch, o.matchIndex);
            assertEq(used, held, 'inv3: consumed == units held by live or settled orders'); assertLe(used, filled, 'inv3: consumed <= filled');
        }
        assertEq(tok.balanceOf(verifier), 0, 'inv4: the verifier never receives funds'); assertEq(tok.balanceOf(stranger), 0, 'inv4: a stranger never receives funds');
        uint256 total; for (uint256 i = 0; i < 10; i++) total += tok.balanceOf(h[i]);
        assertEq(total, tok.totalSupply(), 'inv5: nothing leaves the known holders, nothing is created');
    }
    function _rank(OrderEscrow.Status s) internal pure returns (uint256) {
        if (s == OrderEscrow.Status.RELEASED || s == OrderEscrow.Status.CANCELLED || s == OrderEscrow.Status.REFUNDED) return 7;
        if (s == OrderEscrow.Status.DISPUTED) return 6; return uint256(s);
    }
    function _stepOk(OrderEscrow.Status p, OrderEscrow.Status c) internal pure returns (bool) {
        if (p == c) return true; OrderEscrow.Status F = OrderEscrow.Status.FUNDED;
        if (p == F) return c == OrderEscrow.Status.OFFERED || c == OrderEscrow.Status.CANCELLED;
        if (p == OrderEscrow.Status.OFFERED) return c == OrderEscrow.Status.MATCHED || c == OrderEscrow.Status.REFUNDED;
        if (p == OrderEscrow.Status.MATCHED) return c == OrderEscrow.Status.SHIPPED || c == OrderEscrow.Status.REFUNDED;
        if (p == OrderEscrow.Status.SHIPPED) return c == OrderEscrow.Status.DELIVERED || c == OrderEscrow.Status.REFUNDED;
        if (p == OrderEscrow.Status.DELIVERED) return c == OrderEscrow.Status.DISPUTED || c == OrderEscrow.Status.RELEASED;
        if (p == OrderEscrow.Status.DISPUTED) return c == OrderEscrow.Status.RELEASED || c == OrderEscrow.Status.REFUNDED;
        return false;
    }
    /// Invariant 2: statuses only move forward along legal edges; a terminal status never changes.
    function _track() internal {
        uint256 n = escrow.nextId();
        for (uint256 i = 1; i <= n; i++) {
            OrderEscrow.Status c = _o(i).status; uint8 seen = prevSeen[i];
            if (seen != 0) {
                OrderEscrow.Status p = OrderEscrow.Status(seen - 1);
                bool ok = strictSteps ? _stepOk(p, c) : (p == c || (_rank(p) < 7 && _rank(c) > _rank(p)));
                if (!ok) violations++;
            }
            prevSeen[i] = uint8(c) + 1;
        }
    }
    function _inv() internal { _track(); assertEq(violations, 0, 'inv2: legal forward transitions only'); _checkStatic(); }
}

contract OrderEscrowTest is EscrowBase {
    // ================= constructor
    function testConstructorStoresTheScheduleAndReadsCentFromTheBook() public view {
        assertEq(address(escrow.token()), address(usdc)); assertEq(address(escrow.book()), address(book)); assertEq(escrow.MARKET(), M); assertEq(escrow.SKU(), SKU);
        assertEq(escrow.verifier(), verifier); assertEq(escrow.bondBps(), 2000); assertEq(escrow.CENT(), 10_000);
        assertEq(escrow.acceptWindow(), 600); assertEq(escrow.shipWindow(), 1000); assertEq(escrow.verifyWindow(), 800); assertEq(escrow.disputeWindow(), 120); assertEq(escrow.resolveWindow(), 300);
    }
    function testConstructorRejectsAnUnlistedMarket() public {
        vm.expectRevert(OrderEscrow.BadConfig.selector); new OrderEscrow(address(usdc), address(book), bytes32(uint256(7)), SKU, verifier, BPS, ACCEPT, SHIP, VERIFY, DISPUTE, RESOLVE);
    }
    function testConstructorRejectsBadConfig() public {
        address u = address(usdc); address b = address(book);
        vm.expectRevert(OrderEscrow.BadConfig.selector); new OrderEscrow(address(0), b, M, SKU, verifier, BPS, ACCEPT, SHIP, VERIFY, DISPUTE, RESOLVE);
        vm.expectRevert(OrderEscrow.BadConfig.selector); new OrderEscrow(u, address(0), M, SKU, verifier, BPS, ACCEPT, SHIP, VERIFY, DISPUTE, RESOLVE);
        vm.expectRevert(OrderEscrow.BadConfig.selector); new OrderEscrow(u, b, M, SKU, address(0), BPS, ACCEPT, SHIP, VERIFY, DISPUTE, RESOLVE);
        vm.expectRevert(OrderEscrow.BadConfig.selector); new OrderEscrow(u, b, M, SKU, verifier, 0, ACCEPT, SHIP, VERIFY, DISPUTE, RESOLVE);
        vm.expectRevert(OrderEscrow.BadConfig.selector); new OrderEscrow(u, b, M, SKU, verifier, 5001, ACCEPT, SHIP, VERIFY, DISPUTE, RESOLVE);
        vm.expectRevert(OrderEscrow.BadConfig.selector); new OrderEscrow(u, b, M, SKU, verifier, BPS, 59, SHIP, VERIFY, DISPUTE, RESOLVE);
        vm.expectRevert(OrderEscrow.BadConfig.selector); new OrderEscrow(u, b, M, SKU, verifier, BPS, ACCEPT, SHIP, VERIFY, DISPUTE, 30 days + 1);
        new OrderEscrow(u, b, M, SKU, verifier, 5000, 60, 60, 60, 60, 30 days);   // both bounds are inclusive
        new OrderEscrow(u, b, M, SKU, verifier, 1, 30 days, 30 days, 30 days, 30 days, 60);
    }

    function testDeployScriptHelpersMatchTheSpec() public {
        DeployOrderEscrow d = new DeployOrderEscrow();
        assertEq(d.sku(), SKU); assertEq(d.marketIdOf('CASE-IP16PRO-CLEAR-MAG-001'), M); assertEq(d.marketIdOf(vm.toString(M)), M);
    }

    // ================= happy path with exact amounts, events and invariants
    function testHappyPathPaysTheClearedPriceAndRefundsTheDifference() public {
        uint256 b0 = _bal(buyer); uint256 a0 = _bal(sA);
        uint256 id = _mk(buyer, 2, 120); assertEq(id, 1); assertEq(_bal(buyer), b0 - FUND); assertEq(_bal(address(escrow)), FUND); assertEq(FUND, 2_400_000); _inv();
        uint256 e = _std(); (uint256 price, uint256 vol) = book.results(M, e); assertEq(price, 105); assertEq(vol, 10);
        vm.expectEmit(true, true, false, true); emit OrderEscrow.Offered(id, sA, e, askIdx[e][sA], 105, block.timestamp + ACCEPT);
        vm.prank(buyer); escrow.matchOrder(id, e, askIdx[e][sA]); assertEq(uint256(_o(id).status), uint256(OrderEscrow.Status.OFFERED)); assertEq(escrow.consumedAt(e, askIdx[e][sA]), 2); _inv();
        _bond(sA, 10_000_000); assertEq(escrow.bondNeeded(id), 420_000); assertEq(BOND_N, 420_000);
        vm.prank(sA); escrow.accept(id); assertEq(_o(id).bondLocked, BOND_N); assertEq(escrow.bondFree(sA), 10_000_000 - BOND_N); assertEq(_o(id).shipBy, block.timestamp + SHIP); _inv();
        vm.prank(sA); escrow.ship(id, SHIPMENT); assertEq(_o(id).shipmentHash, SHIPMENT); assertEq(_o(id).verifyBy, block.timestamp + VERIFY); _inv();
        vm.prank(verifier); escrow.attest(id, SKU, true, RECEIPT); assertEq(_o(id).receiptHash, RECEIPT); assertEq(_o(id).releaseAfter, block.timestamp + DISPUTE); _inv();
        vm.expectEmit(true, true, true, true); emit OrderEscrow.Released(id, sA, PAY, FUND - PAY, BOND_N, OrderEscrow.ReleaseWhy.BUYER, buyer);
        vm.prank(buyer); escrow.release(id);
        assertEq(PAY, 2_100_000); assertEq(_bal(sA) + 10_000_000, a0 + PAY, 'seller: deposited a 10_000_000 bond (still escrowed as free bond), was paid exactly 2_100_000');
        assertEq(_bal(buyer), b0 - PAY, 'buyer net cost is exactly cents*qty*CENT'); assertEq(escrow.bondFree(sA), 10_000_000); assertEq(_bal(address(escrow)), 10_000_000);
        assertEq(uint256(_o(id).status), uint256(OrderEscrow.Status.RELEASED)); _inv();
    }
    function testPriceEqualToTheCapRefundsNothing() public {
        uint256 id = _mk(buyer, 2, 105); uint256 e = _std(); uint256 b = _bal(buyer);
        vm.prank(buyer); escrow.matchOrder(id, e, askIdx[e][sA]); _bond(sA, 1_000_000); vm.prank(sA); escrow.accept(id); vm.prank(sA); escrow.ship(id, SHIPMENT);
        vm.prank(verifier); escrow.attest(id, SKU, true, RECEIPT); vm.prank(buyer); escrow.release(id);
        assertEq(_bal(buyer), b, 'no refund, cap == price'); assertEq(_o(id).funded, PAY); _inv();
    }
    function testMaxValuesFundExactlyAndSettleExactly() public {
        uint256 b0 = _bal(buyer); uint256 id = _mk(buyer, 1000, 1_000_000);
        assertEq(_o(id).funded, 1e13); assertEq(_bal(address(escrow)), 1e13); assertEq(b0 - _bal(buyer), 10_000_000_000_000);
        vm.prank(buyer); escrow.cancel(id); assertEq(_bal(buyer), b0); _inv();
        id = _mk(buyer, 1000, 1_000_000); uint256 e = _epoch(1000, 100, _asks1(sA, 1000, 80));      // p* = 90, filled 1000
        (uint256 price,) = book.results(M, e); assertEq(price, 90);
        vm.prank(buyer); escrow.matchOrder(id, e, askIdx[e][sA]);
        uint256 pay = 90 * 1000 * CENT; uint256 bond = pay * BPS / 10_000; assertEq(pay, 900_000_000); assertEq(bond, 180_000_000);
        _bond(sA, bond); vm.prank(sA); escrow.accept(id); vm.prank(sA); escrow.ship(id, SHIPMENT); vm.prank(verifier); escrow.attest(id, SKU, true, RECEIPT);
        uint256 s0 = _bal(sA); b0 = _bal(buyer); vm.prank(buyer); escrow.release(id);
        assertEq(_bal(sA) - s0, pay); assertEq(_bal(buyer) - b0, 1e13 - pay); assertEq(escrow.bondFree(sA), bond); _inv();
    }

    // ================= createOrder / cancel
    function testCreateOrderBounds() public {
        vm.prank(buyer); vm.expectRevert(abi.encodeWithSelector(OrderEscrow.BadQty.selector, 0)); escrow.createOrder(0, 100, SHIPTO, block.timestamp + 1 days);
        vm.prank(buyer); vm.expectRevert(abi.encodeWithSelector(OrderEscrow.BadQty.selector, 1001)); escrow.createOrder(1001, 100, SHIPTO, block.timestamp + 1 days);
        vm.prank(buyer); vm.expectRevert(abi.encodeWithSelector(OrderEscrow.BadPrice.selector, 0)); escrow.createOrder(1, 0, SHIPTO, block.timestamp + 1 days);
        vm.prank(buyer); vm.expectRevert(abi.encodeWithSelector(OrderEscrow.BadPrice.selector, 1_000_001)); escrow.createOrder(1, 1_000_001, SHIPTO, block.timestamp + 1 days);
        uint256 t = block.timestamp;
        vm.prank(buyer); vm.expectRevert(abi.encodeWithSelector(OrderEscrow.BadMatchBy.selector, t)); escrow.createOrder(1, 100, SHIPTO, t);
        vm.prank(buyer); vm.expectRevert(abi.encodeWithSelector(OrderEscrow.BadMatchBy.selector, t + 30 days + 1)); escrow.createOrder(1, 100, SHIPTO, t + 30 days + 1);
        vm.prank(buyer); escrow.createOrder(1, 100, SHIPTO, t + 1); vm.prank(buyer); escrow.createOrder(1, 100, SHIPTO, t + 30 days); _inv();
    }
    function testBuyerCannotBeTheVerifier() public { vm.prank(verifier); vm.expectRevert(OrderEscrow.RoleConflict.selector); escrow.createOrder(1, 100, SHIPTO, block.timestamp + 1 days); }
    function testCancelRefundsTheBuyerInFullAndOnlyOnce() public {
        uint256 b0 = _bal(buyer); uint256 id = _mk(buyer, 3, 110);
        vm.expectEmit(true, true, false, true); emit OrderEscrow.Cancelled(id, buyer, 3 * 110 * CENT, buyer);
        vm.prank(buyer); escrow.cancel(id); assertEq(_bal(buyer), b0); assertEq(uint256(_o(id).status), uint256(OrderEscrow.Status.CANCELLED));
        vm.prank(buyer); vm.expectRevert(abi.encodeWithSelector(OrderEscrow.BadStatus.selector, OrderEscrow.Status.CANCELLED, OrderEscrow.Status.FUNDED)); escrow.cancel(id); _inv();
    }
    function testAStrangerCanCancelOnlyAfterMatchByAndTheBuyerGetsTheRefund() public {
        uint256 b0 = _bal(buyer); uint256 id = _mk(buyer, 3, 110); uint256 mb = _o(id).matchBy;
        vm.prank(stranger); vm.expectRevert(OrderEscrow.Unauthorized.selector); escrow.cancel(id);
        vm.warp(mb); vm.prank(stranger); vm.expectRevert(OrderEscrow.Unauthorized.selector); escrow.cancel(id);       // equal to matchBy: still the buyer's
        vm.warp(mb + 1); vm.prank(stranger); escrow.cancel(id);
        assertEq(_bal(buyer), b0); assertEq(_bal(stranger), 0); _inv();
    }
    function testUnknownOrderAndWrongStatusRevert() public {
        vm.expectRevert(abi.encodeWithSelector(OrderEscrow.BadStatus.selector, OrderEscrow.Status.NONE, OrderEscrow.Status.FUNDED)); escrow.cancel(99);
        (uint256 id,) = _offered(); vm.prank(buyer); vm.expectRevert(abi.encodeWithSelector(OrderEscrow.BadStatus.selector, OrderEscrow.Status.OFFERED, OrderEscrow.Status.FUNDED)); escrow.cancel(id);
    }

    // ================= matchOrder: evidence rules
    function testOnlyTheBuyerMatchesAndOnlyBeforeMatchBy() public {
        uint256 id = _mk(buyer, 2, 120); uint256 e = _std(); uint256 ix = askIdx[e][sA]; uint256 mb = _o(id).matchBy;
        vm.prank(stranger); vm.expectRevert(OrderEscrow.Unauthorized.selector); escrow.matchOrder(id, e, ix);
        vm.warp(mb + 1); vm.prank(buyer); vm.expectRevert(abi.encodeWithSelector(OrderEscrow.Expired.selector, mb)); escrow.matchOrder(id, e, ix);
        vm.warp(mb); vm.prank(buyer); escrow.matchOrder(id, e, ix); _inv();                                           // equal to matchBy is still in time
    }
    function testIndexEqualToOrderCountRevertsWithTheCustomError() public {
        uint256 id = _mk(buyer, 2, 120); uint256 e = _std(); assertEq(book.orderCount(M, e), 3);
        vm.prank(buyer); vm.expectRevert(abi.encodeWithSelector(OrderEscrow.NoSuchOrder.selector, e, 3)); escrow.matchOrder(id, e, 3);
        vm.prank(buyer); vm.expectRevert(abi.encodeWithSelector(OrderEscrow.NoSuchOrder.selector, e + 5, 0)); escrow.matchOrder(id, e + 5, 0);
    }
    function testAnUnclearedEpochCannotBeUsed() public {
        uint256 id = _mk(buyer, 2, 120); uint256 e = book.currentEpoch() + 1; _epochOn(M, e, 10, 120, _asks2(sA, 5, 80, sB, 5, 90), false);
        vm.prank(buyer); vm.expectRevert(abi.encodeWithSelector(OrderEscrow.NotCleared.selector, e)); escrow.matchOrder(id, e, askIdx[e][sA]);
        book.clear(M, e); vm.prank(buyer); escrow.matchOrder(id, e, askIdx[e][sA]); _inv();
    }
    function testASellOnlyEpochFillsNothingSoMatchReverts() public {
        uint256 id = _mk(buyer, 2, 120); uint256 e = _epoch(0, 0, _asks1(sA, 5, 80)); (uint256 p, uint256 v) = book.results(M, e); assertEq(p, 0); assertEq(v, 0);
        (, , , , , uint256 filled, ) = book.getOrder(M, e, askIdx[e][sA]); assertEq(filled, 0);
        vm.prank(buyer); vm.expectRevert(abi.encodeWithSelector(OrderEscrow.FillExhausted.selector, 0, 0, 2)); escrow.matchOrder(id, e, askIdx[e][sA]); _inv();
    }
    function testABuyOrderUnfilledSellAndUnrevealedOrderAreNotEvidence() public {
        uint256 id = _mk(buyer, 2, 120); uint256 e = book.currentEpoch() + 1; delete pend; at(e, 5);
        _co(M, e, bidder, 0, 120, 10); _co(M, e, sA, 1, 80, 5); _co(M, e, sB, 1, 200, 5);
        vm.prank(verifier); book.commit(M, bytes32(uint256(1)));                                                       // index 3: never revealed
        at(e, 25); for (uint256 i = 0; i < 3; i++) { O memory o = pend[i]; vm.prank(o.who); book.reveal(M, e, o.idx, o.side, o.price, o.units, o.salt); }
        at(e, 36); book.clear(M, e);
        vm.prank(buyer); vm.expectRevert(OrderEscrow.NotASell.selector); escrow.matchOrder(id, e, 0);                  // the bid
        vm.prank(buyer); vm.expectRevert(OrderEscrow.NotASell.selector); escrow.matchOrder(id, e, 3);                  // unrevealed
        vm.prank(buyer); vm.expectRevert(abi.encodeWithSelector(OrderEscrow.FillExhausted.selector, 0, 0, 2)); escrow.matchOrder(id, e, 2);   // sell above p*, filled 0
        vm.prank(buyer); escrow.matchOrder(id, e, 1);
    }
    function testClearingPriceAboveTheCapReverts() public {
        uint256 id = _mk(buyer, 2, 104); uint256 e = _std();
        vm.prank(buyer); vm.expectRevert(abi.encodeWithSelector(OrderEscrow.PriceAboveCap.selector, 105, 104)); escrow.matchOrder(id, e, askIdx[e][sA]);
    }
    function testStaleEpochBoundary() public {
        uint256 e = book.currentEpoch() + 1;
        at(e, 0); uint256 ok = _mk(buyer, 2, 120);                                                                    // createdAt == epochStart(e)
        _epochOn(M, e, 10, 120, _asks2(sA, 5, 80, sB, 5, 90), true); vm.prank(buyer); escrow.matchOrder(ok, e, askIdx[e][sA]); _inv();
        e = book.currentEpoch() + 1; at(e, 1); uint256 stale = _mk(buyer, 2, 120);                                    // createdAt == epochStart(e) + 1
        _epochOn(M, e, 10, 120, _asks2(sA, 5, 80, sB, 5, 90), true); uint256 start = book.epochStart(e);
        vm.prank(buyer); vm.expectRevert(abi.encodeWithSelector(OrderEscrow.StaleEpoch.selector, start, start + 1)); escrow.matchOrder(stale, e, askIdx[e][sA]);
        // an epoch that began before the order was funded is refused even when it is cleared
        uint256 old = _o(ok).matchEpoch; uint256 late = _mk(buyer, 2, 120); uint256 oldStart = book.epochStart(old); uint256 lateAt = _o(late).createdAt;
        vm.prank(buyer); vm.expectRevert(abi.encodeWithSelector(OrderEscrow.StaleEpoch.selector, oldStart, lateAt)); escrow.matchOrder(late, old, askIdx[old][sB]);
    }
    function testOrdersCannotReferenceAnotherMarket() public {
        uint256 id = _mk(buyer, 2, 120); uint256 e = book.currentEpoch() + 1;
        _epochOn(M2, e, 10, 120, _asks2(sA, 5, 80, sB, 5, 90), true); (uint256 p,) = book.results(M2, e); assertEq(p, 105);
        vm.prank(buyer); vm.expectRevert(abi.encodeWithSelector(OrderEscrow.NoSuchOrder.selector, e, 1)); escrow.matchOrder(id, e, 1);   // M has no orders in that epoch
    }
    function testBuyerEqualsSellerReverts() public {
        uint256 id = _mk(sA, 2, 120); uint256 e = _std();
        vm.prank(sA); vm.expectRevert(OrderEscrow.RoleConflict.selector); escrow.matchOrder(id, e, askIdx[e][sA]);
        vm.prank(sA); escrow.matchOrder(id, e, askIdx[e][sB]);                                                        // another seller is fine
    }
    function testSellerEqualsVerifierReverts() public {
        uint256 id = _mk(buyer, 2, 120); uint256 e = _epoch(5, 120, _asks1(verifier, 5, 80));
        vm.prank(buyer); vm.expectRevert(OrderEscrow.RoleConflict.selector); escrow.matchOrder(id, e, askIdx[e][verifier]);
    }
    function testABidderThatIsAlsoTheSellerStillMatches() public {                                                    // documents the limit: P is not an independent price
        uint256 id = _mk(buyer, 2, 120); uint256 e = _epoch(5, 120, _asks1(bidder, 5, 80)); (uint256 p, uint256 v) = book.results(M, e); assertEq(v, 5); assertEq(p, 100);
        vm.prank(buyer); escrow.matchOrder(id, e, askIdx[e][bidder]); assertEq(_o(id).seller, bidder); assertEq(uint256(_o(id).priceCents), 100); _inv();
    }

    // ================= consumed accounting (fill 3, orders of 2 and 2)
    function _fill3() internal returns (uint256 e) { e = _epoch(3, 100, _asks2(sA, 3, 80, sB, 2, 200)); (, , , , , uint256 f, ) = book.getOrder(M, e, askIdx[e][sA]); assertEq(f, 3); }
    function testOneFillCannotBackTwoOrdersAndRefundUnacceptedReleasesTheUnits() public {
        uint256 o1 = _mk(buyer, 2, 120); uint256 o2 = _mk(buyer, 2, 120); uint256 o3 = _mk(buyer, 3, 120); uint256 e = _fill3(); uint256 ix = askIdx[e][sA];
        vm.prank(buyer); escrow.matchOrder(o1, e, ix); assertEq(escrow.consumedAt(e, ix), 2);
        vm.prank(buyer); vm.expectRevert(abi.encodeWithSelector(OrderEscrow.FillExhausted.selector, 3, 2, 2)); escrow.matchOrder(o2, e, ix);
        vm.prank(buyer); vm.expectRevert(abi.encodeWithSelector(OrderEscrow.FillExhausted.selector, 3, 2, 3)); escrow.matchOrder(o3, e, ix);
        _inv();
        vm.prank(buyer); escrow.refundUnaccepted(o1); assertEq(escrow.consumedAt(e, ix), 0); _inv();
        vm.prank(buyer); escrow.matchOrder(o3, e, ix); assertEq(escrow.consumedAt(e, ix), 3); _inv();                // a qty-3 order now matches
        vm.prank(buyer); vm.expectRevert(abi.encodeWithSelector(OrderEscrow.FillExhausted.selector, 3, 3, 2)); escrow.matchOrder(o2, e, ix);
    }
    function testRefundedViaRefundUnshippedLeavesTheUnitsConsumed() public {
        uint256 oA = _mk(buyer, 2, 120); uint256 oB = _mk(buyer, 2, 120); uint256 e = _fill3(); uint256 ix = askIdx[e][sA];
        vm.prank(buyer); escrow.matchOrder(oA, e, ix); _bond(sA, 10_000_000); vm.prank(sA); escrow.accept(oA);
        vm.warp(_o(oA).shipBy + 1); escrow.refundUnshipped(oA);
        assertEq(uint256(_o(oA).status), uint256(OrderEscrow.Status.REFUNDED)); assertEq(escrow.consumedAt(e, ix), 2, 'still consumed after a seller-fault refund'); _inv();
        vm.prank(buyer); vm.expectRevert(abi.encodeWithSelector(OrderEscrow.FillExhausted.selector, 3, 2, 2)); escrow.matchOrder(oB, e, ix); _inv();
    }
    function testConsumedStaysConsumedOnEveryPathAfterAccept() public {
        (uint256 a, uint256 e) = _delivered(); uint256 ix = askIdx[e][sA]; vm.prank(buyer); escrow.release(a); assertEq(escrow.consumedAt(e, ix), 2); _inv();
        (uint256 b, uint256 e2) = _shipped(); vm.warp(_o(b).verifyBy + 1); escrow.refundUnverified(b); assertEq(escrow.consumedAt(e2, askIdx[e2][sA]), 2); _inv();
        (uint256 c, uint256 e3) = _shipped(); vm.prank(verifier); escrow.attest(c, SKU, false, RECEIPT); assertEq(escrow.consumedAt(e3, askIdx[e3][sA]), 2); _inv();
    }

    // ================= bond, accept
    function testWithdrawBondBeforeAcceptMakesAcceptRevertCleanly() public {
        (uint256 id,) = _offered(); _bond(sA, 10_000_000); vm.prank(sA); escrow.withdrawBond(10_000_000);
        vm.prank(sA); vm.expectRevert(abi.encodeWithSelector(OrderEscrow.InsufficientBond.selector, 0, BOND_N)); escrow.accept(id);
        assertEq(uint256(_o(id).status), uint256(OrderEscrow.Status.OFFERED)); _inv();
    }
    function testAcceptOnlyBySellerOnlyBeforeAcceptByAndWithEnoughBond() public {
        (uint256 id,) = _offered(); _bond(sA, BOND_N - 1); uint256 ab = _o(id).acceptBy;
        vm.prank(sA); vm.expectRevert(abi.encodeWithSelector(OrderEscrow.InsufficientBond.selector, BOND_N - 1, BOND_N)); escrow.accept(id);
        _bond(sA, 1); vm.prank(buyer); vm.expectRevert(OrderEscrow.Unauthorized.selector); escrow.accept(id);
        vm.prank(sB); vm.expectRevert(OrderEscrow.Unauthorized.selector); escrow.accept(id);
        vm.warp(ab + 1); vm.prank(sA); vm.expectRevert(abi.encodeWithSelector(OrderEscrow.Expired.selector, ab)); escrow.accept(id);
        vm.warp(ab); vm.prank(sA); escrow.accept(id); assertEq(escrow.bondFree(sA), 0); assertEq(_o(id).bondLocked, BOND_N); _inv();
    }
    function testLockedBondCannotBeWithdrawnAndFreeBondCan() public {
        (uint256 id,) = _matched(); assertEq(escrow.bondFree(sA), 10_000_000 - BOND_N);
        vm.prank(sA); vm.expectRevert(abi.encodeWithSelector(OrderEscrow.InsufficientBond.selector, 10_000_000 - BOND_N, 10_000_000)); escrow.withdrawBond(10_000_000);
        uint256 t0 = _bal(sA); vm.prank(sA); escrow.withdrawBond(10_000_000 - BOND_N); assertEq(_bal(sA) - t0, 10_000_000 - BOND_N);
        assertEq(_bal(address(escrow)), FUND + BOND_N); id; _inv();
    }
    function testBondRoundingNeverUnderfunds() public {
        // CENT (10_000) divides the basis-point denominator, so price*qty*CENT*bps/10_000 is exact: the round-up is a guard, not observable
        uint256 id = _mk(buyer, 3, 120); uint256 e = _std(); vm.prank(buyer); escrow.matchOrder(id, e, askIdx[e][sA]);
        assertEq(escrow.bondNeeded(id) * 10_000, 105 * 3 * CENT * BPS);
    }

    // ================= bond-theft scenario from the audit
    function testAStrangerBuyerCanNeverTouchAnUnacceptingSellersBond() public {
        _bond(sA, 10_000_000); uint256 m0 = _bal(mallory);
        uint256 id = _mk(mallory, 2, 120); uint256 e = _std();                                                        // random ship-to, public evidence
        vm.prank(mallory); escrow.matchOrder(id, e, askIdx[e][sA]);
        vm.warp(block.timestamp + ACCEPT + SHIP + 10);
        vm.prank(mallory); vm.expectRevert(abi.encodeWithSelector(OrderEscrow.BadStatus.selector, OrderEscrow.Status.OFFERED, OrderEscrow.Status.MATCHED)); escrow.refundUnshipped(id);
        vm.prank(mallory); vm.expectRevert(OrderEscrow.Unauthorized.selector); escrow.accept(id);
        uint256 ab = _o(id).acceptBy; vm.prank(sA); vm.expectRevert(abi.encodeWithSelector(OrderEscrow.Expired.selector, ab)); escrow.accept(id);
        vm.prank(mallory); escrow.refundUnaccepted(id);                                                                // she only gets her own funds back
        assertEq(_bal(mallory), m0); assertEq(escrow.bondFree(sA), 10_000_000); assertEq(_bal(address(escrow)), 10_000_000);
        vm.prank(sA); escrow.withdrawBond(10_000_000); assertEq(_bal(address(escrow)), 0); _inv();
    }

    // ================= ship, attest, verifier
    function testShipRules() public {
        (uint256 id,) = _matched(); uint256 sb = _o(id).shipBy;
        vm.prank(buyer); vm.expectRevert(OrderEscrow.Unauthorized.selector); escrow.ship(id, SHIPMENT);
        vm.prank(sA); vm.expectRevert(OrderEscrow.ZeroHash.selector); escrow.ship(id, bytes32(0));
        vm.warp(sb + 1); vm.prank(sA); vm.expectRevert(abi.encodeWithSelector(OrderEscrow.Expired.selector, sb)); escrow.ship(id, SHIPMENT);
        vm.warp(sb); vm.prank(sA); escrow.ship(id, SHIPMENT); assertEq(uint256(_o(id).status), uint256(OrderEscrow.Status.SHIPPED)); _inv();
    }
    function testOnlyTheVerifierAttestsAndResolves() public {
        (uint256 id,) = _shipped();
        vm.prank(buyer); vm.expectRevert(OrderEscrow.Unauthorized.selector); escrow.attest(id, SKU, true, RECEIPT);
        vm.prank(sA); vm.expectRevert(OrderEscrow.Unauthorized.selector); escrow.attest(id, SKU, true, RECEIPT);
        vm.prank(verifier); escrow.attest(id, SKU, true, RECEIPT); vm.prank(buyer); escrow.dispute(id);
        vm.prank(buyer); vm.expectRevert(OrderEscrow.Unauthorized.selector); escrow.resolve(id, false);
        vm.prank(sA); vm.expectRevert(OrderEscrow.Unauthorized.selector); escrow.resolve(id, true);
    }
    function testAttestNotOkRefundsTheBuyerAndSlashesTheBondToTheBuyer() public {
        (uint256 id,) = _shipped(); uint256 b = _bal(buyer); uint256 free = escrow.bondFree(sA);
        vm.expectEmit(true, true, false, true); emit OrderEscrow.Refunded(id, buyer, FUND, BOND_N, 0, OrderEscrow.Why.REJECTED);
        vm.prank(verifier); escrow.attest(id, SKU, false, RECEIPT);
        assertEq(_bal(buyer) - b, FUND + BOND_N); assertEq(escrow.bondFree(sA), free); assertEq(_o(id).receiptHash, RECEIPT); assertEq(_bal(verifier), 0);
        assertEq(uint256(_o(id).status), uint256(OrderEscrow.Status.REFUNDED)); _inv();
    }
    function testAttestWithTheWrongSkuIsARefundToo() public {
        (uint256 id,) = _shipped(); uint256 b = _bal(buyer); vm.prank(verifier); escrow.attest(id, keccak256('some other sku'), true, RECEIPT);
        assertEq(_bal(buyer) - b, FUND + BOND_N); assertEq(uint256(_o(id).status), uint256(OrderEscrow.Status.REFUNDED)); _inv();
    }
    function testAttestAtVerifyByPlusOneRevertsWhileRefundUnverifiedSucceeds() public {
        (uint256 id,) = _shipped(); uint256 vb = _o(id).verifyBy; uint256 b = _bal(buyer);
        vm.warp(vb); vm.expectRevert(abi.encodeWithSelector(OrderEscrow.TooEarly.selector, vb)); escrow.refundUnverified(id);     // verifier still has the whole second
        vm.warp(vb + 1); vm.prank(verifier); vm.expectRevert(abi.encodeWithSelector(OrderEscrow.Expired.selector, vb)); escrow.attest(id, SKU, true, RECEIPT);
        vm.prank(stranger); escrow.refundUnverified(id);
        assertEq(_bal(buyer) - b, FUND, 'buyer made whole, no slash'); assertEq(escrow.bondFree(sA), 10_000_000, 'bond back to the seller'); assertEq(_bal(stranger), 0); _inv();
    }
    function testAttestAtVerifyByStillWorks() public { (uint256 id,) = _shipped(); vm.warp(_o(id).verifyBy); vm.prank(verifier); escrow.attest(id, SKU, true, RECEIPT); _inv(); }

    // ================= release / dispute / resolve
    function testReleaseByAStrangerOnlyAtOrAfterReleaseAfterAndPaysOnlyTheParties() public {
        (uint256 id,) = _delivered(); uint256 ra = _o(id).releaseAfter; uint256 b = _bal(buyer); uint256 s = _bal(sA);
        vm.warp(ra - 1); vm.prank(stranger); vm.expectRevert(OrderEscrow.Unauthorized.selector); escrow.release(id);
        vm.warp(ra); vm.prank(stranger); escrow.release(id);
        assertEq(_bal(sA) - s, PAY); assertEq(_bal(buyer) - b, FUND - PAY); assertEq(_bal(stranger), 0); assertEq(_bal(verifier), 0); _inv();
        vm.prank(buyer); vm.expectRevert(abi.encodeWithSelector(OrderEscrow.BadStatus.selector, OrderEscrow.Status.RELEASED, OrderEscrow.Status.DELIVERED)); escrow.release(id);
    }
    function testDisputeBoundaryAtReleaseAfter() public {
        (uint256 id,) = _delivered(); uint256 ra = _o(id).releaseAfter;
        vm.prank(sA); vm.expectRevert(OrderEscrow.Unauthorized.selector); escrow.dispute(id);
        vm.warp(ra); vm.prank(buyer); vm.expectRevert(abi.encodeWithSelector(OrderEscrow.Expired.selector, ra)); escrow.dispute(id);        // equal: too late
        vm.prank(stranger); escrow.release(id);                                                                                               // equal: anyone may release
        (uint256 id2,) = _delivered(); vm.warp(_o(id2).releaseAfter - 1); vm.prank(buyer); escrow.dispute(id2);
        assertEq(uint256(_o(id2).status), uint256(OrderEscrow.Status.DISPUTED)); assertEq(_o(id2).resolveBy, block.timestamp + RESOLVE); _inv();
    }
    function testResolveSellerWinsPaysLikeRelease() public {
        (uint256 id,) = _delivered(); vm.prank(buyer); escrow.dispute(id); uint256 b = _bal(buyer); uint256 s = _bal(sA);
        vm.prank(verifier); escrow.resolve(id, true);
        assertEq(_bal(sA) - s, PAY); assertEq(_bal(buyer) - b, FUND - PAY); assertEq(escrow.bondFree(sA), 10_000_000); assertEq(uint256(_o(id).status), uint256(OrderEscrow.Status.RELEASED)); _inv();
    }
    function testResolveBuyerWinsRefundsAndSlashes() public {
        (uint256 id,) = _delivered(); vm.prank(buyer); escrow.dispute(id); uint256 b = _bal(buyer); uint256 free = escrow.bondFree(sA);
        vm.prank(verifier); escrow.resolve(id, false);
        assertEq(_bal(buyer) - b, FUND + BOND_N); assertEq(escrow.bondFree(sA), free); assertEq(uint256(_o(id).status), uint256(OrderEscrow.Status.REFUNDED)); assertEq(_bal(verifier), 0); _inv();
    }
    function testResolveOnlyUntilResolveBy() public {
        (uint256 id,) = _delivered(); vm.prank(buyer); escrow.dispute(id); uint256 rb = _o(id).resolveBy;
        vm.warp(rb + 1); vm.prank(verifier); vm.expectRevert(abi.encodeWithSelector(OrderEscrow.Expired.selector, rb)); escrow.resolve(id, false);
        vm.warp(rb); vm.prank(verifier); escrow.resolve(id, false); _inv();
    }
    function testSilentVerifierAfterDisputeReleaseUnresolvedPaysTheSeller() public {
        (uint256 id,) = _delivered(); vm.prank(buyer); escrow.dispute(id); uint256 rb = _o(id).resolveBy; uint256 b = _bal(buyer); uint256 s = _bal(sA);
        vm.warp(rb); vm.expectRevert(abi.encodeWithSelector(OrderEscrow.TooEarly.selector, rb)); escrow.releaseUnresolved(id);
        vm.warp(rb + 1); vm.prank(stranger); escrow.releaseUnresolved(id);
        assertEq(_bal(sA) - s, PAY); assertEq(_bal(buyer) - b, FUND - PAY); assertEq(_bal(stranger), 0); assertEq(escrow.bondFree(sA), 10_000_000); _inv();
    }

    // ================= timeout exits
    function testRefundUnshippedSlashesTheBondToTheBuyerAndPaysTheCallerNothing() public {
        (uint256 id,) = _matched(); uint256 sb = _o(id).shipBy; uint256 b = _bal(buyer); uint256 free = escrow.bondFree(sA);
        vm.warp(sb); vm.expectRevert(abi.encodeWithSelector(OrderEscrow.TooEarly.selector, sb)); escrow.refundUnshipped(id);
        vm.warp(sb + 1); vm.expectEmit(true, true, false, true); emit OrderEscrow.Refunded(id, buyer, FUND, BOND_N, 0, OrderEscrow.Why.UNSHIPPED);
        vm.prank(stranger); escrow.refundUnshipped(id);
        assertEq(_bal(buyer) - b, FUND + BOND_N); assertEq(escrow.bondFree(sA), free); assertEq(_bal(stranger), 0); _inv();
        vm.expectRevert(abi.encodeWithSelector(OrderEscrow.BadStatus.selector, OrderEscrow.Status.REFUNDED, OrderEscrow.Status.MATCHED)); escrow.refundUnshipped(id);
    }
    function testShipAfterShipByIsRefusedSoTheSellerCannotRaceTheRefund() public {
        (uint256 id,) = _matched(); uint256 sb = _o(id).shipBy; vm.warp(sb + 1); vm.prank(sA); vm.expectRevert(abi.encodeWithSelector(OrderEscrow.Expired.selector, sb)); escrow.ship(id, SHIPMENT);
    }
    function testRefundUnacceptedBuyerAnytimeStrangerOnlyAfterAcceptBy() public {
        (uint256 id, uint256 e) = _offered(); uint256 ab = _o(id).acceptBy; uint256 b = _bal(buyer); _bond(sA, 5_000_000);
        vm.prank(stranger); vm.expectRevert(OrderEscrow.Unauthorized.selector); escrow.refundUnaccepted(id);
        vm.warp(ab); vm.prank(stranger); vm.expectRevert(OrderEscrow.Unauthorized.selector); escrow.refundUnaccepted(id);
        vm.warp(ab + 1); vm.expectEmit(true, true, false, true); emit OrderEscrow.Refunded(id, buyer, FUND, 0, 0, OrderEscrow.Why.UNACCEPTED);
        vm.prank(stranger); escrow.refundUnaccepted(id);
        assertEq(_bal(buyer) - b, FUND); assertEq(escrow.bondFree(sA), 5_000_000, 'bond never touched'); assertEq(escrow.consumedAt(e, askIdx[e][sA]), 0); _inv();
        (uint256 id2,) = _offered(); vm.prank(buyer); escrow.refundUnaccepted(id2); _inv();                              // buyer, immediately
    }
    function testAcceptedOrdersCannotBeRefundedUnaccepted() public {
        (uint256 id,) = _matched(); vm.warp(block.timestamp + 5 days);
        vm.prank(buyer); vm.expectRevert(abi.encodeWithSelector(OrderEscrow.BadStatus.selector, OrderEscrow.Status.MATCHED, OrderEscrow.Status.OFFERED)); escrow.refundUnaccepted(id);
    }
    function _bs(OrderEscrow.Status have, OrderEscrow.Status need) internal pure returns (bytes memory) { return abi.encodeWithSelector(OrderEscrow.BadStatus.selector, have, need); }
    function testEveryTransitionOutOfALiveStateHappensOnce() public {
        (uint256 id,) = _delivered(); vm.prank(buyer); escrow.release(id); OrderEscrow.Status R = OrderEscrow.Status.RELEASED;
        vm.prank(buyer); vm.expectRevert(_bs(R, OrderEscrow.Status.DELIVERED)); escrow.dispute(id);
        vm.prank(buyer); vm.expectRevert(_bs(R, OrderEscrow.Status.DELIVERED)); escrow.release(id);
        vm.prank(verifier); vm.expectRevert(_bs(R, OrderEscrow.Status.SHIPPED)); escrow.attest(id, SKU, true, RECEIPT);
        vm.prank(verifier); vm.expectRevert(_bs(R, OrderEscrow.Status.DISPUTED)); escrow.resolve(id, false);
        vm.prank(sA); vm.expectRevert(_bs(R, OrderEscrow.Status.MATCHED)); escrow.ship(id, SHIPMENT);
        vm.prank(sA); vm.expectRevert(_bs(R, OrderEscrow.Status.OFFERED)); escrow.accept(id);
        vm.prank(sA); vm.expectRevert(_bs(R, OrderEscrow.Status.OFFERED)); escrow.decline(id);
        vm.prank(buyer); vm.expectRevert(_bs(R, OrderEscrow.Status.FUNDED)); escrow.matchOrder(id, 1, 0);
        vm.expectRevert(_bs(R, OrderEscrow.Status.MATCHED)); escrow.refundUnshipped(id);
        vm.expectRevert(_bs(R, OrderEscrow.Status.SHIPPED)); escrow.refundUnverified(id);
        vm.expectRevert(_bs(R, OrderEscrow.Status.DISPUTED)); escrow.releaseUnresolved(id);
        vm.expectRevert(_bs(R, OrderEscrow.Status.OFFERED)); escrow.refundUnaccepted(id);
        vm.expectRevert(_bs(R, OrderEscrow.Status.FUNDED)); escrow.cancel(id);
        vm.expectRevert(_bs(R, OrderEscrow.Status.OFFERED)); escrow.bondNeeded(id); _inv();
    }
    function testBondNeededIsOnlyDefinedWhileOffered() public {
        uint256 id = _mk(buyer, 2, 120); OrderEscrow.Status F = OrderEscrow.Status.FUNDED;
        vm.expectRevert(_bs(F, OrderEscrow.Status.OFFERED)); escrow.bondNeeded(id);
        uint256 e = _std(); vm.prank(buyer); escrow.matchOrder(id, e, askIdx[e][sA]); assertEq(escrow.bondNeeded(id), BOND_N);
        _bond(sA, 10_000_000); vm.prank(sA); escrow.accept(id);
        vm.expectRevert(_bs(OrderEscrow.Status.MATCHED, OrderEscrow.Status.OFFERED)); escrow.bondNeeded(id);
        assertEq(_o(id).bondLocked, BOND_N);
    }

    // ================= decline
    function testDeclineBySellerRefundsFreesUnitsAndLeavesTheBondAlone() public {
        _bond(sA, 5_000_000); uint256 b0 = _bal(buyer);
        (uint256 id, uint256 e) = _offered(); uint256 ix = askIdx[e][sA]; assertEq(escrow.consumedAt(e, ix), 2);
        vm.expectEmit(true, true, true, true); emit OrderEscrow.Refunded(id, buyer, FUND, 0, 0, OrderEscrow.Why.DECLINED);
        vm.prank(sA); escrow.decline(id);
        assertEq(_bal(buyer), b0, 'buyer made whole'); assertEq(escrow.consumedAt(e, ix), 0); assertEq(escrow.bondFree(sA), 5_000_000, 'bond untouched'); assertEq(_bal(address(escrow)), 5_000_000);
        assertEq(uint256(_o(id).status), uint256(OrderEscrow.Status.REFUNDED)); assertEq(_o(id).bondLocked, 0); _inv();
    }
    function testDeclineOnlyByTheRecordedSeller() public {
        (uint256 id,) = _offered();
        vm.prank(buyer); vm.expectRevert(OrderEscrow.Unauthorized.selector); escrow.decline(id);
        vm.prank(stranger); vm.expectRevert(OrderEscrow.Unauthorized.selector); escrow.decline(id);
        vm.prank(sB); vm.expectRevert(OrderEscrow.Unauthorized.selector); escrow.decline(id);
        vm.prank(verifier); vm.expectRevert(OrderEscrow.Unauthorized.selector); escrow.decline(id);
        assertEq(uint256(_o(id).status), uint256(OrderEscrow.Status.OFFERED)); _inv();
    }
    function testDeclineOnlyWhileOffered() public {
        uint256 id = _mk(buyer, 2, 120); vm.prank(sA); vm.expectRevert(_bs(OrderEscrow.Status.FUNDED, OrderEscrow.Status.OFFERED)); escrow.decline(id);
        uint256 e = _std(); vm.prank(buyer); escrow.matchOrder(id, e, askIdx[e][sA]); _bond(sA, 10_000_000); vm.prank(sA); escrow.accept(id);
        vm.prank(sA); vm.expectRevert(_bs(OrderEscrow.Status.MATCHED, OrderEscrow.Status.OFFERED)); escrow.decline(id);
        (uint256 id2,) = _offered(); vm.prank(sA); escrow.decline(id2);
        vm.prank(sA); vm.expectRevert(_bs(OrderEscrow.Status.REFUNDED, OrderEscrow.Status.OFFERED)); escrow.decline(id2); _inv();
    }
    function testDeclineStillWorksAfterAcceptByAndFreesTheFillForAnotherOrder() public {
        uint256 o1 = _mk(buyer, 2, 120); uint256 o2 = _mk(mallory, 2, 120); uint256 e = _fill3(); uint256 ix = askIdx[e][sA];
        vm.prank(buyer); escrow.matchOrder(o1, e, ix);
        vm.prank(mallory); vm.expectRevert(abi.encodeWithSelector(OrderEscrow.FillExhausted.selector, 3, 2, 2)); escrow.matchOrder(o2, e, ix);
        vm.warp(_o(o1).acceptBy + 1); vm.prank(sA); escrow.decline(o1); assertEq(escrow.consumedAt(e, ix), 0);
        vm.prank(mallory); escrow.matchOrder(o2, e, ix); assertEq(escrow.consumedAt(e, ix), 2); assertEq(_o(o2).seller, sA); _inv();
    }
    function testGriefScenarioTheSellerCanDeclineTheOfferAndFreeTheFill() public {
        // a griefing buyer (mallory) re-matches the whole fill so an honest buyer cannot use it; the seller can undo each offer with decline
        uint256 g = _mk(mallory, 3, 120); uint256 h = _mk(buyer, 3, 120); uint256 e = _fill3(); uint256 ix = askIdx[e][sA];
        vm.prank(mallory); escrow.matchOrder(g, e, ix);
        vm.prank(buyer); vm.expectRevert(abi.encodeWithSelector(OrderEscrow.FillExhausted.selector, 3, 3, 3)); escrow.matchOrder(h, e, ix);
        vm.prank(sA); escrow.decline(g); assertEq(escrow.consumedAt(e, ix), 0);
        vm.prank(buyer); escrow.matchOrder(h, e, ix); assertEq(_o(h).seller, sA); _inv();
    }

    // ================= every event, every reason
    function testEventsCarryTheirFieldsAlongTheHappyPath() public {
        uint256 mb = block.timestamp + 1 days;
        vm.expectEmit(true, true, true, true); emit OrderEscrow.OrderCreated(1, buyer, 2, 120, SHIPTO, mb, FUND);
        vm.prank(buyer); escrow.createOrder(2, 120, SHIPTO, mb);
        uint256 e = _std(); uint256 ix = askIdx[e][sA];
        vm.expectEmit(true, true, true, true); emit OrderEscrow.Offered(1, sA, e, ix, 105, block.timestamp + ACCEPT);
        vm.prank(buyer); escrow.matchOrder(1, e, ix);
        vm.expectEmit(true, true, true, true); emit OrderEscrow.BondDeposited(sA, 10_000_000, 10_000_000); _bond(sA, 10_000_000);
        vm.expectEmit(true, true, true, true); emit OrderEscrow.Accepted(1, sA, BOND_N, block.timestamp + SHIP);
        vm.prank(sA); escrow.accept(1);
        vm.expectEmit(true, true, true, true); emit OrderEscrow.Shipped(1, sA, SHIPMENT, block.timestamp + VERIFY);
        vm.prank(sA); escrow.ship(1, SHIPMENT);
        vm.expectEmit(true, true, true, true); emit OrderEscrow.Attested(1, true, SKU, RECEIPT, block.timestamp + DISPUTE);
        vm.prank(verifier); escrow.attest(1, SKU, true, RECEIPT);
        vm.expectEmit(true, true, true, true); emit OrderEscrow.Released(1, sA, PAY, FUND - PAY, BOND_N, OrderEscrow.ReleaseWhy.BUYER, buyer);
        vm.prank(buyer); escrow.release(1);
        vm.expectEmit(true, true, true, true); emit OrderEscrow.BondWithdrawn(sA, 1_000_000, 9_000_000);
        vm.prank(sA); escrow.withdrawBond(1_000_000); _inv();
    }
    function testDisputedAndCancelledEventsAndTheAttestedRejectBranches() public {
        (uint256 id,) = _delivered();
        vm.expectEmit(true, true, true, true); emit OrderEscrow.Disputed(id, buyer, block.timestamp + RESOLVE);
        vm.prank(buyer); escrow.dispute(id);
        uint256 c = _mk(buyer, 2, 120); vm.warp(_o(c).matchBy + 1);
        vm.expectEmit(true, true, true, true); emit OrderEscrow.Cancelled(c, buyer, FUND, stranger);
        vm.prank(stranger); escrow.cancel(c);
        (uint256 a,) = _shipped();
        vm.expectEmit(true, true, true, true); emit OrderEscrow.Attested(a, false, SKU, RECEIPT, 0);
        vm.expectEmit(true, true, true, true); emit OrderEscrow.Refunded(a, buyer, FUND, BOND_N, 0, OrderEscrow.Why.REJECTED);
        vm.prank(verifier); escrow.attest(a, SKU, false, RECEIPT);
        (uint256 b,) = _shipped(); bytes32 other = keccak256('another sku');
        vm.expectEmit(true, true, true, true); emit OrderEscrow.Attested(b, false, other, RECEIPT, 0);
        vm.expectEmit(true, true, true, true); emit OrderEscrow.Refunded(b, buyer, FUND, BOND_N, 0, OrderEscrow.Why.REJECTED);
        vm.prank(verifier); escrow.attest(b, other, true, RECEIPT); _inv();
    }
    function testReleasedReasonBuyerTimeoutVerifierRuledUnresolved() public {
        (uint256 a,) = _delivered();
        vm.expectEmit(true, true, true, true); emit OrderEscrow.Released(a, sA, PAY, FUND - PAY, BOND_N, OrderEscrow.ReleaseWhy.BUYER, buyer);
        vm.prank(buyer); escrow.release(a);
        (uint256 b,) = _delivered(); vm.warp(_o(b).releaseAfter);
        vm.expectEmit(true, true, true, true); emit OrderEscrow.Released(b, sA, PAY, FUND - PAY, BOND_N, OrderEscrow.ReleaseWhy.TIMEOUT, stranger);
        vm.prank(stranger); escrow.release(b);
        (uint256 c,) = _delivered(); vm.prank(buyer); escrow.dispute(c);
        vm.expectEmit(true, true, true, true); emit OrderEscrow.Released(c, sA, PAY, FUND - PAY, BOND_N, OrderEscrow.ReleaseWhy.VERIFIER_RULED, verifier);
        vm.prank(verifier); escrow.resolve(c, true);
        (uint256 d,) = _delivered(); vm.prank(buyer); escrow.dispute(d); vm.warp(_o(d).resolveBy + 1);
        vm.expectEmit(true, true, true, true); emit OrderEscrow.Released(d, sA, PAY, FUND - PAY, BOND_N, OrderEscrow.ReleaseWhy.UNRESOLVED, stranger);
        vm.prank(stranger); escrow.releaseUnresolved(d); _inv();
    }
    function testRefundedReasonsUnverifiedAndVerifierRuled() public {
        (uint256 a,) = _shipped(); vm.warp(_o(a).verifyBy + 1);
        vm.expectEmit(true, true, true, true); emit OrderEscrow.Refunded(a, buyer, FUND, 0, BOND_N, OrderEscrow.Why.UNVERIFIED);
        vm.prank(stranger); escrow.refundUnverified(a);
        (uint256 b,) = _delivered(); vm.prank(buyer); escrow.dispute(b);
        vm.expectEmit(true, true, true, true); emit OrderEscrow.Refunded(b, buyer, FUND, BOND_N, 0, OrderEscrow.Why.VERIFIER_RULED);
        vm.prank(verifier); escrow.resolve(b, false);
        assertEq(uint256(OrderEscrow.Why.DECLINED), 5); _inv();
    }

    // ================= constructor: token must be the book's token
    function testConstructorRejectsATokenThatIsNotTheBooksToken() public {
        FeeToken other = new FeeToken();
        vm.expectRevert(abi.encodeWithSelector(OrderEscrow.WrongToken.selector, address(usdc), address(other)));
        new OrderEscrow(address(other), address(book), M, SKU, verifier, BPS, ACCEPT, SHIP, VERIFY, DISPUTE, RESOLVE);
    }

    // ================= a token that returns false instead of reverting
    function testATokenReturningFalseMakesPullAndPushRevert() public {
        FalseToken ft = new FalseToken(); _useToken(ITok(address(ft)));
        ft.setFailing(true);
        vm.prank(buyer); vm.expectRevert(OrderEscrow.TransferFailed.selector); escrow.createOrder(2, 120, SHIPTO, block.timestamp + 1 days);
        vm.prank(sA); vm.expectRevert(OrderEscrow.TransferFailed.selector); escrow.depositBond(1_000_000);
        ft.setFailing(false); uint256 id = _mk(buyer, 2, 120); _bond(sA, 1_000_000); ft.setFailing(true);
        vm.prank(buyer); vm.expectRevert(OrderEscrow.TransferFailed.selector); escrow.cancel(id);
        vm.prank(sA); vm.expectRevert(OrderEscrow.TransferFailed.selector); escrow.withdrawBond(1);
        assertEq(uint256(_o(id).status), uint256(OrderEscrow.Status.FUNDED)); assertEq(escrow.bondFree(sA), 1_000_000);
        ft.setFailing(false); vm.prank(buyer); escrow.cancel(id); _inv();
    }

    // ================= fee-on-transfer token
    function testFeeOnTransferTokenIsRefused() public {
        FeeToken ft = new FeeToken(); _useToken(ITok(address(ft)));
        uint256 funded = 120 * 2 * CENT;
        vm.prank(buyer); vm.expectRevert(abi.encodeWithSelector(OrderEscrow.TokenMismatch.selector, funded, funded - funded / 100)); escrow.createOrder(2, 120, SHIPTO, block.timestamp + 1 days);
        vm.prank(sA); vm.expectRevert(abi.encodeWithSelector(OrderEscrow.TokenMismatch.selector, 1_000_000, 990_000)); escrow.depositBond(1_000_000);
        assertEq(escrow.nextId(), 0); assertEq(ft.balanceOf(address(escrow)), 0);
    }

    // ================= reentrancy: the guard stops a callback token
    function _attackable() internal returns (ReentrantToken rt) { rt = new ReentrantToken(); _useToken(ITok(address(rt))); rt.mint(address(rt), 100_000_000); }
    function _reentryCall() internal view returns (bytes memory) { return abi.encodeCall(OrderEscrow.createOrder, (1, 1, bytes32(0), block.timestamp + 1 days)); }
    function testReentrantTokenCannotReenterDuringAPayout() public {
        ReentrantToken rt = _attackable(); (uint256 id,) = _delivered(); uint256 n = escrow.nextId();
        rt.arm(address(escrow), _reentryCall(), true, false);
        vm.prank(buyer); escrow.release(id);
        assertEq(rt.attempts(), 1); assertFalse(rt.lastOk(), 'the nested createOrder must fail'); assertEq(bytes4(rt.lastRet()), OrderEscrow.Reentrancy.selector);
        assertEq(escrow.nextId(), n); assertEq(rt.balanceOf(address(rt)), 100_000_000); assertEq(uint256(_o(id).status), uint256(OrderEscrow.Status.RELEASED)); _inv();
    }
    function testReentrantTokenCannotDoublePayByReenteringRelease() public {
        ReentrantToken rt = _attackable(); (uint256 id,) = _delivered(); uint256 s = _bal(sA);
        vm.warp(_o(id).releaseAfter);
        rt.arm(address(escrow), abi.encodeCall(OrderEscrow.release, (id)), true, false);
        vm.prank(stranger); escrow.release(id);
        assertEq(rt.attempts(), 1); assertFalse(rt.lastOk()); assertEq(bytes4(rt.lastRet()), OrderEscrow.Reentrancy.selector);
        assertEq(_bal(sA) - s, PAY, 'paid exactly once'); assertEq(escrow.bondFree(sA), 10_000_000); _inv();
    }
    function testReentrantTokenCannotReenterDuringAPull() public {
        ReentrantToken rt = _attackable(); rt.arm(address(escrow), _reentryCall(), false, true);
        vm.prank(buyer); uint256 id = escrow.createOrder(2, 120, SHIPTO, block.timestamp + 1 days);
        assertEq(rt.attempts(), 1); assertFalse(rt.lastOk()); assertEq(bytes4(rt.lastRet()), OrderEscrow.Reentrancy.selector); assertEq(id, 1); assertEq(escrow.nextId(), 1); _inv();
    }
    function testReentrantTokenCannotReenterDuringARefundOrWithdraw() public {
        ReentrantToken rt = _attackable(); _bond(sA, 1_000_000);
        rt.arm(address(escrow), _reentryCall(), true, false); vm.prank(sA); escrow.withdrawBond(400_000);
        assertEq(rt.attempts(), 1); assertFalse(rt.lastOk()); assertEq(bytes4(rt.lastRet()), OrderEscrow.Reentrancy.selector);
        uint256 id = _mk(buyer, 2, 120); rt.arm(address(escrow), _reentryCall(), true, false); vm.prank(buyer); escrow.cancel(id);
        assertEq(rt.attempts(), 2); assertFalse(rt.lastOk()); assertEq(escrow.nextId(), 1); _inv();
    }

    // ================= events and views
    function testViewsExposeTheOrder() public {
        (uint256 id, uint256 e) = _matched(); OrderEscrow.Order memory o = _o(id);
        assertEq(o.buyer, buyer); assertEq(o.seller, sA); assertEq(o.shipToHash, SHIPTO); assertEq(uint256(o.qty), 2); assertEq(uint256(o.priceCents), 105); assertEq(uint256(o.maxPriceCents), 120);
        assertEq(o.funded, FUND); assertEq(uint256(o.matchEpoch), e); assertEq(uint256(o.matchIndex), askIdx[e][sA]); assertEq(escrow.nextId(), 1);
    }
}

// ============================================================ stateful: random walks over every path
contract EscrowHandler is EscrowBase {
    uint256[] epochs; uint256 nonce; uint256[10] public reached;
    function init() external { strictSteps = true; _bond(sA, 50_000_000); _bond(sB, 50_000_000); }
    function check() external view { _checkStatic(); }
    function addrs() external view returns (address, address, address) { return (address(book), address(escrow), address(usdc)); }
    function violationCount() external view returns (uint256) { return violations; }
    function _id(uint256 x) internal view returns (uint256) { uint256 n = escrow.nextId(); return n == 0 ? 0 : 1 + x % n; }
    function _who(uint256 x) internal view returns (address) { address[4] memory w = [buyer, sA, sB, mallory]; return w[x % 4]; }
    function _after() internal { _track(); uint256 n = escrow.nextId(); for (uint256 i = 1; i <= n; i++) { uint256 s = uint256(_o(i).status); reached[s]++; } }
    /// The legitimate next step of whatever state the order is in (x picks the branch), so the walk reaches deep states.
    function _advance(uint256 id, uint256 x, OrderEscrow.Order memory o) internal {
        OrderEscrow.Status st = o.status;
        if (st == OrderEscrow.Status.FUNDED) { if (epochs.length > 0) { uint256 e = epochs[(x / 7) % epochs.length]; address s = (x / 3) % 2 == 0 ? sA : sB; vm.prank(o.buyer); try escrow.matchOrder(id, e, askIdx[e][s]) {} catch {} } }
        else if (st == OrderEscrow.Status.OFFERED) { vm.prank(o.seller); try escrow.accept(id) {} catch {} }
        else if (st == OrderEscrow.Status.MATCHED) { vm.prank(o.seller); try escrow.ship(id, SHIPMENT) {} catch {} }
        else if (st == OrderEscrow.Status.SHIPPED) { vm.prank(verifier); try escrow.attest(id, x % 6 == 0 ? keccak256('other') : SKU, x % 5 != 0, RECEIPT) {} catch {} }
        else if (st == OrderEscrow.Status.DELIVERED) { vm.prank(o.buyer); if (x % 3 == 0) { try escrow.dispute(id) {} catch {} } else { try escrow.release(id) {} catch {} } }
        else if (st == OrderEscrow.Status.DISPUTED) { vm.prank(verifier); try escrow.resolve(id, x % 2 == 0) {} catch {} }
    }
    function act(uint256 kind, uint256 x) external {
        kind = kind % 18; uint256 id = _id(x); OrderEscrow.Order memory o = id == 0 ? _o(0) : _o(id);
        if (kind == 0) { address w = x % 3 == 0 ? mallory : buyer; vm.prank(w); try escrow.createOrder(1 + x % 3, 100 + x % 31, SHIPTO, block.timestamp + 1 days) {} catch {} }
        else if (kind == 1) { if (epochs.length < 8) { epochs.push(_epoch(10, 120, _asks2(sA, 5, 80, sB, 5, 90))); } }
        else if (kind == 2 && id != 0 && epochs.length > 0) { uint256 e = epochs[(x / 7) % epochs.length]; address s = (x / 3) % 2 == 0 ? sA : sB; vm.prank(o.buyer); try escrow.matchOrder(id, e, askIdx[e][s]) {} catch {} }
        else if (kind == 3) { address s = x % 2 == 0 ? sA : sB; vm.prank(s); try escrow.depositBond(x % 3_000_000) {} catch {} }
        else if (kind == 4 && id != 0) { vm.prank(x % 5 == 0 ? stranger : o.seller); try escrow.accept(id) {} catch {} }
        else if (kind == 5 && id != 0) { vm.prank(o.seller); try escrow.ship(id, x % 11 == 0 ? bytes32(0) : SHIPMENT) {} catch {} }
        else if (kind == 6 && id != 0) { vm.prank(x % 9 == 0 ? stranger : verifier); try escrow.attest(id, x % 5 == 0 ? keccak256('other') : SKU, x % 4 != 0, RECEIPT) {} catch {} }
        else if (kind == 7 && id != 0) { vm.prank(x % 3 == 0 ? stranger : o.buyer); try escrow.release(id) {} catch {} }
        else if (kind == 8 && id != 0) { vm.prank(o.buyer); try escrow.dispute(id) {} catch {} }
        else if (kind == 9 && id != 0) { vm.prank(verifier); try escrow.resolve(id, x % 2 == 0) {} catch {} }
        else if (kind == 10 && id != 0) {
            vm.prank(_who(x));
            uint256 k = (x / 5) % 5;
            if (k == 0) { try escrow.cancel(id) {} catch {} } else if (k == 1) { try escrow.refundUnaccepted(id) {} catch {} } else if (k == 2) { try escrow.refundUnshipped(id) {} catch {} }
            else if (k == 3) { try escrow.refundUnverified(id) {} catch {} } else { try escrow.releaseUnresolved(id) {} catch {} }
        }
        else if (kind == 11) { vm.warp(block.timestamp + 1 + x % 400); }
        else if (kind == 12) { if (x % 3 == 0) vm.warp(block.timestamp + 300 + x % 2000); }
        else if (kind == 13) { address s = x % 2 == 0 ? sA : sB; vm.prank(s); try escrow.withdrawBond(x % 2_000_000) {} catch {} }
        else if (kind == 14 && id != 0) { if (x % 2 == 0) { vm.prank(o.buyer); try escrow.refundUnaccepted(id) {} catch {} } else { vm.prank(o.seller); try escrow.decline(id) {} catch {} } }
        else if (kind >= 15 && id != 0) _advance(id, x, o);
        nonce++; _after();
    }
}
contract OrderEscrowInvariantTest is Test {
    EscrowHandler h;
    function setUp() public {
        h = new EscrowHandler(); h.setUp(); h.init(); h.act(0, 1); h.act(0, 2); h.act(1, 3);
        bytes4[] memory sel = new bytes4[](1); sel[0] = EscrowHandler.act.selector; targetSelector(FuzzSelector({addr: address(h), selectors: sel}));
        (address a1, address a2, address a3) = h.addrs(); excludeContract(a1); excludeContract(a2); excludeContract(a3);
    }
    function invariant_1_tokenBalanceEqualsTheLedger() public view { h.check(); }
    function invariant_2_statusesOnlyMoveForward() public view { assertEq(h.violationCount(), 0); }
}
contract OrderEscrowFuzzTest is Test {
    /// A deterministic-seed random walk of 90 steps; the invariants are checked after every step, and the walk must reach deep states.
    function testFuzzRandomWalkKeepsEveryInvariant(uint256 seed) public {
        EscrowHandler h = new EscrowHandler(); h.setUp(); h.init();
        // seed the walk so that orders exist before the first epoch, then let the seed drive everything else
        h.act(0, seed); h.act(0, seed >> 3); h.act(1, 0);
        for (uint256 i = 0; i < 90; i++) {
            uint256 r = uint256(keccak256(abi.encode(seed, i))); h.act(r % 18, r >> 8); h.check();
        }
        assertEq(h.violationCount(), 0);
    }
    function testWalkReachesEveryState() public {
        uint256[10] memory seen;
        for (uint256 s = 1; s <= 12; s++) {
            EscrowHandler h = new EscrowHandler(); h.setUp(); h.init(); h.act(0, s); h.act(0, s * 3); h.act(1, s);
            for (uint256 i = 0; i < 60; i++) { uint256 r = uint256(keccak256(abi.encode(s, i))); h.act(r % 18, r >> 8); }
            h.check(); for (uint256 k = 0; k < 10; k++) seen[k] += h.reached(k);
        }
        string[10] memory names = ['NONE', 'FUNDED', 'OFFERED', 'MATCHED', 'SHIPPED', 'DELIVERED', 'RELEASED', 'CANCELLED', 'REFUNDED', 'DISPUTED'];
        for (uint256 k = 1; k < 10; k++) emit log_named_uint(string.concat('step visits ', names[k]), seen[k]);
        for (uint256 k = 2; k < 10; k++) assertGt(seen[k], 0, 'every state is reached by the walk');
    }
}
