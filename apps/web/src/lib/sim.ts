// The simulate-commit routine, with its dependencies injected so it can be unit tested without a browser, run.json or a live RPC.
// chain.ts wires it to the real viem client, the real economics library and the deployed addresses.
import { keccak256, encodeAbiParameters, BaseError, ContractFunctionRevertedError } from 'viem';
import { explain } from './explain.ts';

export type SimInput = { buyCents: number; shipCents: number; sellCents: number; units: number; lieNetCents?: number; ageSeconds?: number };
export type SimDerived = { landed: number; net: number; marginBps: number; spendCents: number };
export type SimResult =
  | { accepted: true; net: number; marginBps: number; spendCents: number; derived: SimDerived }
  // `derived` is absent when the input is beyond the range the TypeScript library can compute exactly (the contract's own bounds check still ran).
  | { accepted: false; error: string; args: any[]; sentence: string; derived?: SimDerived };

/** The contract's per-field hard bound (SKUdeskCore MAX_FIELD). Above this the contract reverts OutOfBounds before any arithmetic. */
export const CONTRACT_MAX_FIELD = 1e12;
/** The TypeScript economics mirror is exact only up to here (packages/economics TS_EXACT_MAX_SELL_CENTS, finding F-E1). */
export const EXACT_MAX_SELL_CENTS = 9e11;
export const RANGE_MESSAGE = 'Outside the range this page can check exactly (above $9,000,000,000). The contract would still evaluate it; try a smaller sell price.';

/** Not an RPC failure: the page declined to compute a figure it cannot guarantee. Callers must never report it as "RPC unreachable". */
export class SimOutOfRange extends Error {
  code = 'range' as const;
  constructor() { super(RANGE_MESSAGE); this.name = 'SimOutOfRange'; }
}

type Econ = { landedCents: number; netCents: number; marginBps: number };
export type SimDeps = {
  economics: (c: any) => Econ;
  client: { getBlock(): Promise<{ timestamp: bigint }>; simulateContract(args: any): Promise<unknown> };
  core: `0x${string}`;
  agent: `0x${string}`;
  abi: any;
};

const PRODUCT_HASH = keccak256(new TextEncoder().encode('CASE-IP16PRO-CLEAR-MAG-001'));

export async function simulateCommitWith(deps: SimDeps, i: SimInput): Promise<SimResult> {
  const beyondContract = i.sellCents > CONTRACT_MAX_FIELD;
  // 9e11 < sell <= 1e12: the contract would evaluate it, but the TS mirror cannot answer exactly. Say so; do not guess, do not call it an RPC problem.
  if (!beyondContract && i.sellCents > EXACT_MAX_SELL_CENTS) throw new SimOutOfRange();

  const q = { purchaseCents: BigInt(i.buyCents), shipCents: BigInt(i.shipCents), dutyCents: 12n, taxCents: 8n, procFeeCents: 5n, payFeeCents: 2n, sellCents: BigInt(i.sellCents), mktFeeBps: 800n, fulfillCents: 65n, retBps: 200n, chainCents: 4n };
  // Above the contract's own bound the mirror is skipped: the bounds check fires first, so any claim values give the real OutOfBounds verdict.
  let e: Econ | null = null;
  try {
    if (!beyondContract) e = deps.economics({ purchaseCents: i.buyCents, inboundShipCents: i.shipCents, importDutyCents: 12, taxCents: 8, procurementFeeCents: 5, paymentFeeCents: 2, sellCents: i.sellCents, marketplaceFeeBps: 800, fulfillmentCents: 65, returnReserveBps: 200, chainCostCents: 4, units: i.units, fixedBatchCents: 0 });
  } catch (err) {
    if (err instanceof RangeError) throw new SimOutOfRange();
    throw err;
  }
  const derived: SimDerived | undefined = e ? { landed: e.landedCents, net: e.netCents, marginBps: e.marginBps, spendCents: e.landedCents * i.units } : undefined;
  const qh = keccak256(encodeAbiParameters(Array(11).fill({ type: 'uint256' }), Object.values(q)));
  const snap = keccak256(new TextEncoder().encode('sim-' + Math.random() + Date.now()));
  const block = await deps.client.getBlock();
  const observedAt = block.timestamp - BigInt(i.ageSeconds ?? 0);
  const claimNet = BigInt(i.lieNetCents ?? e?.netCents ?? 0);
  const claimBps = BigInt(e?.marginBps ?? 0);
  try {
    await deps.client.simulateContract({ address: deps.core, abi: deps.abi, functionName: 'commitOpportunity', args: [PRODUCT_HASH, qh, snap, observedAt, BigInt(i.units), q, claimNet, claimBps], account: deps.agent });
    if (!e || !derived) throw new SimOutOfRange(); // unreachable in practice: the contract refuses sell > MAX_FIELD
    return { accepted: true, net: e.netCents, marginBps: e.marginBps, spendCents: derived.spendCents, derived };
  } catch (err) {
    if (err instanceof SimOutOfRange) throw err;
    if (err instanceof BaseError) {
      const r = err.walk((x) => x instanceof ContractFunctionRevertedError) as ContractFunctionRevertedError | null;
      if (r?.data) { const args = [...(r.data.args ?? [])]; return { accepted: false, error: r.data.errorName, args, sentence: explain(r.data.errorName, args), ...(derived ? { derived } : {}) }; }
      throw new Error(err.shortMessage);
    }
    throw err;
  }
}
