// Pure helpers for OrderEscrow: status names, money, the order timeline built from chain events, the trust notes, and event fetching
// with an injected client. No React, no JSON import, nothing environment-specific, so it is unit-testable and shared by the
// proof script, the snapshot tool and the /app/orders page.

export const CENT = 10_000n;                       // base units per cent (6-decimal token)
export const STATUS = ['NONE', 'FUNDED', 'OFFERED', 'MATCHED', 'SHIPPED', 'DELIVERED', 'RELEASED', 'CANCELLED', 'REFUNDED', 'DISPUTED'] as const;
export type StatusName = (typeof STATUS)[number];
export const WHY = ['UNACCEPTED', 'REJECTED', 'VERIFIER_RULED', 'UNSHIPPED', 'UNVERIFIED', 'DECLINED'] as const;
export type WhyName = (typeof WHY)[number];
export const RELEASE_WHY = ['BUYER', 'TIMEOUT', 'VERIFIER_RULED', 'UNRESOLVED'] as const;
export type ReleaseWhyName = (typeof RELEASE_WHY)[number];
export const releaseWhyName = (n: number | bigint): ReleaseWhyName => RELEASE_WHY[Number(n)] ?? 'BUYER';
export const RELEASE_TEXT: Record<ReleaseWhyName, string> = {
  BUYER: 'The buyer released the payment.', TIMEOUT: 'The dispute window passed and another address released the payment.',
  VERIFIER_RULED: 'The verifier ruled for the seller after a dispute.', UNRESOLVED: 'The verifier did not rule in time, so the payment went to the seller.',
};
export const RELEASE_LABEL: Record<ReleaseWhyName, string> = {
  BUYER: 'Payment released by the buyer', TIMEOUT: 'Payment released after the dispute window', VERIFIER_RULED: 'Verifier ruled for the seller: payment released', UNRESOLVED: 'Payment released by default: the verifier did not rule in time',
};
export const REFUND_LABEL: Record<WhyName, string> = {
  UNACCEPTED: 'Refunded: offer withdrawn before acceptance', REJECTED: 'Refunded: the verifier did not confirm delivery', VERIFIER_RULED: 'Refunded: the verifier ruled for the buyer',
  UNSHIPPED: 'Refunded: the seller did not ship in time', UNVERIFIED: 'Refunded: the verifier did not answer in time', DECLINED: 'Refunded: the seller declined the offer',
};
export const TERMINAL: readonly StatusName[] = ['RELEASED', 'CANCELLED', 'REFUNDED'];
export const statusName = (n: number | bigint): StatusName => STATUS[Number(n)] ?? 'NONE';
export const whyName = (n: number | bigint): WhyName => WHY[Number(n)] ?? 'UNACCEPTED';
export const isTerminal = (s: StatusName) => TERMINAL.includes(s);

/** Plain words for each state, shown beside the status pill. */
export const STATUS_TEXT: Record<StatusName, string> = {
  NONE: 'No such order', FUNDED: 'Funded, not matched', OFFERED: 'Matched, waiting for the seller', MATCHED: 'Accepted, waiting for shipment', SHIPPED: 'Shipped, waiting for the verifier',
  DELIVERED: 'Delivery attested, dispute window open', RELEASED: 'Paid out to the seller', CANCELLED: 'Cancelled, buyer refunded', REFUNDED: 'Refunded to the buyer', DISPUTED: 'Disputed, waiting for the verifier',
};
export const WHY_TEXT: Record<WhyName, string> = {
  UNACCEPTED: 'The buyer withdrew the offer before the seller accepted, or the seller let it lapse. The seller’s bond was never touched.',
  REJECTED: 'The verifier did not confirm delivery. The buyer got the payment back plus the seller’s bond.',
  VERIFIER_RULED: 'The verifier ruled for the buyer after a dispute. The buyer got the payment back plus the seller’s bond.',
  UNSHIPPED: 'The seller accepted but did not ship in time. The buyer got the payment back plus the seller’s bond.',
  UNVERIFIED: 'The verifier did not answer in time. The buyer got the payment back; the seller got its bond back, not the goods.',
  DECLINED: 'The seller declined the offer. The buyer got the payment back and the seller’s bond was never touched.',
};

