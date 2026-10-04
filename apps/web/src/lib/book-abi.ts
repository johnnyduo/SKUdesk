// BlindBook ABI shared by the keeper, the UI and the tests. Human-readable so it is easy to audit against the contract.
import { parseAbi } from 'viem';

export const BOOK_ABI = parseAbi([
  'function token() view returns (address)', 'function owner() view returns (address)', 'function paused() view returns (bool)',
  'function t0() view returns (uint256)', 'function epochLen() view returns (uint256)', 'function commitEnd() view returns (uint256)', 'function revealEnd() view returns (uint256)', 'function bond() view returns (uint256)',
  'function currentEpoch() view returns (uint256)', 'function phase() view returns (uint8)', 'function epochStart(uint256 epoch) view returns (uint256)',
  'function marketCount() view returns (uint256)', 'function marketIds(uint256) view returns (bytes32)', 'function markets(bytes32) view returns (bool listed, uint256 tick)',
  'function cash(address) view returns (uint256)', 'function unitsOf(bytes32 market, address who) view returns (uint256)',
  'function orderCount(bytes32 market, uint256 epoch) view returns (uint256)',
  'function getOrder(bytes32 market, uint256 epoch, uint256 index) view returns (address trader, bool revealed, uint8 side, uint256 price, uint256 units, uint256 filled, bytes32 hash)',
  'function cleared(bytes32 market, uint256 epoch) view returns (bool)', 'function results(bytes32 market, uint256 epoch) view returns (uint256 price, uint256 volume)',
  'function lastPrice(bytes32 market) view returns (uint256)', 'function lastEpoch(bytes32 market) view returns (uint256)',
  'function treasury() view returns (uint256)', 'function accounted() view returns (uint256)', 'function lockedUnitsTotal(bytes32 market) view returns (uint256)', 'function totalIssued(bytes32 market) view returns (uint256)',
  'function deposit(uint256 amount)', 'function withdraw(uint256 amount)', 'function listMarket(bytes32 id, uint256 tick)', 'function issue(bytes32 market, address to, uint256 units)',
  'function commit(bytes32 market, bytes32 commitHash) returns (uint256 index)',
  'function reveal(bytes32 market, uint256 epoch, uint256 index, uint8 side, uint256 price, uint256 units, bytes32 salt)',
  'function clear(bytes32 market, uint256 epoch)',
  'event MarketListed(bytes32 indexed id, uint256 tick)',
  'event Committed(bytes32 indexed market, uint256 indexed epoch, uint256 index, address indexed trader, bytes32 hash)',
  'event Revealed(bytes32 indexed market, uint256 indexed epoch, uint256 index, address indexed trader, uint8 side, uint256 price, uint256 units)',
  'event Fill(bytes32 indexed market, uint256 indexed epoch, uint256 index, address indexed trader, uint8 side, uint256 units, uint256 price)',
  'event EpochCleared(bytes32 indexed market, uint256 indexed epoch, uint256 price, uint256 volume, uint256 buys, uint256 sells, uint256 forfeited)',
  'error Unauthorized()', 'error Paused()', 'error Reentrancy()', 'error TransferFailed()', 'error WrongPhase(uint8 phase, uint8 needed)', 'error MarketNotListed(bytes32 id)', 'error BookFull()',
  'error InsufficientCash(uint256 have, uint256 need)', 'error InsufficientUnits(uint256 have, uint256 need)', 'error BadReveal()', 'error NotYourOrder()', 'error AlreadyRevealed()', 'error NoOrder(uint256 index)',
  'error BadSide(uint8 side)', 'error BadPrice(uint256 price, uint256 tick)', 'error BadUnits(uint256 units)', 'error TooEarly(uint256 nowTs, uint256 readyAt)', 'error AlreadyCleared()', 'error NothingToClear()',
]);
export const ERC20_ABI = parseAbi([
  'function balanceOf(address) view returns (uint256)', 'function allowance(address,address) view returns (uint256)', 'function approve(address,uint256) returns (bool)',
  'function mint(address to,uint256 amount)', 'function transfer(address to,uint256 amount) returns (bool)',
]);
