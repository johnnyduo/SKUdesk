// Build-time market model for /app/radar and /app/opportunities.
// Everything here is computed from the recorded files (run.json, snapshot.json) and the real matching package.
// Nothing is random, seeded or invented. Imported by Astro frontmatter only; hydrated islands get plain props.
import { keccak256, encodeAbiParameters } from 'viem';
import { matchOffer } from '../../../../../packages/matching/index.js';
import { RUN, SNAPSHOT, ECON, GUARDS, GATES, FAILED_TX, TXS, usdCents, pct, type Offer } from '../../lib/run';

// The canonical SKU the owner's mandate targets. Same object tools/run-demo.ts hands to the gates.
export const CANON = {
  brand: 'Apple-compatible',
  model: 'iPhone 16 Pro Clear MagSafe Case',
  compatibility: 'iPhone 16 Pro',
  color: 'Clear',
  packCount: 1,
  gtin: '850063102441',
  attributes: { magsafe: 'Yes' },
};
export const PRODUCT_NAME = CANON.model;
export const PRODUCT_ID = 'CASE-IP16PRO-CLEAR-MAG-001';

// gates, one verdict per snapshot offer
export type GateView = { gate: string; label: string; expected: string; observed: string; pass: boolean; hard: boolean };
export type Role = 'BUY' | 'SELL' | null;
export type Row = {
  id: string; source: string; title: string; seller: string; priceCents: number; shipCents: number; stock: number; gtin?: string;
  device: string; image: string | null; side: 'supply' | 'demand'; role: Role;
  locked: boolean; gates: GateView[]; failing: GateView[]; evidence: string;
};
const GATE_LABEL: Record<string, string> = { brand: 'brand', compatibility: 'model', packCount: 'pack', magsafe: 'magsafe', gtin: 'gtin', color: 'color' };
export const GATE_GLOSS: Record<string, string> = {
  compatibility: 'Which phone the case fits. Must be exactly the target model, not another generation or a Pro Max.',
  packCount: 'How many cases are in the listing. The target is a single case, so a 2-pack is a different product.',
  magsafe: 'Whether the case has the MagSafe magnet ring the target product has.',
  gtin: 'The barcode number. When both listings carry one, they must be identical.',
  color: 'The colour must not conflict with the target (Clear).',
  brand: 'Informational only: brand aliases are normalised, so this never rejects on its own.',
};
const KNOWN_SLUGS = new Set(['iphone-16', 'iphone-16-pro', 'iphone-16-pro-max', 'galaxy-s25', 'pixel-9']);
const slug = (s: string) => s.toLowerCase().replace(/\s+/g, '-');
// Vector artwork of the case variant. No artwork exists for iPhone 15 Pro, so that row gets a text tile instead of a wrong picture.
function imageFor(o: Offer): string | null {
  const dev = slug(o.attributes.device ?? '');
  if (!KNOWN_SLUGS.has(dev)) return null;
  return `/img/cases/${dev}_clear_${o.attributes.magsafe === 'Yes' ? 'mag' : 'plain'}_${o.attributes.pack === '2-pack' ? 2 : 1}.svg`;
}
const fmtObserved = (g: { gate: string; observed: string }) => (g.gate === 'brand' ? 'n/a' : g.observed);

export const ROWS: Row[] = SNAPSHOT.offers
  .map((o): Row => {
    const v = matchOffer(CANON, { title: o.title, attributes: o.attributes, gtin: o.gtin });
    const gates: GateView[] = v.gates.map((g) => ({ gate: g.gate, label: GATE_LABEL[g.gate] ?? g.gate, expected: g.expected, observed: fmtObserved(g), pass: g.pass, hard: g.hard }));
    const failing = gates.filter((g) => !g.pass);
    const gtin = gates.find((g) => g.gate === 'gtin')!;
    const evidence = failing.length
      ? failing.map((g) => `${g.label}: expected ${g.expected}, observed ${g.observed}`).join(' · ')
      : gtin.hard ? `all hard gates pass, barcode ${gtin.observed} matches` : 'all hard gates pass (no barcode on this listing)';
    return {
      id: o.id, source: o.source, title: o.title, seller: o.seller, priceCents: o.priceCents, shipCents: o.shipCents, stock: o.stock, gtin: o.gtin,
      device: o.attributes.device ?? 'unknown', image: imageFor(o),
      // The snapshot has no explicit side field. Listings that charge freight are treated as supply to buy from, free-shipping retail listings as demand to sell into.
      side: o.shipCents > 0 ? 'supply' : 'demand',
      role: o.id === RUN.accepted.buyOfferId ? 'BUY' : o.id === RUN.accepted.sellOfferId ? 'SELL' : null,
      locked: v.locked, gates, failing, evidence,
    };
  })
  .sort((a, b) => a.priceCents - b.priceCents);