// The wording below is shared with docs/order-escrow.md. Keep the two in step.
export const TRUST = {
  verifier: 'The verifier is one address chosen at deployment; it decides whether goods arrived.',
  shipment: 'The shipment hash is reported by the seller agent. The contract does not check it against any carrier or goods.',
  shipTo: 'The ship-to is stored only as a hash computed off chain. The salt and address reach the seller off chain, which is not trustless.',
  concept: 'A cleared BlindBook sell fill is used only as evidence that this seller offered at or below price P in a round that began at or after the buyer funded. It is not an allocation of goods: those units were already sold to the BlindBook buyer and are not redeemable. The units are operator-issued, so the operator controls who can become a seller, and a seller may also be a bidder in that round, so P is not an independent market price. The buyer chooses the round; the buyer’s own cap (maxPriceCents) is the real price guard. The consumed counter only stops one fill from backing two escrow orders; consumed is counted within this escrow contract only. The seller’s acceptance, the bond and the named verifier are the only guards on delivery.',
  proof: 'The proof used script-controlled wallets and operator-issued test units. No physical goods moved: the delivery was attested by the verifier.',
  verifierAddress: 'A verifier acting through another address, as a buyer or a seller, can direct any outcome, including a seller’s bond, to itself: the verifier is a trusted party.',
  token: 'mUSDG is a testnet stand-in token with no value.',
} as const;

// money
export const asBig = (x: bigint | number | string): bigint => BigInt(x);
const group = (s: string) => s.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
/** Base units of the 6-decimal token -> "12.34" (at least 2 decimals, up to 6, trailing zeros beyond 2 dropped). */
export function fmtAmount(base: bigint | number | string): string {
  const b = asBig(base); const neg = b < 0n; const a = neg ? -b : b;
  const whole = a / 1_000_000n; let frac = (a % 1_000_000n).toString().padStart(6, '0');
  while (frac.length > 2 && frac.endsWith('0')) frac = frac.slice(0, -1);
  return (neg ? '-' : '') + group(whole.toString()) + '.' + frac;
}
/** "12.34 mUSDG". */
export const fmtMusdc = (base: bigint | number | string) => `${fmtAmount(base)} mUSDG`;
/** A per-unit price in cents (the BlindBook unit) -> "10.99 mUSDG". */
export const fmtPrice = (cents: bigint | number | string) => fmtMusdc(asBig(cents) * CENT);
export const fundedFor = (maxPriceCents: bigint | number, qty: bigint | number) => asBig(maxPriceCents) * asBig(qty) * CENT;
export const paymentFor = (priceCents: bigint | number, qty: bigint | number) => asBig(priceCents) * asBig(qty) * CENT;
/** The seller bond: price * qty * CENT * bondBps / 10000, rounded up (mirrors OrderEscrow.bondNeeded). */
export const bondFor = (priceCents: bigint | number, qty: bigint | number, bondBps: bigint | number) => (asBig(priceCents) * asBig(qty) * CENT * asBig(bondBps) + 9999n) / 10_000n;
/** Seconds as a short length: "45 s", "15 min", "2 h", "3 days". */
export function fmtDuration(sec: number | bigint): string {
  const n = Number(sec);
  if (n < 120) return `${n} s`; if (n < 7200) return `${Math.round(n / 60)} min`; if (n < 172_800) return `${Math.round(n / 3600)} h`; return `${Math.round(n / 86_400)} days`;
}
export const shortHex = (h: string, a = 6, b = 4) => (h.length > a + b + 2 ? `${h.slice(0, a + 2)}…${h.slice(-b)}` : h);
/** "2026-10-03 14:05 UTC": fixed format so server and browser render the same text. */
export const fmtTime = (unix: number) => new Date(unix * 1000).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';

// events
export type EventArgs = Record<string, string | number | boolean>;
/** One OrderEscrow log in a JSON-safe shape (bigint arguments become decimal strings). */
export type EscrowEvent = { name: string; args: EventArgs; tx: string; block: number; logIndex: number; time?: number };
const ORDER_EVENT_NAMES = ['OrderCreated', 'Cancelled', 'Offered', 'Accepted', 'Shipped', 'Attested', 'Disputed', 'Released', 'Refunded'];
const lc = (s: unknown) => String(s).toLowerCase();

