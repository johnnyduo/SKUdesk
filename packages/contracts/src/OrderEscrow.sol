// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {IERC20Min} from './IERC20Min.sol';

/// Read-only view of the deployed BlindBook (public getters; mapping getters return struct members as tuples).
interface IBlindBookView {
    function markets(bytes32 id) external view returns (bool listed, uint256 tick);
    function cleared(bytes32 market, uint256 epoch) external view returns (bool);
    function results(bytes32 market, uint256 epoch) external view returns (uint256 price, uint256 volume);
    function orderCount(bytes32 market, uint256 epoch) external view returns (uint256);
    function getOrder(bytes32 market, uint256 epoch, uint256 index) external view returns (address trader, bool revealed, uint8 side, uint256 price, uint256 units, uint256 filled, bytes32 hash);
    function epochStart(uint256 epoch) external view returns (uint256);
    function CENT() external view returns (uint256);
    function token() external view returns (address);
}

/// @title OrderEscrow - one SKU, buyer to seller, funds locked on-chain, with a NAMED delivery verifier.
/// @notice A buyer locks `maxPriceCents * qty * CENT` of the payment token. Using a cleared BlindBook round as price evidence the
/// buyer picks one seller; the seller accepts by locking a bond, ships, and the verifier attests delivery. Funds are then released
/// to the seller (price actually cleared, the difference refunded to the buyer) or refunded to the buyer by explicit rules and timeouts.
/// @dev Concept and its limit: "A cleared BlindBook sell fill is used only as evidence that this seller offered at or below price P
/// in a round that began at or after the buyer funded. It is not an allocation of goods: those units were already sold to the BlindBook
/// buyer and are not redeemable. The units are operator-issued, so the operator controls who can become a seller, and a seller may
/// also be a bidder in that round, so P is not an independent market price. The buyer chooses the round; the buyer's own cap
/// (`maxPriceCents`) is the real price guard. The `consumed` counter only stops one fill from backing two escrow orders; consumed is counted within this escrow contract only. The
/// seller's acceptance, the bond and the named verifier are the only guards on delivery."
/// Trust assumptions, all deliberate: (1) the verifier, fixed at deployment, alone decides whether goods arrived; a verifier that
/// goes silent after DELIVERED favours the seller (`releaseUnresolved`), and one that goes silent after SHIPPED costs the seller the
/// goods (`refundUnverified` returns only the bond). (2) The shipment hash is AGENT ATTESTED and proves nothing about the goods.
/// (3) The ship-to hash is computed off-chain; the salt and address reach the seller off-chain. (4) Payment token is the mock
/// stablecoin only: fee-on-transfer tokens are rejected by a balance-delta check, tokens with callbacks or blocklists are unsupported
/// (payouts are direct transfers; every state-changing function is nonReentrant and follows checks-effects-interactions).
/// Permissionless exits pay only the entitled buyer or seller, never the caller. The verifier address never receives funds directly. A verifier
/// acting through another address (as buyer or seller) can direct any outcome, including a seller's bond, to itself: the verifier is a trusted party.
/// `getOrder(id)` keeps `funded` and `bondLocked` set after an order ends: always read them together with `status`.
/// `matchOrder` is the spec's `match` (a reserved word in Solidity).
contract OrderEscrow {
    uint256 public constant MAX_QTY = 1000;
    uint256 public constant MAX_CAP_CENTS = 1_000_000;
    uint256 public constant MAX_SPAN = 30 days;      // longest matchBy horizon and longest configurable window
    uint256 public constant MIN_WINDOW = 60;

    IERC20Min public immutable token; IBlindBookView public immutable book; uint256 public immutable CENT;
    bytes32 public immutable MARKET; bytes32 public immutable SKU; address public immutable verifier;
    uint256 public immutable bondBps;
    uint256 public immutable acceptWindow; uint256 public immutable shipWindow; uint256 public immutable verifyWindow; uint256 public immutable disputeWindow; uint256 public immutable resolveWindow;

    /// Numeric values: NONE 0, FUNDED 1, OFFERED 2, MATCHED 3, SHIPPED 4, DELIVERED 5, RELEASED 6, CANCELLED 7, REFUNDED 8, DISPUTED 9. Terminal: RELEASED, CANCELLED, REFUNDED.
    enum Status { NONE, FUNDED, OFFERED, MATCHED, SHIPPED, DELIVERED, RELEASED, CANCELLED, REFUNDED, DISPUTED }
    /// Why an order was REFUNDED. UNACCEPTED: buyer (or a stranger after acceptBy) withdrew an unaccepted offer. REJECTED: attest ok=false or wrong SKU, bond to buyer.
    /// VERIFIER_RULED: resolve(false), bond to buyer. UNSHIPPED: shipBy passed, bond to buyer. UNVERIFIED: verifyBy passed, bond back to seller. DECLINED: the seller declined the offer.
    enum Why { UNACCEPTED, REJECTED, VERIFIER_RULED, UNSHIPPED, UNVERIFIED, DECLINED }
    /// Who or what triggered a release. BUYER: buyer called release. TIMEOUT: a stranger released after releaseAfter. VERIFIER_RULED: resolve(true). UNRESOLVED: releaseUnresolved.
    enum ReleaseWhy { BUYER, TIMEOUT, VERIFIER_RULED, UNRESOLVED }
    struct Order {
        address buyer; address seller; Status status;
        bytes32 shipToHash;                      // keccak256(salt, address) computed OFF-chain; the salt and address reach the seller off-chain, which is not trustless
        uint32 qty; uint32 priceCents; uint32 maxPriceCents;
        uint64 createdAt; uint64 matchBy; uint64 acceptBy; uint64 shipBy; uint64 verifyBy; uint64 releaseAfter; uint64 resolveBy;
        uint256 funded; uint256 bondLocked;
        bytes32 shipmentHash; bytes32 receiptHash; uint64 matchEpoch; uint32 matchIndex;
    }
    mapping(uint256 => Order) internal orders; uint256 public nextId;
    mapping(address => uint256) public bondFree;
    mapping(bytes32 => uint256) public consumed;      // keccak256(abi.encode(MARKET, epoch, index)) => units reserved
    uint256 private _lock = 1;

    event BondDeposited(address indexed seller, uint256 amount, uint256 bondFree); event BondWithdrawn(address indexed seller, uint256 amount, uint256 bondFree);
    event OrderCreated(uint256 indexed id, address indexed buyer, uint256 qty, uint256 maxPriceCents, bytes32 shipToHash, uint256 matchBy, uint256 funded);
    event Cancelled(uint256 indexed id, address indexed buyer, uint256 refund, address caller);
    event Offered(uint256 indexed id, address indexed seller, uint256 epoch, uint256 index, uint256 priceCents, uint256 acceptBy);
    event Accepted(uint256 indexed id, address indexed seller, uint256 bond, uint256 shipBy);
    event Shipped(uint256 indexed id, address indexed seller, bytes32 shipmentHash, uint256 verifyBy);
    event Attested(uint256 indexed id, bool delivered, bytes32 receivedSku, bytes32 receiptHash, uint256 releaseAfter);
    event Disputed(uint256 indexed id, address indexed buyer, uint256 resolveBy);
    event Released(uint256 indexed id, address seller, uint256 paid, uint256 refundedToBuyer, uint256 bondReturned, ReleaseWhy why, address caller);
    event Refunded(uint256 indexed id, address indexed buyer, uint256 refund, uint256 bondToBuyer, uint256 bondToSeller, Why why);

    error Unauthorized(); error Reentrancy(); error TransferFailed(); error BadConfig();
    error BadStatus(Status have, Status needed); error Expired(uint256 deadline); error TokenMismatch(uint256 expected, uint256 got);
    error RoleConflict(); error BadQty(uint256 qty); error BadPrice(uint256 cents); error BadMatchBy(uint256 matchBy); error ZeroHash();
    error NoSuchOrder(uint256 epoch, uint256 index); error NotCleared(uint256 epoch); error StaleEpoch(uint256 epochStart, uint256 createdAt);
    error NotASell(); error FillExhausted(uint256 filled, uint256 consumed, uint256 qty); error PriceAboveCap(uint256 price, uint256 cap);
    error InsufficientBond(uint256 have, uint256 need); error WrongToken(address bookToken, address given); error TooEarly(uint256 deadline);

    modifier nonReentrant { if (_lock != 1) revert Reentrancy(); _lock = 2; _; _lock = 1; }

    constructor(address _token, address _book, bytes32 _market, bytes32 _sku, address _verifier, uint256 _bondBps, uint256 _accept, uint256 _ship, uint256 _verify, uint256 _dispute, uint256 _resolve) {
        if (_token == address(0) || _book == address(0) || _verifier == address(0) || _bondBps == 0 || _bondBps > 5000) revert BadConfig();
        uint256[5] memory w = [_accept, _ship, _verify, _dispute, _resolve];
        for (uint256 i; i < 5; ++i) if (w[i] < MIN_WINDOW || w[i] > MAX_SPAN) revert BadConfig();
        (bool listed,) = IBlindBookView(_book).markets(_market); if (!listed) revert BadConfig();
        address bt = IBlindBookView(_book).token(); if (bt != _token) revert WrongToken(bt, _token);
        token = IERC20Min(_token); book = IBlindBookView(_book); CENT = IBlindBookView(_book).CENT();
        MARKET = _market; SKU = _sku; verifier = _verifier; bondBps = _bondBps;
        acceptWindow = _accept; shipWindow = _ship; verifyWindow = _verify; disputeWindow = _dispute; resolveWindow = _resolve;
    }

    // ================= seller bond
    function depositBond(uint256 amount) external nonReentrant { bondFree[msg.sender] += amount; _pullExact(msg.sender, amount); emit BondDeposited(msg.sender, amount, bondFree[msg.sender]); }
    function withdrawBond(uint256 amount) external nonReentrant {
        uint256 have = bondFree[msg.sender]; if (have < amount) revert InsufficientBond(have, amount);
        bondFree[msg.sender] = have - amount; _push(msg.sender, amount); emit BondWithdrawn(msg.sender, amount, have - amount);
    }

    // ================= buyer
    function createOrder(uint256 qty, uint256 maxPriceCents, bytes32 shipToHash, uint256 matchBy) external nonReentrant returns (uint256 id) {
        if (msg.sender == verifier) revert RoleConflict();
        if (qty == 0 || qty > MAX_QTY) revert BadQty(qty);
        if (maxPriceCents == 0 || maxPriceCents > MAX_CAP_CENTS) revert BadPrice(maxPriceCents);
        if (matchBy <= block.timestamp || matchBy > block.timestamp + MAX_SPAN) revert BadMatchBy(matchBy);
        uint256 funded = maxPriceCents * qty * CENT;
        id = ++nextId; Order storage o = orders[id];
        o.buyer = msg.sender; o.status = Status.FUNDED; o.shipToHash = shipToHash; o.qty = uint32(qty); o.maxPriceCents = uint32(maxPriceCents);
        o.createdAt = uint64(block.timestamp); o.matchBy = uint64(matchBy); o.funded = funded;
        _pullExact(msg.sender, funded);
        emit OrderCreated(id, msg.sender, qty, maxPriceCents, shipToHash, matchBy, funded);
    }
    /// Buyer anytime while FUNDED; a stranger after `matchBy`. The refund always goes to the buyer.
    function cancel(uint256 id) external nonReentrant {
        Order storage o = _need(id, Status.FUNDED);
        if (msg.sender != o.buyer && block.timestamp <= o.matchBy) revert Unauthorized();
        o.status = Status.CANCELLED; _push(o.buyer, o.funded); emit Cancelled(id, o.buyer, o.funded, msg.sender);
    }
    /// Buyer picks a cleared BlindBook sell fill as evidence (see the contract header for what that does and does not prove).
    /// No bond is touched: the seller must still `accept`. The seller recorded here was already checked against buyer and verifier.
    function matchOrder(uint256 id, uint256 epoch, uint256 index) external nonReentrant {
        Order storage o = _need(id, Status.FUNDED);
        if (msg.sender != o.buyer) revert Unauthorized();
        if (block.timestamp > o.matchBy) revert Expired(o.matchBy);
        (address seller, uint256 price, bytes32 key) = _evidence(o, epoch, index);
        consumed[key] += o.qty;
        o.seller = seller; o.priceCents = uint32(price); o.matchEpoch = uint64(epoch); o.matchIndex = uint32(index);
        o.acceptBy = uint64(block.timestamp + acceptWindow); o.status = Status.OFFERED;
        emit Offered(id, seller, epoch, index, price, o.acceptBy);
    }
    /// A cancelled offer, not a seller fault: the buyer anytime, a stranger after `acceptBy`. The bond is never touched; the fill units are freed.
    function refundUnaccepted(uint256 id) external nonReentrant {
        Order storage o = _need(id, Status.OFFERED);
        if (msg.sender != o.buyer && block.timestamp <= o.acceptBy) revert Unauthorized();
        consumed[_key(o.matchEpoch, o.matchIndex)] -= o.qty;
        _refund(id, o, false, Why.UNACCEPTED);
    }
    function dispute(uint256 id) external nonReentrant {
        Order storage o = _need(id, Status.DELIVERED);
        if (msg.sender != o.buyer) revert Unauthorized();
        if (block.timestamp >= o.releaseAfter) revert Expired(o.releaseAfter);
        o.status = Status.DISPUTED; o.resolveBy = uint64(block.timestamp + resolveWindow); emit Disputed(id, o.buyer, o.resolveBy);
    }
    /// Buyer anytime; anyone once `releaseAfter` has passed. Pays only the seller and the buyer.
    function release(uint256 id) external nonReentrant {
        Order storage o = _need(id, Status.DELIVERED);
        if (msg.sender != o.buyer && block.timestamp < o.releaseAfter) revert Unauthorized();
        _release(id, o, msg.sender == o.buyer ? ReleaseWhy.BUYER : ReleaseWhy.TIMEOUT);
    }

    // ================= seller
    function accept(uint256 id) external nonReentrant {
        Order storage o = _need(id, Status.OFFERED);
        if (msg.sender != o.seller) revert Unauthorized();
        if (block.timestamp > o.acceptBy) revert Expired(o.acceptBy);
        uint256 need = bondNeeded(id); uint256 have = bondFree[msg.sender]; if (have < need) revert InsufficientBond(have, need);
        bondFree[msg.sender] = have - need; o.bondLocked = need; o.shipBy = uint64(block.timestamp + shipWindow); o.status = Status.MATCHED;
        emit Accepted(id, msg.sender, need, o.shipBy);
    }
    /// The recorded seller turns down an offer it does not want: the buyer is refunded in full, the fill units are freed, no bond is touched.
    function decline(uint256 id) external nonReentrant {
        Order storage o = _need(id, Status.OFFERED);
        if (msg.sender != o.seller) revert Unauthorized();
        consumed[_key(o.matchEpoch, o.matchIndex)] -= o.qty;
        _refund(id, o, false, Why.DECLINED);
    }
    /// AGENT ATTESTED: the hash proves nothing about the goods.
    function ship(uint256 id, bytes32 shipmentHash) external nonReentrant {
        Order storage o = _need(id, Status.MATCHED);
        if (msg.sender != o.seller) revert Unauthorized();
        if (block.timestamp > o.shipBy) revert Expired(o.shipBy);
        if (shipmentHash == bytes32(0)) revert ZeroHash();
        o.shipmentHash = shipmentHash; o.verifyBy = uint64(block.timestamp + verifyWindow); o.status = Status.SHIPPED;
        emit Shipped(id, msg.sender, shipmentHash, o.verifyBy);
    }

    // ================= verifier (a trusted, named address)
    function attest(uint256 id, bytes32 receivedSku, bool ok, bytes32 receiptHash) external nonReentrant {
        if (msg.sender != verifier) revert Unauthorized();
        Order storage o = _need(id, Status.SHIPPED);
        if (block.timestamp > o.verifyBy) revert Expired(o.verifyBy);
        o.receiptHash = receiptHash;
        if (ok && receivedSku == SKU) {
            o.status = Status.DELIVERED; o.releaseAfter = uint64(block.timestamp + disputeWindow);
            emit Attested(id, true, receivedSku, receiptHash, o.releaseAfter);
        } else {
            emit Attested(id, false, receivedSku, receiptHash, 0);
            _refund(id, o, true, Why.REJECTED);
        }
    }
    function resolve(uint256 id, bool sellerWins) external nonReentrant {
        if (msg.sender != verifier) revert Unauthorized();
        Order storage o = _need(id, Status.DISPUTED);
        if (block.timestamp > o.resolveBy) revert Expired(o.resolveBy);
        if (sellerWins) _release(id, o, ReleaseWhy.VERIFIER_RULED); else _refund(id, o, true, Why.VERIFIER_RULED);
    }

    // ================= timeout exits: anyone may call, each pays only the entitled buyer or seller
    function refundUnshipped(uint256 id) external nonReentrant {
        Order storage o = _need(id, Status.MATCHED);
        if (block.timestamp <= o.shipBy) revert TooEarly(o.shipBy);
        _refund(id, o, true, Why.UNSHIPPED);                    // `consumed` stays consumed
    }
    function refundUnverified(uint256 id) external nonReentrant {
        Order storage o = _need(id, Status.SHIPPED);
        if (block.timestamp <= o.verifyBy) revert TooEarly(o.verifyBy);
        _refund(id, o, false, Why.UNVERIFIED);                  // buyer made whole, seller gets only the bond back
    }
    /// Defaults to the last thing the verifier said on chain (delivered): pays the seller exactly as `release`.
    function releaseUnresolved(uint256 id) external nonReentrant {
        Order storage o = _need(id, Status.DISPUTED);
        if (block.timestamp <= o.resolveBy) revert TooEarly(o.resolveBy);
        _release(id, o, ReleaseWhy.UNRESOLVED);
    }

    // ================= views
    /// `funded` and `bondLocked` stay set after an order ends (RELEASED, CANCELLED, REFUNDED): read them together with `status`, never alone.
    function getOrder(uint256 id) external view returns (Order memory) { return orders[id]; }
    /// Bond the seller must hold free to `accept`. Only defined while the order is OFFERED (reverts otherwise).
    function bondNeeded(uint256 id) public view returns (uint256) { Order storage o = _need(id, Status.OFFERED); return (uint256(o.priceCents) * o.qty * CENT * bondBps + 9999) / 10_000; }
    function consumedAt(uint256 epoch, uint256 index) external view returns (uint256) { return consumed[_key(epoch, index)]; }

    // ================= internals
    function _need(uint256 id, Status s) internal view returns (Order storage o) { o = orders[id]; if (o.status != s) revert BadStatus(o.status, s); }
    function _key(uint256 epoch, uint256 index) internal view returns (bytes32) { return keccak256(abi.encode(MARKET, epoch, index)); }
    function _evidence(Order storage o, uint256 epoch, uint256 index) internal view returns (address seller, uint256 price, bytes32 key) {
        if (index >= book.orderCount(MARKET, epoch)) revert NoSuchOrder(epoch, index);
        if (!book.cleared(MARKET, epoch)) revert NotCleared(epoch);
        uint256 start = book.epochStart(epoch); if (start < o.createdAt) revert StaleEpoch(start, o.createdAt);
        (address trader, bool revealed, uint8 side,,, uint256 filled,) = book.getOrder(MARKET, epoch, index);
        if (!revealed || side != 1) revert NotASell();
        key = _key(epoch, index); uint256 used = consumed[key];
        if (filled < used + o.qty) revert FillExhausted(filled, used, o.qty);
        (price,) = book.results(MARKET, epoch); if (price > o.maxPriceCents) revert PriceAboveCap(price, o.maxPriceCents);
        if (trader == o.buyer || trader == verifier) revert RoleConflict();
        seller = trader;
    }
    /// Seller gets the cleared price, the buyer the difference to the cap, the seller its bond back.
    function _release(uint256 id, Order storage o, ReleaseWhy why) internal {
        uint256 pay = uint256(o.priceCents) * o.qty * CENT; uint256 back = o.funded - pay; uint256 bond = o.bondLocked; address seller = o.seller;
        o.status = Status.RELEASED; bondFree[seller] += bond;
        _push(seller, pay); if (back != 0) _push(o.buyer, back);
        emit Released(id, seller, pay, back, bond, why, msg.sender);
    }
    /// Buyer is refunded in full. `slash`: the locked bond also goes to the buyer; otherwise it returns to the seller's free bond.
    function _refund(uint256 id, Order storage o, bool slash, Why why) internal {
        uint256 bond = o.bondLocked; address buyer = o.buyer;
        o.status = Status.REFUNDED; if (!slash && bond != 0) bondFree[o.seller] += bond;
        _push(buyer, slash ? o.funded + bond : o.funded);
        emit Refunded(id, buyer, o.funded, slash ? bond : 0, slash ? 0 : bond, why);
    }
    function _pullExact(address from, uint256 amount) internal {
        uint256 before = token.balanceOf(address(this)); _pull(from, amount);
        uint256 got = token.balanceOf(address(this)) - before; if (got != amount) revert TokenMismatch(amount, got);
    }

    // ================= token helpers
    function _push(address to, uint256 amount) internal { (bool ok, bytes memory d) = address(token).call(abi.encodeWithSelector(IERC20Min.transfer.selector, to, amount)); if (!ok || (d.length != 0 && !abi.decode(d, (bool)))) revert TransferFailed(); }
    function _pull(address from, uint256 amount) internal { (bool ok, bytes memory d) = address(token).call(abi.encodeWithSelector(IERC20Min.transferFrom.selector, from, address(this), amount)); if (!ok || (d.length != 0 && !abi.decode(d, (bool)))) revert TransferFailed(); }
}
