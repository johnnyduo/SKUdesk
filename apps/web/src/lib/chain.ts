// Browser-side live chain access (read-only). The RPC allows cross-origin reads, so these calls go straight from the
// visitor's browser to Robinhood Chain Testnet. No wallet, no gas, no private key: simulations run as the agent's public address.
import { createPublicClient, http, parseAbi, getAddress, defineChain } from 'viem';
import { economics } from '../../../../packages/economics/index.js';
import { CHAIN, DEPLOYMENT, RUN } from './run';

const QUOTE = '(uint256 purchaseCents,uint256 shipCents,uint256 dutyCents,uint256 taxCents,uint256 procFeeCents,uint256 payFeeCents,uint256 sellCents,uint256 mktFeeBps,uint256 fulfillCents,uint256 retBps,uint256 chainCents)';
export const ABI = parseAbi([
  `function commitOpportunity(bytes32 productHash,bytes32 quoteHash,bytes32 snapshotHash,uint256 observedAt,uint256 units,${QUOTE} q,int256 agentNet,uint256 agentMarginBps) returns (bytes32,uint256,int256)`,
  'function free() view returns (uint256)', 'function totalEscrow() view returns (uint256)', 'function totalPaidOut() view returns (uint256)', 'function totalProceeds() view returns (uint256)',
  'function totalDeposited() view returns (uint256)', 'function totalWithdrawn() view returns (uint256)', 'function spentToday() view returns (uint256)', 'function dayNum() view returns (uint256)',
  'function dailySpendCap() view returns (uint256)', 'function maxExec() view returns (uint256)', 'function minMarginBps() view returns (uint256)', 'function quoteTTL() view returns (uint256)',
  'function paused() view returns (bool)', 'function nextLot() view returns (uint256)', 'function statusOf(uint256 lot) view returns (uint8)', 'function escrow(uint256 lot) view returns (uint256)', 'function paidOut(uint256 lot) view returns (uint256)',
  'error Unauthorized()', 'error Paused()', 'error Reentrancy()', 'error BadQuoteHash(bytes32 expected,bytes32 got)', 'error FutureObservation(uint256 observedAt,uint256 nowTs)', 'error Replay(bytes32 oppHash)',
  'error Stale(uint256 age,uint256 ttl)', 'error OutOfBounds(bytes32 field,uint256 value)', 'error BadUnits(uint256 units)', 'error SpendCap(uint256 spendCents,uint256 capCents)', 'error DailyCap(uint256 spentAfterCents,uint256 capCents)',
  'error MathMismatch(int256 claimedNet,int256 derivedNet,uint256 claimedBps,uint256 derivedBps)', 'error MarginTooLow(uint256 marginBps,uint256 floorBps)', 'error NonPositiveNet(int256 net)',
  'error UnknownOpportunity(bytes32 oppHash)', 'error OpportunityConsumed(bytes32 oppHash)', 'error InsufficientFree(uint256 free,uint256 needed)', 'error PayeeNotAllowed(address who)', 'error PayerNotAllowed(address who)',
  'error ExceedsEscrow(uint256 amount,uint256 escrowLeft)', 'error BadTransition(uint8 from,uint8 to)', 'error TransferFailed()',
]);
export const LOT_STATES = ['NONE', 'CREATED', 'FUNDED', 'PURCHASED', 'RECEIVED', 'LISTED', 'SOLD', 'SETTLED', 'CANCELLED', 'REFUNDED'];

let _client: ReturnType<typeof createPublicClient> | null = null;
export function client() {
  if (!CHAIN.rpc) throw new Error('No public RPC for this chain');
  return (_client ??= createPublicClient({ chain: defineChain({ id: CHAIN.id, name: CHAIN.name, nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [CHAIN.rpc] } } }), transport: http(CHAIN.rpc, { timeout: 12_000 }) }));
}
const core = () => getAddress(DEPLOYMENT.core);
const rd = async (fn: string, args: any[] = []) => (await client().readContract({ address: core(), abi: ABI, functionName: fn as any, args: args as any } as any)) as any;

export type VaultState = { free: bigint; totalEscrow: bigint; totalPaidOut: bigint; totalProceeds: bigint; totalDeposited: bigint; totalWithdrawn: bigint; spentToday: bigint; paused: boolean; block: bigint; at: number };
export async function readVault(): Promise<VaultState> {
  const c = client();
  const [free, totalEscrow, totalPaidOut, totalProceeds, totalDeposited, totalWithdrawn, spentToday, paused, block] = await Promise.all([
    rd('free'), rd('totalEscrow'), rd('totalPaidOut'), rd('totalProceeds'), rd('totalDeposited'), rd('totalWithdrawn'), rd('spentToday'), rd('paused'), c.getBlockNumber(),
  ]);
  return { free, totalEscrow, totalPaidOut, totalProceeds, totalDeposited, totalWithdrawn, spentToday, paused, block, at: Date.now() };
}
export type PolicyState = { dailySpendCap: bigint; maxExec: bigint; minMarginBps: bigint; quoteTTL: bigint };
export async function readPolicy(): Promise<PolicyState> {
  const [dailySpendCap, maxExec, minMarginBps, quoteTTL] = await Promise.all([rd('dailySpendCap'), rd('maxExec'), rd('minMarginBps'), rd('quoteTTL')]);
  return { dailySpendCap, maxExec, minMarginBps, quoteTTL };
}
export async function readLot(id: number) {
  const [status, escrow, paidOut] = await Promise.all([rd('statusOf', [BigInt(id)]), rd('escrow', [BigInt(id)]), rd('paidOut', [BigInt(id)])]);
  return { status: LOT_STATES[Number(status)] ?? String(status), escrow: escrow as bigint, paidOut: paidOut as bigint };
}

// revert -> plain language (shared, pure, unit-tested)
import { explain } from './explain.ts';
export { explain };

// simulate commitOpportunity on the REAL contract as the agent (eth_call; nothing is sent)
// The routine lives in sim.ts (dependency-injected, unit tested); this wires it to the real client, library and addresses.
import { simulateCommitWith, type SimInput, type SimResult } from './sim.ts';
export { SimOutOfRange, RANGE_MESSAGE } from './sim.ts';
export type { SimInput, SimResult };
export const simulateCommit = (i: SimInput): Promise<SimResult> => simulateCommitWith({ economics, client: client(), core: core(), agent: getAddress(RUN.meta.agent), abi: ABI }, i);