export function serializeEvent(l: { eventName: string; args: Record<string, unknown>; transactionHash: string; blockNumber: bigint | number; logIndex: number }): EscrowEvent {
  const args: EventArgs = {};
  for (const [k, v] of Object.entries(l.args ?? {})) args[k] = typeof v === 'bigint' ? v.toString() : (v as string | number | boolean);
  return { name: l.eventName, args, tx: l.transactionHash, block: Number(l.blockNumber), logIndex: l.logIndex };
}
const order = (a: EscrowEvent, b: EscrowEvent) => a.block - b.block || a.logIndex - b.logIndex;
/** Union of two event lists, de-duplicated by (tx, logIndex), in chain order. A later copy keeps any `time` the earlier one lacks. */
export function mergeEvents(a: EscrowEvent[], b: EscrowEvent[]): EscrowEvent[] {
  const m = new Map<string, EscrowEvent>();
  for (const e of [...a, ...b]) { const k = `${lc(e.tx)}:${e.logIndex}`; const prev = m.get(k); m.set(k, prev ? { ...prev, ...e, time: e.time ?? prev.time } : e); }
  return [...m.values()].sort(order);
}
export const eventsOfOrder = (events: EscrowEvent[], id: number | string) => events.filter((e) => ORDER_EVENT_NAMES.includes(e.name) && String(e.args.id) === String(id)).sort(order);
/** Order ids in the order they were created. */
export const orderIds = (events: EscrowEvent[]) => events.filter((e) => e.name === 'OrderCreated').sort(order).map((e) => Number(e.args.id));

// summary of one order, derived from its events
export type OrderSummary = {
  id: number; buyer: string; seller?: string; qty: number; maxPriceCents: number; priceCents?: number; status: StatusName; why?: WhyName;
  releaseWhy?: ReleaseWhyName; funded: bigint; payment?: bigint; buyerRefund?: bigint; bond?: bigint; bondToBuyer?: bigint; shipToHash?: string; shipmentHash?: string; receiptHash?: string;
  matchEpoch?: number; matchIndex?: number; matchBy?: number; acceptBy?: number; shipBy?: number; verifyBy?: number; releaseAfter?: number; resolveBy?: number;
};
export function summarize(id: number | string, events: EscrowEvent[]): OrderSummary | null {
  const evs = eventsOfOrder(events, id); const created = evs.find((e) => e.name === 'OrderCreated'); if (!created) return null;
  const s: OrderSummary = { id: Number(id), buyer: String(created.args.buyer), qty: Number(created.args.qty), maxPriceCents: Number(created.args.maxPriceCents), status: 'FUNDED', funded: asBig(created.args.funded as string), shipToHash: String(created.args.shipToHash), matchBy: Number(created.args.matchBy) };
  for (const e of evs) {
    const a = e.args;
    switch (e.name) {
      case 'Cancelled': s.status = 'CANCELLED'; break;
      case 'Offered': s.status = 'OFFERED'; s.seller = String(a.seller); s.matchEpoch = Number(a.epoch); s.matchIndex = Number(a.index); s.priceCents = Number(a.priceCents); s.acceptBy = Number(a.acceptBy); break;
      case 'Accepted': s.status = 'MATCHED'; s.bond = asBig(a.bond as string); s.shipBy = Number(a.shipBy); break;
      case 'Shipped': s.status = 'SHIPPED'; s.shipmentHash = String(a.shipmentHash); s.verifyBy = Number(a.verifyBy); break;
      case 'Attested': s.receiptHash = String(a.receiptHash); if (a.delivered) { s.status = 'DELIVERED'; s.releaseAfter = Number(a.releaseAfter); } break;
      case 'Disputed': s.status = 'DISPUTED'; s.resolveBy = Number(a.resolveBy); break;
      case 'Released': s.status = 'RELEASED'; s.payment = asBig(a.paid as string); s.buyerRefund = asBig(a.refundedToBuyer as string); s.releaseWhy = releaseWhyName(Number(a.why)); break;
      case 'Refunded': s.status = 'REFUNDED'; s.why = whyName(Number(a.why)); s.buyerRefund = asBig(a.refund as string); s.bondToBuyer = asBig(a.bondToBuyer as string); break;
    }
  }
  return s;
}

