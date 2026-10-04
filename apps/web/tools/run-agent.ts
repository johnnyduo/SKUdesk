// SKUdesk agent run. Runs LOCALLY, talks to Gemini and to a real chain, and records everything in run.json.
//   node --env-file=../../.env tools/run-agent.ts [--out src/data/run.json] [--rpc URL] [--chain 46630]
// The Show page plays run.json back. Nothing here is faked: every tx hash and revert reason is real.
import { createPublicClient, createWalletClient, http, parseAbi, keccak256, encodeAbiParameters, defineChain, BaseError, ContractFunctionRevertedError, getAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import fs from 'node:fs';
import path from 'node:path';
import { economics } from '../../../packages/economics/index.ts';
import { matchOffer } from '../../../packages/matching/index.ts';

const arg = (k: string, d?: string) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const CHAIN_ID = Number(arg('chain', process.env.CHAIN_ID ?? '46630'));
const RPC = arg('rpc', process.env.ROBINHOOD_RPC)!;
const OUT = arg('out', 'src/data/run.json')!;
const MODEL = process.env.GEMINI_MODEL ?? 'gemini-3.5-flash-lite';
const dep = JSON.parse(fs.readFileSync(path.resolve('../../packages/contracts/deployments/' + CHAIN_ID + '.json'), 'utf8'));
const chain = defineChain({ id: CHAIN_ID, name: 'robinize-' + CHAIN_ID, nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const pub = createPublicClient({ chain, transport: http(RPC) });
const agent = privateKeyToAccount(process.env.AGENT_PRIVATE_KEY as `0x${string}`);
const wallet = createWalletClient({ account: agent, chain, transport: http(RPC) });
const CORE = getAddress(dep.core); const SUPPLIER = getAddress(dep.supplier); const PAYER = getAddress(dep.payer);
const CENT = 10_000n;

const QUOTE = '(uint256 purchaseCents,uint256 shipCents,uint256 dutyCents,uint256 taxCents,uint256 procFeeCents,uint256 payFeeCents,uint256 sellCents,uint256 mktFeeBps,uint256 fulfillCents,uint256 retBps,uint256 chainCents)';
const ABI = parseAbi([
  `function commitOpportunity(bytes32 productHash,bytes32 quoteHash,bytes32 snapshotHash,uint256 observedAt,uint256 units,${QUOTE} q,int256 agentNet,uint256 agentMarginBps) returns (bytes32,uint256,int256)`,
  'function mintLot(bytes32 oppHash) returns (uint256)', 'function fundLot(uint256 lot)',
  'function markPurchased(uint256 lot,address to,uint256 amount)', 'function markReceived(uint256 lot)', 'function markListed(uint256 lot)', 'function markSold(uint256 lot)',
  'function settle(uint256 lot,address from,uint256 proceeds)', 'function cancel(uint256 lot)', 'function refund(uint256 lot)',
  'function dailySpendCap() view returns (uint256)', 'function maxExec() view returns (uint256)', 'function minMarginBps() view returns (uint256)', 'function quoteTTL() view returns (uint256)',
  'function free() view returns (uint256)', 'function totalEscrow() view returns (uint256)', 'function totalPaidOut() view returns (uint256)', 'function totalProceeds() view returns (uint256)', 'function spentToday() view returns (uint256)',
  'function nextLot() view returns (uint256)', 'function balanceOf(address) view returns (uint256)',
  'error Unauthorized()', 'error Paused()', 'error Reentrancy()', 'error BadQuoteHash(bytes32 expected,bytes32 got)', 'error FutureObservation(uint256 observedAt,uint256 nowTs)', 'error Replay(bytes32 oppHash)',
  'error Stale(uint256 age,uint256 ttl)', 'error OutOfBounds(bytes32 field,uint256 value)', 'error BadUnits(uint256 units)', 'error SpendCap(uint256 spendCents,uint256 capCents)', 'error DailyCap(uint256 spentAfterCents,uint256 capCents)',
  'error MathMismatch(int256 claimedNet,int256 derivedNet,uint256 claimedBps,uint256 derivedBps)', 'error MarginTooLow(uint256 marginBps,uint256 floorBps)', 'error NonPositiveNet(int256 net)',
  'error UnknownOpportunity(bytes32 oppHash)', 'error OpportunityConsumed(bytes32 oppHash)', 'error InsufficientFree(uint256 free,uint256 needed)', 'error PayeeNotAllowed(address who)', 'error PayerNotAllowed(address who)',
  'error ExceedsEscrow(uint256 amount,uint256 escrowLeft)', 'error BadTransition(uint8 from,uint8 to)', 'error TransferFailed()',
]);
const usd = (cents: number | bigint) => '$' + (Number(cents) / 100).toFixed(2);

// run log
type Ev = { id: number; at: number; kind: string; title: string; detail?: string; data?: any; tx?: { hash: string; block: number; gasUsed: string; status: string } };
const t0 = Date.now(); const events: Ev[] = [];
const log = (kind: string, title: string, detail?: string, data?: any, tx?: Ev['tx']) => { events.push({ id: events.length + 1, at: Date.now() - t0, kind, title, detail, data, tx }); console.log(`[${String(Date.now() - t0).padStart(6)}ms] ${kind.padEnd(10)} ${title}${detail ? ' :: ' + detail : ''}`); };

// revert -> sentence
function explain(name: string, a: any[] = []): string {
  switch (name) {
    case 'MathMismatch': return `Agent claimed net ${usd(a[0])} but the contract derived ${usd(a[1])} from the quote. Rejected.`;
    case 'SpendCap': return `Spend ${usd(a[0])} exceeds the per-execution cap of ${usd(a[1])}. Rejected.`;
    case 'DailyCap': return `Daily spend would reach ${usd(a[0])}, above the daily cap of ${usd(a[1])}. Rejected.`;
    case 'Stale': return `Quote is ${a[0]}s old; the policy allows ${a[1]}s. Rejected.`;
    case 'Replay': return `This exact opportunity was already committed. Replay blocked.`;
    case 'BadQuoteHash': return `The quote hash does not match the quote that was submitted. Rejected.`;
    case 'MarginTooLow': return `Margin ${(Number(a[0]) / 100).toFixed(2)}% is below the policy floor of ${(Number(a[1]) / 100).toFixed(2)}%. Rejected.`;
    case 'NonPositiveNet': return `Net profit is not positive. Rejected.`;
    case 'PayeeNotAllowed': return `Payee ${a[0]} is not on the owner's allowlist; the agent cannot send escrow there. Rejected.`;
    case 'OutOfBounds': return `Field ${Buffer.from(String(a[0]).slice(2), 'hex').toString().replace(/\0+$/, '')} is out of the allowed bounds. Rejected.`;
    case 'FutureObservation': return `Observation timestamp is in the future. Rejected.`;
    default: return `${name}(${a.map(String).join(', ')})`;
  }
}
function decode(e: unknown): { name: string; args: any[]; sentence: string } {
  if (e instanceof BaseError) {
    const r = e.walk((x) => x instanceof ContractFunctionRevertedError) as ContractFunctionRevertedError | null;
    if (r?.data) return { name: r.data.errorName, args: [...(r.data.args ?? [])], sentence: explain(r.data.errorName, [...(r.data.args ?? [])]) };
    return { name: 'Unknown', args: [], sentence: e.shortMessage };
  }
  return { name: 'Unknown', args: [], sentence: String(e) };
}
const jsonSafe = (v: any) => JSON.parse(JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? x.toString() : x)));

// chain helpers
async function send(fn: string, args: any[], label: string, detail?: string, gas?: bigint) {
  const hash = await wallet.writeContract({ address: CORE, abi: ABI, functionName: fn as any, args: args as any, ...(gas ? { gas } : {}) } as any);
  const rc = await pub.waitForTransactionReceipt({ hash });
  log('tx', label, detail, undefined, { hash, block: Number(rc.blockNumber), gasUsed: rc.gasUsed.toString(), status: rc.status });
  return rc;
}
async function sim(fn: string, args: any[]) {
  try { await pub.simulateContract({ address: CORE, abi: ABI, functionName: fn as any, args: args as any, account: agent.address } as any); return null; } catch (e) { return decode(e); }
}
const rd = async (fn: string) => (await pub.readContract({ address: CORE, abi: ABI, functionName: fn as any } as any)) as bigint;

// market snapshot (a fixed snapshot: NOT a live feed) + decoys that look cheaper
type Offer = { id: string; source: string; title: string; priceCents: number; shipCents: number; stock: number; seller: string; attributes: Record<string, string>; gtin?: string };
const CANON = { brand: 'Apple-compatible', model: 'iPhone 16 Pro Clear MagSafe Case', compatibility: 'iPhone 16 Pro', color: 'Clear', packCount: 1, gtin: '850063102441', attributes: { magsafe: 'Yes' } };
const PRODUCT_HASH = keccak256(new TextEncoder().encode('CASE-IP16PRO-CLEAR-MAG-001'));
const mk = (id: string, source: string, title: string, priceCents: number, shipCents: number, stock: number, seller: string, attributes: Record<string, string> = {}, gtin?: string): Offer => ({ id, source, title, priceCents, shipCents, stock, seller, attributes, gtin });
const SNAPSHOT: Offer[] = [
  mk('shopee-8841', 'shopee', 'Clear MagSafe Case for iPhone 16 Pro TPU Transparent', 590, 42, 2400, 'Supplier A', { device: 'iPhone 16 Pro', magsafe: 'Yes', pack: '1' }, '850063102441'),
  mk('lazada-2207', 'lazada', 'iPhone 15 Pro Clear MagSafe Case TPU', 410, 38, 3100, 'Shenzhen hub', { device: 'iPhone 15 Pro', magsafe: 'Yes', pack: '1' }),
  mk('shopee-7710', 'shopee', 'iPhone 16 Pro Clear MagSafe Case 2-Pack', 520, 44, 900, 'Direct HK', { device: 'iPhone 16 Pro', magsafe: 'Yes', pack: '2-pack' }),
  mk('lazada-3051', 'lazada', 'iPhone 16 Pro Max Clear MagSafe Case', 450, 40, 1800, 'Wholesale feed', { device: 'iPhone 16 Pro Max', magsafe: 'Yes', pack: '1' }),
  mk('shopee-9902', 'shopee', 'iPhone 16 Pro Clear Case (no magnet)', 380, 36, 4000, 'Supplier B', { device: 'iPhone 16 Pro', pack: '1' }),
  mk('shopee-6120', 'shopee', 'Galaxy S25 Clear MagSafe-style Case', 360, 35, 2500, 'Supplier B', { device: 'Galaxy S25', pack: '1' }),
  mk('google-5501', 'google', 'iPhone 16 Pro Clear MagSafe Case TPU', 1099, 0, 800, 'Retail demand', { device: 'iPhone 16 Pro', magsafe: 'Yes', pack: '1' }),
  mk('google-5502', 'google', 'iPhone 15 Pro Clear MagSafe Case TPU', 1249, 0, 700, 'Retail demand', { device: 'iPhone 15 Pro', magsafe: 'Yes', pack: '1' }),
  mk('google-5503', 'google', 'iPhone 16 Pro Max Clear MagSafe Case', 1199, 0, 650, 'Retail demand', { device: 'iPhone 16 Pro Max', magsafe: 'Yes', pack: '1' }),
  mk('lazada-4410', 'lazada', 'iPhone 16 Pro Clear MagSafe Case', 1059, 0, 500, 'Lazada Store', { device: 'iPhone 16 Pro', magsafe: 'Yes', pack: '1' }),
];
// The snapshot document (capture time + offers) is what gets hashed and committed on-chain, so any later change to it is detectable.
const CAPTURED_AT = new Date().toISOString();
const SNAPSHOT_DOC = { capturedAt: CAPTURED_AT, source: 'a fixed snapshot (not a live feed)', offers: SNAPSHOT };
const SNAPSHOT_HASH = keccak256(new TextEncoder().encode(JSON.stringify(SNAPSHOT_DOC)));
const byId = (id: string) => SNAPSHOT.find((o) => o.id === id);

// Gemini
async function gemini(history: any[], system: string) {
  const body = {
    systemInstruction: { parts: [{ text: system }] }, contents: history,
    generationConfig: { responseMimeType: 'application/json', temperature: 0.3, responseSchema: { type: 'OBJECT', properties: { buyOfferId: { type: 'STRING' }, sellOfferId: { type: 'STRING' }, units: { type: 'INTEGER' }, reasoning: { type: 'ARRAY', items: { type: 'STRING' } } }, required: ['buyOfferId', 'sellOfferId', 'units', 'reasoning'] } },
  };
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY! }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`Gemini ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const j: any = await res.json();
  const text = j.candidates?.[0]?.content?.parts?.map((p: any) => p.text ?? '').join('') ?? '';
  return { text, parsed: JSON.parse(text) };
}

const quoteOf = (buy: Offer, sell: Offer) => ({ purchaseCents: BigInt(buy.priceCents), shipCents: BigInt(buy.shipCents), dutyCents: 12n, taxCents: 8n, procFeeCents: 5n, payFeeCents: 2n, sellCents: BigInt(sell.priceCents), mktFeeBps: 800n, fulfillCents: 65n, retBps: 200n, chainCents: 4n });
const quoteHashOf = (q: ReturnType<typeof quoteOf>) => keccak256(encodeAbiParameters(Array(11).fill({ type: 'uint256' }), Object.values(q)));
const econOf = (q: ReturnType<typeof quoteOf>, units: number) => economics({ purchaseCents: Number(q.purchaseCents), inboundShipCents: Number(q.shipCents), importDutyCents: 12, taxCents: 8, procurementFeeCents: 5, paymentFeeCents: 2, sellCents: Number(q.sellCents), marketplaceFeeBps: 800, fulfillmentCents: 65, returnReserveBps: 200, chainCostCents: 4, units, fixedBatchCents: 0 });

async function main() {
  if (!process.env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY missing in .env');
  const chainId = await pub.getChainId(); if (chainId !== CHAIN_ID) throw new Error(`rpc chain ${chainId} != ${CHAIN_ID}`);
  const policy = { dailySpendCap: await rd('dailySpendCap'), maxExec: await rd('maxExec'), minMarginBps: await rd('minMarginBps'), quoteTTL: await rd('quoteTTL') };
  const startFree = await rd('free');
  log('policy', 'Mandate read from chain', `per-run cap ${usd(policy.maxExec)}, daily cap ${usd(policy.dailySpendCap)}, margin floor ${(Number(policy.minMarginBps) / 100).toFixed(0)}%, quote TTL ${policy.quoteTTL}s`, jsonSafe({ ...policy, vaultFree: startFree, core: CORE }));
  log('snapshot', 'Market snapshot loaded', `${SNAPSHOT.length} offers (a fixed snapshot, not a live feed). snapshotHash ${SNAPSHOT_HASH}`, { snapshotHash: SNAPSHOT_HASH, count: SNAPSHOT.length });

  // agent loop: propose -> gate -> (retry with feedback)
  const system = `You are Robinize, an autonomous commerce agent. Pick ONE arbitrage: one buy offer and one sell offer for the target product, and a unit count. Maximize net profit. Constraints from the owner's on-chain mandate: total landed spend per execution must be at most ${usd(policy.maxExec)} (estimated landed cost per unit = buy price + shipping + 27 cents of duty, tax and fees); net margin must be at least ${Number(policy.minMarginBps) / 100}% of the sell price (marketplace fee 8%, fulfilment 65 cents, return reserve 2% apply). Explain your choice in 3 to 6 short bullet strings, including which tempting offers you skipped and why. Answer as JSON.`;
  const table = SNAPSHOT.map((o) => `${o.id} | ${o.source} | "${o.title}" | ${usd(o.priceCents)} + ship ${usd(o.shipCents)} | stock ${o.stock} | seller ${o.seller}`).join('\n');
  const history: any[] = [{ role: 'user', parts: [{ text: `Target product: iPhone 16 Pro clear MagSafe phone case, single pack.\nMarket snapshot (price in USD):\n${table}\nPropose the best opportunity.` }] }];
  let accepted: { buy: Offer; sell: Offer; units: number; reasoning: string[] } | null = null;
  for (let attempt = 1; attempt <= 4 && !accepted; attempt++) {
    log('agent', `Agent thinking (attempt ${attempt}, ${MODEL})`);
    const { text, parsed } = await gemini(history, system);
    history.push({ role: 'model', parts: [{ text }] });
    const buy = byId(parsed.buyOfferId); const sell = byId(parsed.sellOfferId); const units = Math.floor(Number(parsed.units));
    log('agent', 'Agent proposal', `buy ${parsed.buyOfferId}, sell ${parsed.sellOfferId}, ${units} units`, { proposal: parsed });
    for (const r of parsed.reasoning ?? []) log('reason', String(r));
    const problems: string[] = [];
    if (!buy || !sell) problems.push('unknown offer id');
    else {
      for (const [label, o] of [['buy', buy], ['sell', sell]] as const) {
        const v = matchOffer(CANON, { title: o.title, attributes: o.attributes, gtin: o.gtin });
        log('gate', `Identity gate on ${label} offer ${o.id}`, v.locked ? 'LOCKED: same SKU' : 'REJECTED: ' + v.rejectReasons.join(' | '), { offerId: o.id, locked: v.locked, gates: v.gates });
        if (!v.locked) problems.push(`${label} offer ${o.id} failed the identity gate: ${v.rejectReasons.join('; ')}`);
      }
      if (!(units >= 1 && units <= 1_000_000)) problems.push('units out of range');
      else {
        const q = quoteOf(buy, sell); const e = econOf(q, units); const spend = e.landedCents * units;
        if (spend > Number(policy.maxExec)) problems.push(`landed spend ${usd(spend)} exceeds the per-execution cap ${usd(policy.maxExec)}`);
        if (e.netCents <= 0 || e.marginBps < Number(policy.minMarginBps)) problems.push(`margin ${(e.marginBps / 100).toFixed(2)}% is below the ${Number(policy.minMarginBps) / 100}% floor`);
      }
    }
    if (problems.length === 0) accepted = { buy: buy!, sell: sell!, units, reasoning: parsed.reasoning ?? [] };
    else { log('reject', 'Proposal rejected before reaching the chain', problems.join(' || ')); history.push({ role: 'user', parts: [{ text: 'Rejected: ' + problems.join(' | ') + '. Propose again.' }] }); }
  }
  if (!accepted) throw new Error('Agent produced no acceptable proposal in 4 attempts; rerun.');

  // economics (the proof lines the contract will recompute)
  const { buy, sell, units } = accepted; const q = quoteOf(buy, sell); const e = econOf(q, units); const qh = quoteHashOf(q);
  log('econ', 'Unit economics (integer cents)', e.proof.map((p: any) => `${p.label}: ${p.formula} = ${p.resultCents}`).join('\n'), { landedCents: e.landedCents, netCents: e.netCents, marginBps: e.marginBps, proof: e.proof, units, spendCents: e.landedCents * units });

  // happy path on chain
  const now = BigInt((await pub.getBlock()).timestamp);
  const commitArgs = [PRODUCT_HASH, qh, SNAPSHOT_HASH, now, BigInt(units), q, BigInt(e.netCents), BigInt(e.marginBps)];
  const oppHash = keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'bytes32' }, { type: 'bytes32' }], [PRODUCT_HASH, qh, SNAPSHOT_HASH]));
  await send('commitOpportunity', commitArgs, 'commitOpportunity: contract re-derives economics and accepts', `net ${usd(e.netCents)}/unit, margin ${(e.marginBps / 100).toFixed(2)}%, spend ${usd(e.landedCents * units)}`);
  const lot = (await rd('nextLot')) + 1n;
  await send('mintLot', [oppHash], 'mintLot from the committed opportunity', `lot #${lot}`);
  await send('fundLot', [lot], 'fundLot: exact committed spend moves vault -> escrow', usd(e.landedCents * units));
  const spendBase = BigInt(e.landedCents * units) * CENT;

  // attacks (simulated from the agent address; nothing is broadcast, state unchanged)
  const fresh = (s: string) => keccak256(new TextEncoder().encode(s));
  const nowB = BigInt((await pub.getBlock()).timestamp);
  const attacks: { name: string; fn: string; args: any[]; expect: string }[] = [
    { name: 'The agent inflates its profit claim', fn: 'commitOpportunity', args: [PRODUCT_HASH, qh, fresh('lie'), nowB, 100n, q, BigInt(e.netCents) + 129n, BigInt(e.marginBps)], expect: 'MathMismatch' },
    { name: 'The agent tries to spend over the cap', fn: 'commitOpportunity', args: [PRODUCT_HASH, qh, fresh('big'), nowB, 400n, q, BigInt(e.netCents), BigInt(e.marginBps)], expect: 'SpendCap' },
    { name: 'The agent replays the same opportunity', fn: 'commitOpportunity', args: commitArgs, expect: 'Replay' },
    { name: 'The agent uses a stale quote', fn: 'commitOpportunity', args: [PRODUCT_HASH, qh, fresh('stale'), nowB - BigInt(Number(policy.quoteTTL) + 600), 100n, q, BigInt(e.netCents), BigInt(e.marginBps)], expect: 'Stale' },
    { name: 'The agent swaps in a different quote than it hashed', fn: 'commitOpportunity', args: [PRODUCT_HASH, fresh('other-quote'), fresh('swap'), nowB, 100n, q, BigInt(e.netCents), BigInt(e.marginBps)], expect: 'BadQuoteHash' },
    { name: 'The agent tries to pay escrow to itself', fn: 'markPurchased', args: [lot, agent.address, spendBase], expect: 'PayeeNotAllowed' },
  ];
  const attackResults: any[] = [];
  for (const a of attacks) {
    const r = await sim(a.fn, a.args);
    if (!r) { log('error', `ATTACK NOT BLOCKED: ${a.name}`); throw new Error('Attack was not blocked: ' + a.name); }
    if (r.name !== a.expect) throw new Error(`Attack "${a.name}" reverted with ${r.name}, expected ${a.expect}. Redeploy a fresh vault (earlier runs consume the daily cap) and rerun.`);
    log('revert', a.name, r.sentence, { error: r.name, args: jsonSafe(r.args) });
    attackResults.push({ name: a.name, error: r.name, args: jsonSafe(r.args), sentence: r.sentence });
  }
  // one failing tx on chain (forced gas, since nodes refuse to broadcast txs that fail estimation) so the revert is visible on the explorer
  const lieArgs = [PRODUCT_HASH, qh, fresh('lie-onchain'), nowB, 100n, q, BigInt(e.netCents) + 129n, BigInt(e.marginBps)];
  const failRc = await send('commitOpportunity', lieArgs, 'Failed tx on chain: the inflated-profit commit reverted', 'status: reverted (visible on the explorer)', 700_000n);
  if (failRc.status !== 'reverted') throw new Error('expected the lie tx to revert');

  // continue the honest lifecycle
  await send('markPurchased', [lot, SUPPLIER, spendBase], 'markPurchased: escrow paid to the allowlisted supplier', `${usd(e.landedCents * units)} -> ${SUPPLIER}`);
  await send('markReceived', [lot], 'markReceived (agent-attested)');
  await send('markListed', [lot], 'markListed (agent-attested)');
  await send('markSold', [lot], 'markSold (agent-attested)');
  // Marketplace remits the sell price net of every selling-side cost the quote models (fee, fulfilment, return reserve, chain cost),
  // so the realized P&L can be compared one-to-one with the net the contract verified.
  const proceedsCents = BigInt((e.netCents + e.landedCents) * units);
  const payerFloat = (await pub.readContract({ address: getAddress(dep.token), abi: ABI, functionName: 'balanceOf' as any, args: [PAYER] } as any)) as bigint;
  if (payerFloat < proceedsCents * CENT) throw new Error(`payer float ${payerFloat} < proceeds ${proceedsCents * CENT}; redeploy a fresh vault`);
  await send('settle', [lot, PAYER, proceedsCents * CENT], 'settle: proceeds pulled from the allowlisted payer, P&L measured on tokens actually received', `proceeds ${usd(proceedsCents)}`);

  const end = { free: await rd('free'), totalEscrow: await rd('totalEscrow'), totalPaidOut: await rd('totalPaidOut'), totalProceeds: await rd('totalProceeds'), spentToday: await rd('spentToday') };
  const realized = Number(end.totalProceeds - end.totalPaidOut) / 1e4;
  if (Math.round(realized) !== e.netCents * units) throw new Error(`realized P&L ${realized} != verified net ${e.netCents * units}`);
  log('state', 'Vault after the run', `free ${usd(Number(end.free) / 1e4)}, realized P&L ${usd(realized)} = verified net ${usd(e.netCents * units)} (prediction matches settlement)`, jsonSafe(end));

  const out = {
    meta: { chainId: CHAIN_ID, core: CORE, token: dep.token, owner: dep.owner, agent: agent.address, supplier: SUPPLIER, payer: PAYER, model: MODEL, startedAt: new Date(t0).toISOString(), durationMs: Date.now() - t0,
      note: 'Agent run on Robinhood Chain Testnet. Market data is a fixed snapshot, not a live feed; the settlement token is mUSDG, a test token; real-world steps after escrow are attested by the agent.', snapshotHash: SNAPSHOT_HASH, lot: Number(lot), oppHash },
    policy: jsonSafe(policy), accepted: { buyOfferId: buy.id, sellOfferId: sell.id, units, reasoning: accepted.reasoning }, attacks: attackResults, end: jsonSafe(end), events,
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
  fs.writeFileSync(path.join(path.dirname(OUT), 'snapshot.json'), JSON.stringify(SNAPSHOT_DOC, null, 2));
  fs.writeFileSync(path.join(path.dirname(OUT), 'deployment.json'), JSON.stringify(dep, null, 2));
  console.log(`\nwrote ${OUT} (${events.length} events, ${events.filter((x) => x.tx).length} txs)`);
}
main().catch((e) => { console.error('RUN FAILED:', e instanceof Error ? e.message : e); process.exit(1); });