export const BUY_ROW = ROWS.find((r) => r.role === 'BUY')!;
export const SELL_ROW = ROWS.find((r) => r.role === 'SELL')!;
export const LOCKED_COUNT = ROWS.filter((r) => r.locked).length;
export const REJECTED_COUNT = ROWS.length - LOCKED_COUNT;
export const BUY_ALL_IN = BUY_ROW.priceCents + BUY_ROW.shipCents; // price + shipping, cents
export const GROSS_SPREAD_CENTS = SELL_ROW.priceCents - ECON.landedCents; // sell price minus landed cost per unit

// The two gate events the run itself recorded (for the chosen legs). Used to confirm this page agrees with the run.
export const RUN_GATE_AGREES = GATES.every((g) => {
  const row = ROWS.find((r) => r.id === g.data.offerId);
  return !!row && row.locked === g.data.locked;
});

// how tempting is each rejected offer
export type Trap = { row: Row; gapCents: number; gapText: string; why: string };
export const TRAPS: Trap[] = ROWS.filter((r) => !r.locked).map((row) => {
  if (row.side === 'supply') {
    const gap = BUY_ALL_IN - (row.priceCents + row.shipCents);
    return { row, gapCents: gap, gapText: `${usdCents(Math.abs(gap))} ${gap >= 0 ? 'cheaper' : 'dearer'} than the chosen supplier (price plus shipping)`, why: 'Looks like a bargain, but it is a different product.' };
  }
  const gap = row.priceCents - SELL_ROW.priceCents;
  return { row, gapCents: gap, gapText: `pays ${usdCents(Math.abs(gap))} ${gap >= 0 ? 'more' : 'less'} per unit than the chosen sale listing`, why: 'Looks like better revenue, but it is a different product.' };
});
export const bySavings = (a: Trap, b: Trap) => b.gapCents - a.gapCents;

// proofs recomputed at build time
const enc = (s: string) => new TextEncoder().encode(s);
export const PRODUCT_HASH = keccak256(enc(PRODUCT_ID));
// Quote exactly as the run committed it: offer prices from the snapshot, fixed per-unit assumptions from tools/run-demo.ts.
export const QUOTE_FIELDS: { key: string; label: string; value: bigint; unit: 'cents' | 'bps'; from: string }[] = [
  { key: 'purchaseCents', label: 'Buy price', value: BigInt(BUY_ROW.priceCents), unit: 'cents', from: `offer ${BUY_ROW.id}` },
  { key: 'shipCents', label: 'Inbound shipping', value: BigInt(BUY_ROW.shipCents), unit: 'cents', from: `offer ${BUY_ROW.id}` },
  { key: 'dutyCents', label: 'Import duty', value: 12n, unit: 'cents', from: 'fixed assumption' },
  { key: 'taxCents', label: 'Tax', value: 8n, unit: 'cents', from: 'fixed assumption' },
  { key: 'procFeeCents', label: 'Procurement fee', value: 5n, unit: 'cents', from: 'fixed assumption' },
  { key: 'payFeeCents', label: 'Payment fee', value: 2n, unit: 'cents', from: 'fixed assumption' },
  { key: 'sellCents', label: 'Sell price', value: BigInt(SELL_ROW.priceCents), unit: 'cents', from: `offer ${SELL_ROW.id}` },
  { key: 'mktFeeBps', label: 'Marketplace fee', value: 800n, unit: 'bps', from: 'fixed assumption' },
  { key: 'fulfillCents', label: 'Fulfilment', value: 65n, unit: 'cents', from: 'fixed assumption' },
  { key: 'retBps', label: 'Return reserve', value: 200n, unit: 'bps', from: 'fixed assumption' },
  { key: 'chainCents', label: 'On-chain cost', value: 4n, unit: 'cents', from: 'fixed assumption' },
];
export const QUOTE_HASH = keccak256(encodeAbiParameters(Array(11).fill({ type: 'uint256' }), QUOTE_FIELDS.map((f) => f.value)));
export const SNAPSHOT_HASH_RECOMPUTED = keccak256(enc(JSON.stringify(SNAPSHOT)));
export const SNAPSHOT_HASH_OK = SNAPSHOT_HASH_RECOMPUTED.toLowerCase() === RUN.meta.snapshotHash.toLowerCase();
export const OPP_HASH_RECOMPUTED = keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'bytes32' }, { type: 'bytes32' }], [PRODUCT_HASH, QUOTE_HASH, RUN.meta.snapshotHash as `0x${string}`]));
export const OPP_HASH_OK = OPP_HASH_RECOMPUTED.toLowerCase() === RUN.meta.oppHash.toLowerCase();
// The BadQuoteHash attack in the run reports the hash the contract expected; it must equal the one recomputed here.
export const QUOTE_HASH_SEEN_ON_CHAIN = (RUN.attacks.find((a) => a.error === 'BadQuoteHash')?.args[0] as string | undefined) ?? null;
export const QUOTE_HASH_OK = QUOTE_HASH_SEEN_ON_CHAIN ? QUOTE_HASH_SEEN_ON_CHAIN.toLowerCase() === QUOTE_HASH.toLowerCase() : null;
export const OPP_SLUG = RUN.meta.oppHash.slice(2, 10);

