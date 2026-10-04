// Single source of truth for every /app page: the recorded run, the market snapshot, and the deployment.
// Nothing here is invented. All numbers come from apps/web/src/data/{run,snapshot,deployment}.json,
// which tools/run-agent.ts writes from a real run on a real chain.
import runRaw from '../data/run.json';
import snapshot from '../data/snapshot.json';
import deployment from '../data/deployment.json';
import { deepMoney, fmtCents, proceedsFacts } from './money';
const run = deepMoney(runRaw);
// Plain-word fixes applied when the saved run is read (run.json itself is a record and is not edited).
const plain = (s: string) => s.replace(/realized P&L/g, 'profit at settlement').replace(/\(prediction matches settlement\)/g, '(equal by design in this run)').replace(/\bbreakeven:/g, 'totalCost:').replace(/\(attempt (\d+), [\w.-]+\)/g, '(attempt $1)').replace(/per-run cap/g, 'per-trade cap');
for (const e of ((run as any).events ?? []) as any[]) {
  if (typeof e.title === 'string') e.title = plain(e.title);
  if (typeof e.detail === 'string') e.detail = plain(e.detail);
  for (const l of (e.data?.proof ?? []) as any[]) if (l.label === 'breakeven') l.label = 'totalCost';
} // run.json is hash-bound; amounts written as "$2500.00" are shown as "$2,500.00"

export type RunEvent = { id: number; at: number; kind: string; title: string; detail?: string; data?: any; tx?: { hash: string; block: number; gasUsed: string; status: string } };
export const RUN = run as unknown as {
  meta: { chainId: number; core: string; token: string; owner: string; agent: string; supplier: string; payer: string; model: string; startedAt: string; durationMs: number; note: string; snapshotHash: string; lot: number; oppHash: string };
  policy: { dailySpendCap: string; maxExec: string; minMarginBps: string; quoteTTL: string };
  accepted: { buyOfferId: string; sellOfferId: string; units: number; reasoning: string[] };
  attacks: { name: string; error: string; args: any[]; sentence: string }[];
  end: { free: string; totalEscrow: string; totalPaidOut: string; totalProceeds: string; spentToday: string };
  events: RunEvent[];
};
export type Offer = { id: string; source: string; title: string; priceCents: number; shipCents: number; stock: number; seller: string; attributes: Record<string, string>; gtin?: string };
export const SNAPSHOT = snapshot as unknown as { capturedAt: string; source: string; offers: Offer[] };
export const DEPLOYMENT = deployment as { chainId: number; token: string; core: string; owner: string; agent: string; supplier: string; payer: string; deployBlock: number };

export const IS_REAL_CHAIN = RUN.meta.chainId === 46630;
export const CHAIN = IS_REAL_CHAIN
  ? { id: 46630, name: 'Robinhood Chain Testnet', rpc: 'https://rpc.testnet.chain.robinhood.com', explorer: 'https://explorer.testnet.chain.robinhood.com' }
  : { id: RUN.meta.chainId, name: 'Local dev chain', rpc: '', explorer: '' };
export const explorer = {
  tx: (h: string) => (CHAIN.explorer ? `${CHAIN.explorer}/tx/${h}` : ''),
  address: (a: string) => (CHAIN.explorer ? `${CHAIN.explorer}/address/${a}` : ''),
  code: (a: string) => (CHAIN.explorer ? `${CHAIN.explorer}/address/${a}?tab=contract` : ''),
};

// formatting
export const CENT = 10_000n; // 1 cent = 10^4 base units of the 6-decimal token
export const usdCents = fmtCents;
export const usdBase = (b: number | bigint | string) => usdCents(Number(b) / 1e4);
export const pct = (bps: number | string) => (Number(bps) / 100).toFixed(2) + '%';
export const short = (h: string, a = 6, b = 4) => (h.length > a + b + 2 ? h.slice(0, a + 2) + '…' + h.slice(-b) : h);

// the recorded run, structured
export const TXS = RUN.events.filter((e) => e.tx) as (RunEvent & { tx: NonNullable<RunEvent['tx']> })[];
export const ECON = RUN.events.find((e) => e.kind === 'econ')!.data as { landedCents: number; netCents: number; marginBps: number; proof: { label: string; formula: string; resultCents: number }[]; units: number; spendCents: number };
export const REASONING = RUN.events.filter((e) => e.kind === 'reason').map((e) => e.title);
export const GATES = RUN.events.filter((e) => e.kind === 'gate');
export const PROPOSAL = RUN.events.find((e) => e.kind === 'agent' && e.title === 'Agent proposal');
export const FAILED_TX = TXS.find((t) => t.tx.status === 'reverted');

export type LotStep = { state: string; fn: string; tx: (typeof TXS)[number]; attested: boolean; plain: string };
const LOT_MAP: [string, string, boolean, string][] = [
  ['commitOpportunity', 'COMMITTED', false, 'The contract re-derived the economics, derived the spend, and stored the opportunity.'],
  ['mintLot', 'CREATED', false, 'A lot exists only for a committed opportunity.'],
  ['fundLot', 'FUNDED', false, 'Exactly the committed spend moved from the vault into this lot’s escrow.'],
  ['markPurchased', 'PURCHASED', false, 'Escrow was paid to an owner-allowlisted supplier; the agent cannot pick another recipient.'],
  ['markReceived', 'RECEIVED', true, 'Goods received. This real-world step is attested by the agent in v1.'],
  ['markListed', 'LISTED', true, 'Goods listed for sale. Agent-attested in v1.'],
  ['markSold', 'SOLD', true, 'Goods sold. Agent-attested in v1.'],
  ['settle', 'SETTLED', false, 'Proceeds were pulled from an allowlisted payer; profit is measured on tokens actually received.'],
];
export const LOT_STEPS: LotStep[] = LOT_MAP.map(([fn, state, attested, plain]) => ({ fn, state, attested, plain, tx: TXS.find((t) => t.title.startsWith(fn))! })).filter((s) => !!s.tx);

