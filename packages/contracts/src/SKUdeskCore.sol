// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {EconLib} from './EconLib.sol';

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address a) external view returns (uint256);
}

/// @title SKUdeskCore - a mandate vault: an AI agent can only spend what an on-chain policy allows,
/// and cannot misreport the economics of what it proposes.
/// @notice Enforced here: (1) the contract re-derives the unit economics from the quote and reverts on any
/// mismatch with the agent's claim; (2) spend is DERIVED (landed * units), never agent-supplied; (3) a lot can
/// only be minted from a committed opportunity and funded with exactly its committed spend; (4) escrowed funds
/// can only be released to owner-allowlisted payees; (5) settlement credits only tokens actually received.
/// NOT enforced here: product identity (checked off-chain, committed as productHash), truth of input prices
/// (committed as snapshotHash for later audit), and the real-world lifecycle steps after escrow (agent-attested).
contract SKUdeskCore {
    // ---- constants
    uint256 public constant CENT = 10_000;          // 1 cent = 10^4 base units of a 6-decimal token (exact)
    uint256 public constant MAX_FIELD = 1e12;       // cents; bounds every quote field
    uint256 public constant MAX_UNITS = 1e9;
    uint256 public constant MAX_BPS = 10_000;

    // ---- roles & policy
    IERC20 public immutable token;
    address public owner; address public agent; bool public paused;
    uint256 public dailySpendCap; uint256 public maxExec; uint256 public minMarginBps; uint256 public quoteTTL;
    uint256 public spentToday; uint256 public dayNum;
    mapping(address => bool) public payee; mapping(address => bool) public payer;
    uint256 private _lock = 1;

    // ---- money (token base units)
    uint256 public free; uint256 public totalEscrow; uint256 public totalPaidOut;
    uint256 public totalDeposited; uint256 public totalWithdrawn; uint256 public totalProceeds;
    mapping(uint256 => uint256) public escrow; mapping(uint256 => uint256) public paidOut;

    // ---- opportunities & lots
    struct Opp { bytes32 productHash; uint256 units; uint256 landedCents; uint256 spendCents; int256 netCents; bool exists; bool consumed; }
    mapping(bytes32 => Opp) public opps;
    enum LS { NONE, CREATED, FUNDED, PURCHASED, RECEIVED, LISTED, SOLD, SETTLED, CANCELLED, REFUNDED }
    struct Lot { uint256 units; uint256 landedCents; uint256 spendCents; bytes32 productHash; bytes32 oppHash; LS status; }
    mapping(uint256 => Lot) public lots; uint256 public nextLot;

    // ---- events
    event PolicyUpdated(uint256 daily, uint256 maxExec, uint256 marginBps, uint256 ttl);
    event Deposited(address indexed from, uint256 amount, uint256 free);
    event Withdrawn(address indexed to, uint256 amount, uint256 free);
    event OpportunityCommitted(bytes32 indexed oppHash, bytes32 productHash, bytes32 quoteHash, bytes32 snapshotHash, uint256 observedAt, uint256 units, uint256 spendCents, uint256 marginBps, uint256 netCents);
    event LotMinted(uint256 indexed lotId, bytes32 indexed oppHash, uint256 units, bytes32 productHash, uint256 landedCents);
    event LotMoved(uint256 indexed lotId, LS from, LS to);
    event EscrowFunded(uint256 indexed lotId, uint256 amount, uint256 total);
    event Paid(uint256 indexed lotId, address indexed payee, uint256 amount, uint256 escrowLeft);
    event Settled(uint256 indexed lotId, uint256 proceedsBase, uint256 paidOutBase, int256 realizedBase);
    event Refunded(uint256 indexed lotId, uint256 amount);

    // ---- errors (arguments let the UI explain every revert in words)
    error Unauthorized(); error Paused(); error Reentrancy();
    error BadQuoteHash(bytes32 expected, bytes32 got);
    error FutureObservation(uint256 observedAt, uint256 nowTs);
    error Replay(bytes32 oppHash);
    error Stale(uint256 age, uint256 ttl);
    error OutOfBounds(bytes32 field, uint256 value);
    error BadUnits(uint256 units);
    error SpendCap(uint256 spendCents, uint256 capCents);
    error DailyCap(uint256 spentAfterCents, uint256 capCents);
    error MathMismatch(int256 claimedNet, int256 derivedNet, uint256 claimedBps, uint256 derivedBps);
    error MarginTooLow(uint256 marginBps, uint256 floorBps);
    error NonPositiveNet(int256 net);
    error UnknownOpportunity(bytes32 oppHash);
    error OpportunityConsumed(bytes32 oppHash);
    error InsufficientFree(uint256 free, uint256 needed);
    error PayeeNotAllowed(address who); error PayerNotAllowed(address who);
    error ExceedsEscrow(uint256 amount, uint256 escrowLeft);
    error BadTransition(LS from, LS to);
    error TransferFailed();

    modifier onlyOwner { if (msg.sender != owner) revert Unauthorized(); _; }
    modifier onlyAgent { if (msg.sender != agent) revert Unauthorized(); _; }
    modifier live { if (paused) revert Paused(); _; }
    modifier nonReentrant { if (_lock != 1) revert Reentrancy(); _lock = 2; _; _lock = 1; }

    constructor(address _token, address _agent) {
        token = IERC20(_token); owner = msg.sender; agent = _agent;
        dailySpendCap = 500_000; maxExec = 250_000; minMarginBps = 1800; quoteTTL = 180; dayNum = block.timestamp / 1 days;
    }

    // ================= admin
    function setPolicy(uint256 d, uint256 m, uint256 b, uint256 ttl) external onlyOwner {
        if (b < 100 || b > 9000) revert OutOfBounds('minMarginBps', b);
        dailySpendCap = d; maxExec = m; minMarginBps = b; quoteTTL = ttl;
        emit PolicyUpdated(d, m, b, ttl);
    }
    function setAgent(address a) external onlyOwner { agent = a; }
    function setPayee(address a, bool ok) external onlyOwner { payee[a] = ok; }
    function setPayer(address a, bool ok) external onlyOwner { payer[a] = ok; }
    function pause(bool p) external onlyOwner { paused = p; }

    function deposit(uint256 amount) external onlyOwner nonReentrant {
        free += amount; totalDeposited += amount;
        _pull(msg.sender, amount);
        emit Deposited(msg.sender, amount, free);
    }
    function withdraw(uint256 amount) external onlyOwner nonReentrant {
        if (amount > free) revert InsufficientFree(free, amount);
        free -= amount; totalWithdrawn += amount;
        _push(msg.sender, amount);
        emit Withdrawn(msg.sender, amount, free);
    }

    // ================= opportunity
    /// @notice Commit an opportunity. Everything economic is re-derived on-chain; agent figures are only cross-checked.
    /// Check order matters (the first failing check is the one the caller sees).
    function commitOpportunity(
        bytes32 productHash, bytes32 quoteHash, bytes32 snapshotHash, uint256 observedAt, uint256 units,
        EconLib.Quote calldata q, int256 agentNet, uint256 agentMarginBps
    ) external onlyAgent live returns (bytes32 oppHash, uint256 marginBps, int256 net) {
        bytes32 expected = keccak256(abi.encode(q));
        if (quoteHash != expected) revert BadQuoteHash(expected, quoteHash);
        if (observedAt > block.timestamp) revert FutureObservation(observedAt, block.timestamp);
        oppHash = keccak256(abi.encode(productHash, quoteHash, snapshotHash));
        if (opps[oppHash].exists) revert Replay(oppHash);
        uint256 age = block.timestamp - observedAt;
        if (age > quoteTTL) revert Stale(age, quoteTTL);
        _bounds(q, units);
        EconLib.Result memory r = EconLib.quote(q);
        uint256 spend = r.landed * units;                       // derived, never supplied by the agent
        if (spend > maxExec) revert SpendCap(spend, maxExec);
        if (block.timestamp / 1 days != dayNum) { dayNum = block.timestamp / 1 days; spentToday = 0; }
        if (spentToday + spend > dailySpendCap) revert DailyCap(spentToday + spend, dailySpendCap);
        if (r.net != agentNet || r.marginBps != agentMarginBps) revert MathMismatch(agentNet, r.net, agentMarginBps, r.marginBps);
        if (r.net <= 0) revert NonPositiveNet(r.net);
        if (r.marginBps < minMarginBps) revert MarginTooLow(r.marginBps, minMarginBps);
        spentToday += spend;
        opps[oppHash] = Opp(productHash, units, r.landed, spend, r.net, true, false);
        emit OpportunityCommitted(oppHash, productHash, quoteHash, snapshotHash, observedAt, units, spend, r.marginBps, uint256(r.net));
        return (oppHash, r.marginBps, r.net);
    }

    function _bounds(EconLib.Quote calldata q, uint256 units) internal pure {
        if (units == 0 || units > MAX_UNITS) revert BadUnits(units);
        if (q.purchaseCents > MAX_FIELD) revert OutOfBounds('purchaseCents', q.purchaseCents);
        if (q.shipCents > MAX_FIELD) revert OutOfBounds('shipCents', q.shipCents);
        if (q.dutyCents > MAX_FIELD) revert OutOfBounds('dutyCents', q.dutyCents);
        if (q.taxCents > MAX_FIELD) revert OutOfBounds('taxCents', q.taxCents);
        if (q.procFeeCents > MAX_FIELD) revert OutOfBounds('procFeeCents', q.procFeeCents);
        if (q.payFeeCents > MAX_FIELD) revert OutOfBounds('payFeeCents', q.payFeeCents);
        if (q.sellCents > MAX_FIELD) revert OutOfBounds('sellCents', q.sellCents);
        if (q.fulfillCents > MAX_FIELD) revert OutOfBounds('fulfillCents', q.fulfillCents);
        if (q.chainCents > MAX_FIELD) revert OutOfBounds('chainCents', q.chainCents);
        if (q.mktFeeBps > MAX_BPS) revert OutOfBounds('mktFeeBps', q.mktFeeBps);
        if (q.retBps > MAX_BPS) revert OutOfBounds('retBps', q.retBps);
    }

    // ================= lots
    function statusOf(uint256 lot) external view returns (LS) { return lots[lot].status; }

    function _move(uint256 lot, LS to) internal {
        LS from = lots[lot].status;
        bool ok = (from == LS.NONE && to == LS.CREATED) || (from == LS.CREATED && to == LS.FUNDED)
            || (from == LS.FUNDED && (to == LS.PURCHASED || to == LS.CANCELLED)) || (from == LS.PURCHASED && (to == LS.RECEIVED || to == LS.CANCELLED))
            || (from == LS.RECEIVED && to == LS.LISTED) || (from == LS.LISTED && (to == LS.SOLD || to == LS.CANCELLED))
            || (from == LS.SOLD && to == LS.SETTLED) || (from == LS.CANCELLED && to == LS.REFUNDED);
        if (!ok) revert BadTransition(from, to);
        lots[lot].status = to;
        emit LotMoved(lot, from, to);
    }

    /// @notice A lot exists only for a committed, not-yet-consumed opportunity; units/landed come from it.
    function mintLot(bytes32 oppHash) external onlyAgent live returns (uint256 id) {
        Opp storage o = opps[oppHash];
        if (!o.exists) revert UnknownOpportunity(oppHash);
        if (o.consumed) revert OpportunityConsumed(oppHash);
        o.consumed = true;
        id = ++nextLot;
        lots[id] = Lot(o.units, o.landedCents, o.spendCents, o.productHash, oppHash, LS.NONE);
        _move(id, LS.CREATED);
        emit LotMinted(id, oppHash, o.units, o.productHash, o.landedCents);
    }

    /// @notice Moves EXACTLY the committed spend from the vault's free balance into this lot's escrow.
    function fundLot(uint256 lot) external onlyAgent live {
        uint256 amount = lots[lot].spendCents * CENT;
        if (lots[lot].status != LS.CREATED) revert BadTransition(lots[lot].status, LS.FUNDED);
        if (amount > free) revert InsufficientFree(free, amount);
        _move(lot, LS.FUNDED);
        free -= amount; escrow[lot] = amount; totalEscrow += amount;
        emit EscrowFunded(lot, amount, amount);
    }

    /// @notice Release part of the escrow to an owner-allowlisted payee (the supplier). The agent cannot choose any other recipient.
    function markPurchased(uint256 lot, address to, uint256 amount) external onlyAgent live nonReentrant {
        if (!payee[to]) revert PayeeNotAllowed(to);
        if (amount > escrow[lot]) revert ExceedsEscrow(amount, escrow[lot]);
        _move(lot, LS.PURCHASED);
        escrow[lot] -= amount; totalEscrow -= amount; paidOut[lot] += amount; totalPaidOut += amount;
        _push(to, amount);
        emit Paid(lot, to, amount, escrow[lot]);
    }
    // The following lifecycle steps happen in the real world and are agent-attested in v1.
    function markReceived(uint256 lot) external onlyAgent live { _move(lot, LS.RECEIVED); }
    function markListed(uint256 lot) external onlyAgent live { _move(lot, LS.LISTED); }
    function markSold(uint256 lot) external onlyAgent live { _move(lot, LS.SOLD); }

    /// @notice Settle with REAL proceeds pulled from an allowlisted payer. Realized P&L is measured from tokens actually received.
    function settle(uint256 lot, address from, uint256 proceeds) external onlyAgent live nonReentrant {
        if (!payer[from]) revert PayerNotAllowed(from);
        if (lots[lot].status != LS.SOLD) revert BadTransition(lots[lot].status, LS.SETTLED);
        _move(lot, LS.SETTLED);
        uint256 before = token.balanceOf(address(this));
        _pull(from, proceeds);
        uint256 received = token.balanceOf(address(this)) - before;
        uint256 left = escrow[lot];
        escrow[lot] = 0; totalEscrow -= left;
        free += received + left; totalProceeds += received;
        emit Settled(lot, received, paidOut[lot], int256(received) - int256(paidOut[lot]));
    }

    function cancel(uint256 lot) external onlyAgent live {
        LS s = lots[lot].status;
        if (s == LS.FUNDED || s == LS.PURCHASED || s == LS.LISTED) _move(lot, LS.CANCELLED);
        else revert BadTransition(s, LS.CANCELLED);
    }

    /// @notice Returns only the UNSPENT escrow to the vault's free balance.
    function refund(uint256 lot) external onlyAgent live {
        _move(lot, LS.REFUNDED);
        uint256 left = escrow[lot];
        escrow[lot] = 0; totalEscrow -= left; free += left;
        emit Refunded(lot, left);
    }

    // ================= token helpers (tolerate tokens that return nothing)
    function _push(address to, uint256 amount) internal {
        (bool ok, bytes memory d) = address(token).call(abi.encodeWithSelector(IERC20.transfer.selector, to, amount));
        if (!ok || (d.length != 0 && !abi.decode(d, (bool)))) revert TransferFailed();
    }
    function _pull(address from, uint256 amount) internal {
        (bool ok, bytes memory d) = address(token).call(abi.encodeWithSelector(IERC20.transferFrom.selector, from, address(this), amount));
        if (!ok || (d.length != 0 && !abi.decode(d, (bool)))) revert TransferFailed();
    }
}