// the committed transactions around the opportunity
export const COMMIT_TX = TXS.find((t) => t.title.startsWith('commitOpportunity'))!;
export const MINT_TX = TXS.find((t) => t.title.startsWith('mintLot'))!;
export const FUND_TX = TXS.find((t) => t.title.startsWith('fundLot'))!;

// glosses for the integer-cent proof lines
const bps = ECON.marginBps;
export function glossProof(label: string): string {
  const sell = SELL_ROW.priceCents;
  switch (label) {
    case 'landed': return 'Everything it costs to put one unit in stock: buy price, shipping, duty, tax, procurement fee and payment fee, added up in whole cents.';
    case 'marketplaceFee': return `The marketplace keeps 8% (800 bps; 1 bps = 0.01%) of the ${usdCents(sell)} sell price. Rounded up to the next cent, so rounding never flatters the result.`;
    case 'returnReserve': return `2% (200 bps) of the sell price is set aside for returns. Also rounded up.`;
    case 'net': return `What one unit really earns: sell price minus marketplace fee, fulfilment, return reserve, landed cost and on-chain cost. This is the number the agent must report and the contract re-derives.`;
    case 'marginBps': return `Net as a share of the sell price, rounded down. ${bps} bps = ${pct(bps)}, against the owner's floor of ${pct(RUN.policy.minMarginBps)}.`;
    case 'totalCost': case 'breakeven': return `All costs per unit added up, with fees taken at this sell price. The true break-even price is a little lower, because fees fall with the price.`;
    default: return '';
  }
}
export const proofValue = (label: string, resultCents: number) => (label === 'marginBps' ? `${resultCents} bps · ${pct(resultCents)}` : usdCents(resultCents));

// what the contract checks in commitOpportunity, in the order the Solidity runs them
export type Check = { error: string; title: string; plain: string; test: string; value: string; demonstrated: boolean; attack?: string; attackTx?: string };
const g = (e: string) => GUARDS.find((x) => x.error === e)!;
const spend = ECON.spendCents;
const VALUES: [string, string, string][] = [
  ['Unauthorized', 'Caller is the agent', `sent by ${RUN.meta.agent.slice(0, 8)}…${RUN.meta.agent.slice(-4)}, the registered agent`],
  ['Paused', 'Owner has not paused the vault', 'vault was running'],
  ['BadQuoteHash', 'Quote matches its hash', `keccak256 of the 11 quote fields = ${QUOTE_HASH.slice(0, 10)}…${QUOTE_HASH.slice(-4)}`],
  ['FutureObservation', 'Observation is not from the future', 'observed at or before the block time'],
  ['Replay', 'Opportunity is new', `oppHash ${RUN.meta.oppHash.slice(0, 10)}…${RUN.meta.oppHash.slice(-4)} derived on-chain, not seen before`],
  ['Stale', 'Quote is inside the freshness window', `inside the owner's ${RUN.policy.quoteTTL}s window, by the observation time the agent supplied`],
  ['OutOfBounds', 'Inputs inside hard bounds', `${ECON.units} units; every quote field is small enough that arithmetic cannot wrap`],
  ['SpendCap', 'Spend under the per-trade cap', `${usdCents(spend)} (${ECON.landedCents}¢ × ${ECON.units}) ≤ ${usdCents(RUN.policy.maxExec)}`],
  ['DailyCap', 'Commitments under the daily cap', `${usdCents(RUN.end.spentToday)} committed today ≤ ${usdCents(RUN.policy.dailySpendCap)}`],
  ['MathMismatch', 'Agent’s claimed economics equal the derived ones', `claimed ${usdCents(ECON.netCents)} and ${pct(ECON.marginBps)} = derived ${usdCents(ECON.netCents)} and ${pct(ECON.marginBps)}`],
  ['NonPositiveNet', 'Net is positive', `${usdCents(ECON.netCents)} per unit > $0.00`],
  ['MarginTooLow', 'Margin clears the floor', `${pct(ECON.marginBps)} ≥ ${pct(RUN.policy.minMarginBps)}`],
];
export const CHECKS: Check[] = VALUES.map(([error, title, value]) => {
  const guard = g(error);
  const atk = RUN.attacks.find((a) => a.error === error);
  return {
    error, title, value, plain: guard.plain, test: guard.test, demonstrated: guard.demonstrated, attack: atk?.sentence,
    attackTx: error === 'MathMismatch' && FAILED_TX ? FAILED_TX.tx.hash : undefined,
  };
});

export const NO_PROPOSAL_REJECTED = !RUN.events.some((e) => e.kind === 'reject');
export const fmtCaptured = (iso: string) => new Date(iso).toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
