// ABIs for the owner console. Human-readable and exhaustive for the functions the UI calls, plus every custom error
// so a revert can always be decoded into a sentence. Kept free of runtime config so it can be unit tested.
import { parseAbi } from 'viem';

export const CORE_ABI = parseAbi([
  'function owner() view returns (address)', 'function agent() view returns (address)', 'function paused() view returns (bool)',
  'function free() view returns (uint256)', 'function totalEscrow() view returns (uint256)', 'function totalPaidOut() view returns (uint256)', 'function totalProceeds() view returns (uint256)',
  'function totalDeposited() view returns (uint256)', 'function totalWithdrawn() view returns (uint256)', 'function spentToday() view returns (uint256)',
  'function dailySpendCap() view returns (uint256)', 'function maxExec() view returns (uint256)', 'function minMarginBps() view returns (uint256)', 'function quoteTTL() view returns (uint256)',
  'function payee(address) view returns (bool)', 'function payer(address) view returns (bool)',
  'function deposit(uint256 amount)', 'function withdraw(uint256 amount)', 'function setPolicy(uint256 d,uint256 m,uint256 b,uint256 ttl)',
  'function pause(bool p)', 'function setPayee(address a,bool ok)', 'function setPayer(address a,bool ok)', 'function setAgent(address a)',
  'error Unauthorized()', 'error Paused()', 'error Reentrancy()', 'error BadQuoteHash(bytes32 expected,bytes32 got)', 'error FutureObservation(uint256 observedAt,uint256 nowTs)', 'error Replay(bytes32 oppHash)',
  'error Stale(uint256 age,uint256 ttl)', 'error OutOfBounds(bytes32 field,uint256 value)', 'error BadUnits(uint256 units)', 'error SpendCap(uint256 spendCents,uint256 capCents)', 'error DailyCap(uint256 spentAfterCents,uint256 capCents)',
  'error MathMismatch(int256 claimedNet,int256 derivedNet,uint256 claimedBps,uint256 derivedBps)', 'error MarginTooLow(uint256 marginBps,uint256 floorBps)', 'error NonPositiveNet(int256 net)',
  'error UnknownOpportunity(bytes32 oppHash)', 'error OpportunityConsumed(bytes32 oppHash)', 'error InsufficientFree(uint256 free,uint256 needed)', 'error PayeeNotAllowed(address who)', 'error PayerNotAllowed(address who)',
  'error ExceedsEscrow(uint256 amount,uint256 escrowLeft)', 'error BadTransition(uint8 from,uint8 to)', 'error TransferFailed()',
]);

export const TOKEN_ABI = parseAbi([
  'function name() view returns (string)', 'function symbol() view returns (string)', 'function decimals() view returns (uint8)', 'function owner() view returns (address)',
  'function balanceOf(address) view returns (uint256)', 'function allowance(address,address) view returns (uint256)', 'function totalSupply() view returns (uint256)',
  'function approve(address spender,uint256 amount) returns (bool)', 'function mint(address to,uint256 amount)', 'function transfer(address to,uint256 amount) returns (bool)',
  'error NotOwner()', 'error Insufficient()', 'error Allowance()',
]);

/** Every error ABI in one list, for decoding a revert from either contract. */
export const ALL_ABI = [...CORE_ABI, ...TOKEN_ABI];