export const VERIFIED_NET_CENTS = ECON.netCents * ECON.units;
export const REALIZED_CENTS = (Number(RUN.end.totalProceeds) - Number(RUN.end.totalPaidOut)) / 1e4;
export const SPEND_CENTS = ECON.spendCents;
/** Plain statement of what the sale proceeds are (net of selling-side costs), derived from the run data. */
export const PROCEEDS = proceedsFacts(RUN, SNAPSHOT.offers);

// Guard catalogue: every rule the contract enforces, its error, the Foundry test that proves it,
// and whether the recorded run demonstrates it on-chain.
export type Guard = { id: string; rule: string; error: string; test: string; demonstrated: boolean; plain: string };
const demo = new Set(RUN.attacks.map((a) => a.error));
export const GUARDS: Guard[] = ([
  ['math', 'Economics re-derived on-chain', 'MathMismatch', 'testLieAboutNetRevertsWithBothNumbers', 'The contract recomputes net and margin from the quote. If the agent’s claim differs by even one cent it reverts and shows both numbers.'],
  ['spend', 'Per-trade cap', 'SpendCap', 'testPerExecutionCapRevertsWithValues', 'Spend is derived as landed cost × units, never supplied by the agent, then compared with the owner’s cap.'],
  ['daily', 'Daily commitment cap', 'DailyCap', 'testDailyCapRevertsAndResetsNextDay', 'A running total of new commitments per UTC day; the agent cannot split a big purchase into many small ones to dodge it. It limits commitments, not cash-out: opportunities do not expire, so commitments banked on earlier days can be funded later. Across a midnight, up to twice the cap can be committed within 24 hours. What actually leaves the vault is bounded by the vault’s free balance; each lot is at most the per-trade cap.'],
  ['stale', 'Quote freshness (TTL)', 'Stale', 'testStaleRevertsWithAgeAndTtl', 'The age check uses the observation time the agent supplies, so it limits how stale the agent’s own claim can be, not the real age of the source data. The snapshot hash binds the data that was shown.'],
  ['replay', 'No replay', 'Replay', 'testReplayRevertsEvenWithSameInputs', 'The opportunity id is keccak256(productHash, quoteHash, snapshotHash), so the same id cannot be committed twice, and each commit is bounded by the per-trade and daily caps. The agent supplies the snapshot hash, so a new snapshot hash is a new id: the caps, not the id, limit how often the same quote can be committed.'],
  ['quotehash', 'Quote commitment', 'BadQuoteHash', 'testBadQuoteHashReverts', 'The agent commits a hash of the quote it used; submitting a different quote is refused.'],
  ['future', 'No future timestamps', 'FutureObservation', 'testFutureObservationReverts', 'The agent cannot claim an observation from the future to defeat the freshness check.'],
  ['margin', 'Margin floor', 'MarginTooLow', 'testWeakMarginReverts', 'Net margin below the owner’s floor is refused. Rounding always favours caution.'],
  ['loss', 'Positive net only', 'NonPositiveNet', 'testLossMakingReverts', 'A loss-making opportunity is never committed.'],
  ['bounds', 'Input bounds', 'OutOfBounds', 'testQuoteFieldOutOfBoundsReverts', 'Every quote field and unit count has a hard upper bound, so arithmetic cannot overflow or wrap.'],
  ['payee', 'Allowlisted payees only', 'PayeeNotAllowed', 'testPayeeMustBeAllowlisted', 'Escrow can only be released to addresses the owner approved. The agent cannot pay itself.'],
  ['escrow', 'Cannot pay more than escrowed', 'ExceedsEscrow', 'testCannotPayMoreThanEscrow', 'Payouts are capped by the lot’s remaining escrow.'],
  ['payer', 'Allowlisted payers, real transfer', 'PayerNotAllowed', 'testSettleRequiresAllowlistedPayerAndRealTransfer', 'Settlement pulls the sale proceeds from the owner-approved payer as real tokens on chain, limited by the payer’s balance and allowance. The agent reports the amount, so the contract guarantees the accounting (proceeds paid in are real and counted), not that the reported sale price is true.'],
  ['mint', 'Lots need a committed opportunity', 'UnknownOpportunity', 'testMintRequiresCommittedOpportunity', 'No lot, and so no funds, without passing every check above first.'],
  ['once', 'One lot per opportunity', 'OpportunityConsumed', 'testOpportunityMintsOnlyOnce', 'A committed opportunity can be turned into one lot only.'],
  ['free', 'Only free funds can move', 'InsufficientFree', 'testFundRevertsWhenVaultUnderfunded', 'The vault cannot fund a lot beyond its free balance, and the owner cannot withdraw escrowed money.'],
  ['state', 'Legal lot transitions only', 'BadTransition', 'testIllegalTransitionsRevert', 'A lot moves through a fixed state machine; skipping or reversing a step is refused.'],
  ['auth', 'Roles', 'Unauthorized', 'testOnlyOwnerAdminAndOnlyAgentActions', 'Only the agent can act as agent; only the owner can change policy, payees or withdraw. The owner can only become the agent by replacing it with setAgent, which is on chain.'],
  ['pause', 'Kill switch', 'Paused', 'testPausedBlocksAgent', 'The owner can pause every agent action instantly.'],
] as const).map(([id, rule, error, test, plain]) => ({ id, rule, error, test, plain, demonstrated: demo.has(error) }));