/** What the order is waiting for and until when, or null once it is in a final state. */
export function awaiting(s: OrderSummary): { text: string; deadline?: number } | null {
  switch (s.status) {
    case 'FUNDED': return { text: 'Waiting for the buyer to match this order to a cleared sell fill', deadline: s.matchBy };
    case 'OFFERED': return { text: 'Waiting for the seller to accept', deadline: s.acceptBy };
    case 'MATCHED': return { text: 'Waiting for the seller to ship', deadline: s.shipBy };
    case 'SHIPPED': return { text: 'Waiting for the verifier to attest', deadline: s.verifyBy };
    case 'DELIVERED': return { text: 'Dispute window open: the buyer can dispute or release now, and after the deadline anyone can release the payment', deadline: s.releaseAfter };
    case 'DISPUTED': return { text: 'Waiting for the verifier to rule', deadline: s.resolveBy };
    default: return null;
  }
}

// timeline
export type TimelineStep = {
  key: string; label: string; detail: string;
  /** onchain: the contract enforced or recorded it. agent: reported by the seller agent, not checked by the contract. */
  provenance: 'onchain' | 'agent';
  tx: string; at: number; time?: number; actor?: string; note?: string;
  /** For a release or refund: the contract's reason code (ReleaseWhy or Why). */
  reason?: string;
};
/** Anything with the fields buildTimeline reads: the summary above, or the contract's getOrder() result mapped to numbers. */
export type OrderLike = { qty: number | bigint };

/**
 * The ordered steps of one order. `events` are the order's logs (any other order's logs are ignored).
 * Every step is a transaction on chain; only the shipment hash is marked agent-attested.
 */
export function buildTimeline(order: OrderLike | null, events: EscrowEvent[], opts: { verifier?: string; id?: number | string } = {}): TimelineStep[] {
  const id = opts.id ?? events.find((e) => e.name === 'OrderCreated')?.args.id;
  const evs = id === undefined ? [] : eventsOfOrder(events, id);
  const qty = order ? Number(order.qty) : Number(evs.find((e) => e.name === 'OrderCreated')?.args.qty ?? 0);
  const out: TimelineStep[] = [];
  for (const e of evs) {
    const a = e.args; const base = { tx: e.tx, at: e.block, time: e.time };
    switch (e.name) {
      case 'OrderCreated': out.push({ ...base, key: 'created', provenance: 'onchain', actor: String(a.buyer), label: 'Order funded',
        detail: `The buyer locked ${fmtMusdc(a.funded as string)} for ${a.qty} unit${Number(a.qty) === 1 ? '' : 's'}, with a cap of ${fmtPrice(a.maxPriceCents as string)} per unit.`, note: TRUST.shipTo }); break;
      case 'Cancelled': out.push({ ...base, key: 'cancelled', provenance: 'onchain', actor: String(a.caller),
        detail: `${fmtMusdc(a.refund as string)} went back to the buyer${lc(a.caller) === lc(a.buyer) ? '.' : ', released by another address after the match deadline.'}` , label: 'Order cancelled' }); break;
      case 'Offered': out.push({ ...base, key: 'matched', provenance: 'onchain', actor: String(a.seller), label: 'Matched to a cleared sell fill',
        detail: `Round ${a.epoch}, order #${a.index}, price ${fmtPrice(a.priceCents as string)} per unit${qty ? ` for ${qty} unit${qty === 1 ? '' : 's'}` : ''}. The seller has until ${fmtTime(Number(a.acceptBy))} to accept.`, note: 'The fill is evidence of an offer at or below this price. It is not an allocation of goods.' }); break;
      case 'Accepted': out.push({ ...base, key: 'accepted', provenance: 'onchain', actor: String(a.seller), label: 'Seller accepted and locked a bond',
        detail: `Bond ${fmtMusdc(a.bond as string)}. The seller must ship by ${fmtTime(Number(a.shipBy))}.` }); break;
      case 'Shipped': out.push({ ...base, key: 'shipped', provenance: 'agent', actor: String(a.seller), label: 'Seller reported a shipment',
        detail: `Shipment hash ${shortHex(String(a.shipmentHash), 10, 6)}. The verifier has until ${fmtTime(Number(a.verifyBy))}.`, note: TRUST.shipment }); break;
      case 'Attested': out.push(a.delivered
        ? { ...base, key: 'attested', provenance: 'onchain', actor: opts.verifier, label: 'Verifier attested delivery', detail: `Receipt hash ${shortHex(String(a.receiptHash), 10, 6)}. The buyer can dispute until ${fmtTime(Number(a.releaseAfter))}.`, note: TRUST.verifier }
        : { ...base, key: 'attested', provenance: 'onchain', actor: opts.verifier, label: 'Verifier did not confirm delivery', detail: `Receipt hash ${shortHex(String(a.receiptHash), 10, 6)}. The order is refunded.`, note: TRUST.verifier }); break;
      case 'Disputed': out.push({ ...base, key: 'disputed', provenance: 'onchain', actor: String(a.buyer), label: 'Buyer disputed delivery', detail: `The verifier has until ${fmtTime(Number(a.resolveBy))} to rule.` }); break;
      case 'Released': { const rw = releaseWhyName(Number(a.why));
        out.push({ ...base, key: 'released', provenance: 'onchain', actor: String(a.caller), reason: rw, label: RELEASE_LABEL[rw],
          detail: `The seller received ${fmtMusdc(a.paid as string)}; the buyer got ${fmtMusdc(a.refundedToBuyer as string)} back (cap minus price); the seller’s ${fmtMusdc(a.bondReturned as string)} bond was returned. ${RELEASE_TEXT[rw]}`,
          note: rw === 'UNRESOLVED' ? 'This is the default when the verifier stays silent after a dispute: it favours the seller. It is not a ruling.' : undefined }); break; }
      case 'Refunded': { const why = whyName(Number(a.why)); out.push({ ...base, key: 'refunded', provenance: 'onchain', actor: String(a.buyer), reason: why, label: REFUND_LABEL[why],
        detail: `${fmtMusdc(a.refund as string)} returned to the buyer${asBig(a.bondToBuyer as string) > 0n ? `, plus ${fmtMusdc(a.bondToBuyer as string)} of the seller’s bond` : ''}${asBig(a.bondToSeller as string) > 0n ? `; ${fmtMusdc(a.bondToSeller as string)} bond back to the seller` : ''}. ${WHY_TEXT[why]}` }); break; }
    }
  }
  return out;
}

