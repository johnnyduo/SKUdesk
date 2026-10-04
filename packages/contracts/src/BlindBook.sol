// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {IERC20Min} from './IERC20Min.sol';

/// @title BlindBook - sealed-bid (commit-reveal) uniform-price batch auction.
/// @notice Each epoch has a COMMIT window (hashed orders, only a fixed bond is locked, so nothing about price or size leaks),
/// a REVEAL window (orders are opened and their funds or units are reserved), and then anyone can `clear` the market:
/// the maximal-volume price is found, orders are matched with price-time priority at ONE uniform price, and cash and units
/// settle atomically. Buyers pay and sellers receive the same price on the same units, so cash is conserved to the base unit.
/// @dev This is NOT a Uniswap v4 hook. "Units" are ledger entries issued by the operator (warehouse-receipt style); physical
/// delivery is off-chain. The token is a testnet stand-in. Orders revealed early are visible to later revealers (free-option
/// risk, mitigated by the forfeited bond).
contract BlindBook {
    uint256 public constant CENT = 10_000;             // base units per cent (6-decimal token)
    uint256 public constant MAX_PRICE_CENTS = 1_000_000;
    uint256 public constant MAX_UNITS = 1_000_000;
    uint256 public constant MAX_ORDERS = 24;           // per (market, epoch): bounds clearing gas

    IERC20Min public immutable token;
    address public owner; bool public paused;
    uint256 public immutable t0; uint256 public immutable epochLen; uint256 public immutable commitEnd; uint256 public immutable revealEnd; uint256 public immutable bond;

    struct Market { bool listed; uint256 tick; }
    struct Order { address trader; bool revealed; uint8 side; uint256 price; uint256 units; uint256 filled; uint256 lockedCash; uint256 lockedUnits; bytes32 hash; }
    struct Result { uint256 price; uint256 volume; }
    mapping(bytes32 => Market) public markets; bytes32[] public marketIds;
    mapping(address => uint256) public cash;                         // free tokens held in the book
    mapping(bytes32 => mapping(address => uint256)) public unitsOf;  // free units
    mapping(bytes32 => uint256) public lockedUnitsTotal; mapping(bytes32 => uint256) public totalIssued;
    uint256 public totalFree; uint256 public totalLocked; uint256 public totalBonds; uint256 public treasury;
    mapping(bytes32 => mapping(uint256 => Order[])) internal orders;
    mapping(bytes32 => mapping(uint256 => bool)) public cleared;
    mapping(bytes32 => mapping(uint256 => Result)) public results;
    mapping(bytes32 => uint256) public lastPrice; mapping(bytes32 => uint256) public lastEpoch;
    uint256 private _lock = 1;

    event MarketListed(bytes32 indexed id, uint256 tick);
    event Issued(bytes32 indexed market, address indexed to, uint256 units);
    event Deposited(address indexed who, uint256 amount); event Withdrawn(address indexed who, uint256 amount);
    event Committed(bytes32 indexed market, uint256 indexed epoch, uint256 index, address indexed trader, bytes32 hash);
    event Revealed(bytes32 indexed market, uint256 indexed epoch, uint256 index, address indexed trader, uint8 side, uint256 price, uint256 units);
    event Fill(bytes32 indexed market, uint256 indexed epoch, uint256 index, address indexed trader, uint8 side, uint256 units, uint256 price);
    event EpochCleared(bytes32 indexed market, uint256 indexed epoch, uint256 price, uint256 volume, uint256 buys, uint256 sells, uint256 forfeited);

    error Unauthorized(); error Paused(); error Reentrancy(); error TransferFailed();
    error WrongPhase(uint8 phase, uint8 needed); error MarketNotListed(bytes32 id); error BookFull();
    error InsufficientCash(uint256 have, uint256 need); error InsufficientUnits(uint256 have, uint256 need);
    error BadReveal(); error NotYourOrder(); error AlreadyRevealed(); error NoOrder(uint256 index);
    error BadSide(uint8 side); error BadPrice(uint256 price, uint256 tick); error BadUnits(uint256 units);
    error TooEarly(uint256 nowTs, uint256 readyAt); error AlreadyCleared(); error NothingToClear();

    modifier onlyOwner { if (msg.sender != owner) revert Unauthorized(); _; }
    modifier live { if (paused) revert Paused(); _; }
    modifier nonReentrant { if (_lock != 1) revert Reentrancy(); _lock = 2; _; _lock = 1; }

    constructor(address _token, uint256 _epochLen, uint256 _commitEnd, uint256 _revealEnd, uint256 _bond) {
        require(_commitEnd < _revealEnd && _revealEnd < _epochLen, 'schedule');
        token = IERC20Min(_token); owner = msg.sender; t0 = block.timestamp;
        epochLen = _epochLen; commitEnd = _commitEnd; revealEnd = _revealEnd; bond = _bond;
    }

    // ================= admin
    function listMarket(bytes32 id, uint256 tick) external onlyOwner { require(tick > 0 && !markets[id].listed, 'market'); markets[id] = Market(true, tick); marketIds.push(id); emit MarketListed(id, tick); }
    function issue(bytes32 market, address to, uint256 units) external onlyOwner { if (!markets[market].listed) revert MarketNotListed(market); unitsOf[market][to] += units; totalIssued[market] += units; emit Issued(market, to, units); }
    function pause(bool p) external onlyOwner { paused = p; }
    function withdrawTreasury(address to) external onlyOwner nonReentrant { uint256 amt = treasury; treasury = 0; _push(to, amt); }
    function marketCount() external view returns (uint256) { return marketIds.length; }

    // ================= schedule
    function currentEpoch() public view returns (uint256) { return (block.timestamp - t0) / epochLen; }
    function phase() public view returns (uint8) { uint256 off = (block.timestamp - t0) % epochLen; return off < commitEnd ? 0 : off < revealEnd ? 1 : 2; }
    function epochStart(uint256 epoch) external view returns (uint256) { return t0 + epoch * epochLen; }
    function accounted() external view returns (uint256) { return totalFree + totalLocked + totalBonds + treasury; }

    // ================= cash ledger
    function deposit(uint256 amount) external nonReentrant { _pull(msg.sender, amount); _credit(msg.sender, amount); emit Deposited(msg.sender, amount); }
    function withdraw(uint256 amount) external nonReentrant {
        if (cash[msg.sender] < amount) revert InsufficientCash(cash[msg.sender], amount);
        _debit(msg.sender, amount); _push(msg.sender, amount); emit Withdrawn(msg.sender, amount);
    }
    function _credit(address a, uint256 x) internal { cash[a] += x; totalFree += x; }
    function _debit(address a, uint256 x) internal { cash[a] -= x; totalFree -= x; }

    // ================= commit / reveal
    function commit(bytes32 market, bytes32 commitHash) external live returns (uint256 index) {
        if (!markets[market].listed) revert MarketNotListed(market);
        uint8 ph = phase(); if (ph != 0) revert WrongPhase(ph, 0);
        uint256 epoch = currentEpoch(); Order[] storage os = orders[market][epoch];
        if (os.length >= MAX_ORDERS) revert BookFull();
        if (cash[msg.sender] < bond) revert InsufficientCash(cash[msg.sender], bond);
        _debit(msg.sender, bond); totalBonds += bond;
        index = os.length;
        os.push(Order({ trader: msg.sender, revealed: false, side: 0, price: 0, units: 0, filled: 0, lockedCash: 0, lockedUnits: 0, hash: commitHash }));
        emit Committed(market, epoch, index, msg.sender, commitHash);
    }

    function reveal(bytes32 market, uint256 epoch, uint256 index, uint8 side, uint256 price, uint256 units, bytes32 salt) external live {
        uint8 ph = phase(); if (epoch != currentEpoch() || ph != 1) revert WrongPhase(epoch != currentEpoch() ? 2 : ph, 1);
        Order[] storage os = orders[market][epoch]; if (index >= os.length) revert NoOrder(index);
        Order storage o = os[index];
        if (o.trader != msg.sender) revert NotYourOrder();
        if (o.revealed) revert AlreadyRevealed();
        if (keccak256(abi.encode(market, epoch, msg.sender, side, price, units, salt)) != o.hash) revert BadReveal();
        if (side > 1) revert BadSide(side);
        uint256 tick = markets[market].tick;
        if (price == 0 || price > MAX_PRICE_CENTS || price % tick != 0) revert BadPrice(price, tick);
        if (units == 0 || units > MAX_UNITS) revert BadUnits(units);
        if (side == 0) {
            uint256 need = price * units * CENT;
            if (cash[msg.sender] < need) revert InsufficientCash(cash[msg.sender], need);
            _debit(msg.sender, need); totalLocked += need; o.lockedCash = need;
        } else {
            uint256 have = unitsOf[market][msg.sender];
            if (have < units) revert InsufficientUnits(have, units);
            unitsOf[market][msg.sender] = have - units; lockedUnitsTotal[market] += units; o.lockedUnits = units;
        }
        o.revealed = true; o.side = side; o.price = price; o.units = units;
        totalBonds -= bond; _credit(msg.sender, bond);
        emit Revealed(market, epoch, index, msg.sender, side, price, units);
    }

    // ================= clearing
    function clear(bytes32 market, uint256 epoch) external nonReentrant {
        uint256 readyAt = t0 + epoch * epochLen + revealEnd;
        if (block.timestamp < readyAt) revert TooEarly(block.timestamp, readyAt);
        if (cleared[market][epoch]) revert AlreadyCleared();
        Order[] storage os = orders[market][epoch];
        if (os.length == 0) revert NothingToClear();
        cleared[market][epoch] = true;
        (uint256 vmax, uint256 lo, uint256 hi) = _best(os);
        uint256 pStar;
        if (vmax > 0) { uint256 tick = markets[market].tick; pStar = ((lo + hi) / 2 / tick) * tick; _allocate(os, pStar, vmax); }
        (uint256 buys, uint256 sells, uint256 forfeited) = _settle(market, epoch, os, pStar);
        results[market][epoch] = Result(pStar, vmax);
        if (vmax > 0) { lastPrice[market] = pStar; lastEpoch[market] = epoch; }
        emit EpochCleared(market, epoch, pStar, vmax, buys, sells, forfeited);
    }

    /// Maximal matched volume over the revealed prices, and the lowest/highest price that achieves it.
    /// V(p) = min(units bid at >= p, units offered at <= p) is unimodal, so its argmax set is an interval and the maximum is
    /// always attained at a revealed price.
    function _best(Order[] storage os) internal view returns (uint256 vmax, uint256 lo, uint256 hi) {
        uint256 n = os.length; uint256[] memory vs = new uint256[](n);
        for (uint256 i = 0; i < n; i++) {
            if (!os[i].revealed) continue;
            uint256 p = os[i].price; uint256 dm; uint256 sp;
            for (uint256 j = 0; j < n; j++) {
                Order storage o = os[j]; if (!o.revealed) continue;
                if (o.side == 0) { if (o.price >= p) dm += o.units; } else { if (o.price <= p) sp += o.units; }
            }
            uint256 v = dm < sp ? dm : sp; vs[i] = v; if (v > vmax) vmax = v;
        }
        if (vmax == 0) return (0, 0, 0);
        lo = type(uint256).max;
        for (uint256 i = 0; i < n; i++) if (os[i].revealed && vs[i] == vmax) { uint256 p = os[i].price; if (p < lo) lo = p; if (p > hi) hi = p; }
    }

    /// Price-time priority: buys by price desc, sells by price asc, ties by commit order; fill each side up to `vmax`.
    function _allocate(Order[] storage os, uint256 pStar, uint256 vmax) internal {
        uint256 n = os.length;
        for (uint8 side = 0; side < 2; side++) {
            uint256 remaining = vmax; bool[] memory taken = new bool[](n);
            while (remaining > 0) {
                uint256 best = 0; bool found;
                for (uint256 i = 0; i < n; i++) {
                    Order storage o = os[i];
                    if (taken[i] || !o.revealed || o.side != side) continue;
                    if (side == 0 ? o.price < pStar : o.price > pStar) continue;
                    if (!found || (side == 0 ? o.price > os[best].price : o.price < os[best].price)) { best = i; found = true; }
                }
                if (!found) break;
                taken[best] = true; Order storage b = os[best];
                uint256 f = b.units < remaining ? b.units : remaining; b.filled = f; remaining -= f;
            }
        }
    }

    function _settle(bytes32 market, uint256 epoch, Order[] storage os, uint256 pStar) internal returns (uint256 buys, uint256 sells, uint256 forfeited) {
        uint256 n = os.length;
        for (uint256 i = 0; i < n; i++) {
            Order storage o = os[i];
            if (!o.revealed) { totalBonds -= bond; treasury += bond; forfeited++; continue; }
            uint256 f = o.filled;
            if (o.side == 0) {
                buys++; uint256 cost = pStar * f * CENT;
                totalLocked -= o.lockedCash; _credit(o.trader, o.lockedCash - cost);
                if (f > 0) { unitsOf[market][o.trader] += f; emit Fill(market, epoch, i, o.trader, 0, f, pStar); }
            } else {
                sells++; lockedUnitsTotal[market] -= o.lockedUnits; unitsOf[market][o.trader] += o.lockedUnits - f;
                if (f > 0) { _credit(o.trader, pStar * f * CENT); emit Fill(market, epoch, i, o.trader, 1, f, pStar); }
            }
        }
    }

    // ================= views for the UI
    function orderCount(bytes32 market, uint256 epoch) external view returns (uint256) { return orders[market][epoch].length; }
    function getOrder(bytes32 market, uint256 epoch, uint256 index) external view returns (address trader, bool revealed, uint8 side, uint256 price, uint256 units, uint256 filled, bytes32 hash) {
        Order storage o = orders[market][epoch][index]; return (o.trader, o.revealed, o.side, o.price, o.units, o.filled, o.hash);
    }

    // ================= token helpers
    function _push(address to, uint256 amount) internal { (bool ok, bytes memory d) = address(token).call(abi.encodeWithSelector(IERC20Min.transfer.selector, to, amount)); if (!ok || (d.length != 0 && !abi.decode(d, (bool)))) revert TransferFailed(); }
    function _pull(address from, uint256 amount) internal { (bool ok, bytes memory d) = address(token).call(abi.encodeWithSelector(IERC20Min.transferFrom.selector, from, address(this), amount)); if (!ok || (d.length != 0 && !abi.decode(d, (bool)))) revert TransferFailed(); }
}
