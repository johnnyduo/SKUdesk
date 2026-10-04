// OrderEscrow ABI shared by the proof script, the snapshot tool, the UI and the tests. Human-readable so it is easy to audit against
// packages/contracts/src/OrderEscrow.sol. The Solidity enums Status, Why and ReleaseWhy are uint8 on the wire. The `match` step is `matchOrder` in code.
import { parseAbi } from 'viem';

export const ORDERS_ABI = parseAbi([
  'struct Order { address buyer; address seller; uint8 status; bytes32 shipToHash; uint32 qty; uint32 priceCents; uint32 maxPriceCents; uint64 createdAt; uint64 matchBy; uint64 acceptBy; uint64 shipBy; uint64 verifyBy; uint64 releaseAfter; uint64 resolveBy; uint256 funded; uint256 bondLocked; bytes32 shipmentHash; bytes32 receiptHash; uint64 matchEpoch; uint32 matchIndex; }',
  // views
  'function token() view returns (address)', 'function book() view returns (address)', 'function CENT() view returns (uint256)', 'function MARKET() view returns (bytes32)', 'function SKU() view returns (bytes32)', 'function verifier() view returns (address)',
  'function bondBps() view returns (uint256)', 'function acceptWindow() view returns (uint256)', 'function shipWindow() view returns (uint256)', 'function verifyWindow() view returns (uint256)', 'function disputeWindow() view returns (uint256)', 'function resolveWindow() view returns (uint256)',
  'function nextId() view returns (uint256)', 'function bondFree(address) view returns (uint256)', 'function consumed(bytes32) view returns (uint256)',
  'function getOrder(uint256 id) view returns (Order)', 'function bondNeeded(uint256 id) view returns (uint256)', 'function consumedAt(uint256 epoch, uint256 index) view returns (uint256)',
  // seller
  'function depositBond(uint256 amount)', 'function withdrawBond(uint256 amount)', 'function accept(uint256 id)', 'function decline(uint256 id)', 'function ship(uint256 id, bytes32 shipmentHash)',
  // buyer
  'function createOrder(uint256 qty, uint256 maxPriceCents, bytes32 shipToHash, uint256 matchBy) returns (uint256 id)', 'function cancel(uint256 id)', 'function matchOrder(uint256 id, uint256 epoch, uint256 index)',
  'function refundUnaccepted(uint256 id)', 'function dispute(uint256 id)', 'function release(uint256 id)',
  // verifier
  'function attest(uint256 id, bytes32 receivedSku, bool ok, bytes32 receiptHash)', 'function resolve(uint256 id, bool sellerWins)',
  // timeout exits (anyone)
  'function refundUnshipped(uint256 id)', 'function refundUnverified(uint256 id)', 'function releaseUnresolved(uint256 id)',
  // events
  'event BondDeposited(address indexed seller, uint256 amount, uint256 bondFree)', 'event BondWithdrawn(address indexed seller, uint256 amount, uint256 bondFree)',
  'event OrderCreated(uint256 indexed id, address indexed buyer, uint256 qty, uint256 maxPriceCents, bytes32 shipToHash, uint256 matchBy, uint256 funded)',
  'event Cancelled(uint256 indexed id, address indexed buyer, uint256 refund, address caller)',
  'event Offered(uint256 indexed id, address indexed seller, uint256 epoch, uint256 index, uint256 priceCents, uint256 acceptBy)',
  'event Accepted(uint256 indexed id, address indexed seller, uint256 bond, uint256 shipBy)',
  'event Shipped(uint256 indexed id, address indexed seller, bytes32 shipmentHash, uint256 verifyBy)',
  'event Attested(uint256 indexed id, bool delivered, bytes32 receivedSku, bytes32 receiptHash, uint256 releaseAfter)',
  'event Disputed(uint256 indexed id, address indexed buyer, uint256 resolveBy)',
  'event Released(uint256 indexed id, address seller, uint256 paid, uint256 refundedToBuyer, uint256 bondReturned, uint8 why, address caller)',
  'event Refunded(uint256 indexed id, address indexed buyer, uint256 refund, uint256 bondToBuyer, uint256 bondToSeller, uint8 why)',
  // errors (so a revert decodes into a name)
  'error Unauthorized()', 'error Reentrancy()', 'error TransferFailed()', 'error BadConfig()', 'error BadStatus(uint8 have, uint8 needed)', 'error Expired(uint256 deadline)', 'error TokenMismatch(uint256 expected, uint256 got)',
  'error RoleConflict()', 'error BadQty(uint256 qty)', 'error BadPrice(uint256 cents)', 'error BadMatchBy(uint256 matchBy)', 'error ZeroHash()', 'error NoSuchOrder(uint256 epoch, uint256 index)', 'error NotCleared(uint256 epoch)',
  'error StaleEpoch(uint256 epochStart, uint256 createdAt)', 'error NotASell()', 'error FillExhausted(uint256 filled, uint256 consumed, uint256 qty)', 'error PriceAboveCap(uint256 price, uint256 cap)', 'error InsufficientBond(uint256 have, uint256 need)', 'error WrongToken(address bookToken, address given)', 'error TooEarly(uint256 deadline)',
]);

/** Names of the events the escrow emits, in the order a normal order meets them. */
export const ORDER_EVENTS = ['OrderCreated', 'Cancelled', 'Offered', 'Accepted', 'Shipped', 'Attested', 'Disputed', 'Released', 'Refunded'] as const;
export const BOND_EVENTS = ['BondDeposited', 'BondWithdrawn'] as const;