// fetching logs (client injected so tests need no network)
type LogClient = { getContractEvents(args: any): Promise<any[]>; getBlock?(args: any): Promise<{ timestamp: bigint }> };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/**
 * Every OrderEscrow log between two blocks. The public RPC refuses a query that matches too many logs: that case is split in two.
 * Any other error is retried with backoff and then thrown, so the caller can fall back to the snapshot.
 */
export async function fetchEscrowEvents(client: LogClient, p: { address: string; abi: readonly unknown[]; from: bigint; to: bigint; retries?: number; backoffMs?: number }): Promise<EscrowEvent[]> {
  const retries = p.retries ?? 3;
  for (let attempt = 0; ; attempt++) {
    try {
      const logs = await client.getContractEvents({ address: p.address, abi: p.abi, fromBlock: p.from, toBlock: p.to });
      return logs.filter((l) => l.eventName).map(serializeEvent).sort(order);
    } catch (e: any) {
      const msg = String(e?.message ?? e) + String(e?.details ?? '');
      if (p.to > p.from && /limit|too many|exceed|more than/i.test(msg)) {
        const mid = p.from + (p.to - p.from) / 2n;
        return [...(await fetchEscrowEvents(client, { ...p, to: mid })), ...(await fetchEscrowEvents(client, { ...p, from: mid + 1n }))];
      }
      if (attempt >= retries) throw e;
      await sleep((p.backoffMs ?? 400) * (attempt + 1));
    }
  }
}
/** Fills in `time` (block timestamp, unix seconds) for events that lack it. Reads each distinct block once. */
export async function attachTimes(client: LogClient, events: EscrowEvent[]): Promise<EscrowEvent[]> {
  if (!client.getBlock) return events;
  const times = new Map<number, number>();
  for (const e of events) if (e.time !== undefined) times.set(e.block, e.time);
  for (const b of new Set(events.filter((e) => e.time === undefined).map((e) => e.block))) if (!times.has(b)) times.set(b, Number((await client.getBlock({ blockNumber: BigInt(b) })).timestamp));
  return events.map((e) => ({ ...e, time: e.time ?? times.get(e.block) }));
}
