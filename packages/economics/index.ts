// packages/economics - integer-cent unit economics. NO floats in money math.
// Rounding: costs round UP (ceil), profit/margin round DOWN (floor). Never overstates profit.
// Mirrors contracts/src/EconLib.sol operation-for-operation.
export type EconInputCents = { purchaseCents: number; inboundShipCents: number; importDutyCents: number; taxCents: number; procurementFeeCents: number; paymentFeeCents: number; sellCents: number; marketplaceFeeBps: number; fulfillmentCents: number; returnReserveBps: number; chainCostCents: number; units: number; fixedBatchCents: number; };
export type ProofLine = { label: string; formula: string; resultCents: number };
export type EconResult = { landedCents: number; mktFeeCents: number; retCents: number; netCents: number; marginBps: number; roiBps: number; breakevenCents: number; maxBuyCents: number; breakEvenBuyCents: number; batchCents: number; grossCents: number; capitalCents: number; proof: ProofLine[]; };
const ceilDiv = (a: number, b: number) => Math.floor((a + b - 1) / b);
const bpsOf = (base: number, bps: number) => ceilDiv(base * bps, 10000);
// Theorem E7: this Number mirror equals EconLib exactly only for sellCents <= 9e11 (the contract accepts up to 1e12; finding F-E1).
// Above that limit it would silently differ by a cent, so it refuses instead of returning a wrong figure.
export const TS_EXACT_MAX_SELL_CENTS = 9e11;
export function economics(c: EconInputCents): EconResult {
  if (c.sellCents > TS_EXACT_MAX_SELL_CENTS) throw new RangeError('sellCents above 9e11 is outside the exact TS domain');
  const proof: ProofLine[] = [];
  const landedCents = c.purchaseCents + c.inboundShipCents + c.importDutyCents + c.taxCents + c.procurementFeeCents + c.paymentFeeCents;
  proof.push({ label: 'landed', formula: c.purchaseCents+'+'+c.inboundShipCents+'+'+c.importDutyCents+'+'+c.taxCents+'+'+c.procurementFeeCents+'+'+c.paymentFeeCents, resultCents: landedCents });
  const mktFeeCents = bpsOf(c.sellCents, c.marketplaceFeeBps);
  proof.push({ label: 'marketplaceFee', formula: 'ceil('+c.sellCents+'*'+c.marketplaceFeeBps+'/10000)', resultCents: mktFeeCents });
  const retCents = bpsOf(c.sellCents, c.returnReserveBps);
  proof.push({ label: 'returnReserve', formula: 'ceil('+c.sellCents+'*'+c.returnReserveBps+'/10000)', resultCents: retCents });
  const netCents = c.sellCents - mktFeeCents - c.fulfillmentCents - retCents - landedCents - c.chainCostCents;
  proof.push({ label: 'net', formula: c.sellCents+'-'+mktFeeCents+'-'+c.fulfillmentCents+'-'+retCents+'-'+landedCents+'-'+c.chainCostCents, resultCents: netCents });
  // EconLib.sol returns 0 for negative net; clamp to match.
  const marginBps = c.sellCents > 0 && netCents > 0 ? Math.floor((netCents * 10000) / c.sellCents) : 0;
  proof.push({ label: 'marginBps', formula: 'floor('+netCents+'*10000/'+c.sellCents+')', resultCents: marginBps });
  const roiBps = landedCents > 0 ? Math.floor((netCents * 10000) / landedCents) : 0;
  const breakevenCents = landedCents + mktFeeCents + c.fulfillmentCents + retCents + c.chainCostCents;
  proof.push({ label: 'breakeven', formula: landedCents+'+'+mktFeeCents+'+'+c.fulfillmentCents+'+'+retCents+'+'+c.chainCostCents, resultCents: breakevenCents });
  const otherLanded = landedCents - c.purchaseCents;
  // maxBuyCents mirrors EconLib.maxBuy for parity only. It is NOT the break-even purchase price (finding F-E2) and is not displayed.
  const maxBuyCents = breakevenCents > otherLanded ? breakevenCents - otherLanded : 0;
  // Exact break-even purchase price: purchase enters landed one-for-one and no fee depends on it, so net(p') = net(p) - (p' - p).
  // net is 0 at purchase + net, and -1 one cent higher. 0 when no purchase price reaches break-even. Display only.
  const breakEvenBuyCents = Math.max(0, c.purchaseCents + netCents);
  const batchCents = netCents * c.units - c.fixedBatchCents;
  const capitalCents = landedCents * c.units;
  return { landedCents, mktFeeCents, retCents, netCents, marginBps, roiBps, breakevenCents, maxBuyCents, breakEvenBuyCents, batchCents, grossCents: c.sellCents - c.purchaseCents, capitalCents, proof };
}
export function verifyProof(c: EconInputCents, r: EconResult) {
  const fresh = economics(c);
  const lines = r.proof.map((p) => { const f = fresh.proof.find((x) => x.label === p.label); const actual = f ? f.resultCents : NaN; return { label: p.label, expected: p.resultCents, actual, pass: actual === p.resultCents }; });
  const scalar: [string, number, number][] = [['marginBps', r.marginBps, fresh.marginBps], ['roiBps', r.roiBps, fresh.roiBps], ['batchCents', r.batchCents, fresh.batchCents], ['capitalCents', r.capitalCents, fresh.capitalCents]];
  for (const [label, expected, actual] of scalar) lines.push({ label, expected, actual, pass: expected === actual });
  return { ok: lines.every((l) => l.pass), lines };
}
export const fmtUSD = (cents: number) => '$' + (cents / 100).toFixed(2);
export const fmtBps = (bps: number) => (bps / 100).toFixed(2) + '%';
// Back-compat float wrapper (deprecated, routes to cents)
export function economicsFloat(i: any) { const c = (d: number) => Math.round(d * 100); return economics({ purchaseCents: c(i.purchasePrice), inboundShipCents: c(i.inboundShipping), importDutyCents: c(i.importDuty), taxCents: c(i.tax), procurementFeeCents: c(i.procurementFee), paymentFeeCents: c(i.paymentFee), sellCents: c(i.sellPrice), marketplaceFeeBps: Math.round(i.marketplaceFeeRate * 10000), fulfillmentCents: c(i.fulfillment), returnReserveBps: Math.round(i.returnReserveRate * 10000), chainCostCents: c(i.chainCost), units: i.units, fixedBatchCents: c(i.fixedBatch) }); }
