// Writes src/data/orders.json from the chain: every OrderEscrow log up to a recent block, with block times. The /app/orders page
// shows this instantly and only reads the newer blocks from the (rate-limited) public RPC. Anything tools/order-proof.ts wrote under
// `proof` is kept; `events`, `head` and the contract fields are replaced. Read-only: it sends no transaction.
//   node --env-file=../../.env tools/order-snapshot.ts [--rpc URL] [--deployment ../../packages/contracts/deployments/orders-46630.json]
import { createPublicClient, http, defineChain, getAddress } from 'viem';
import fs from 'node:fs';
import path from 'node:path';
import { ORDERS_ABI } from '../src/lib/orders-abi.ts';
import { fetchEscrowEvents, attachTimes, type EscrowEvent } from '../src/lib/orders.ts';

const argv = (k: string, d?: string) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const OUT = path.resolve('src/data/orders.json');
const DEP = path.resolve(argv('deployment', '../../packages/contracts/deployments/orders-46630.json')!);
const RPC = argv('rpc', process.env.ROBINHOOD_RPC ?? 'https://rpc.testnet.chain.robinhood.com')!;
const client = createPublicClient({ chain: defineChain({ id: 46630, name: 'robinhood-testnet', nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } }), transport: http(RPC, { timeout: 30_000 }) });

const prev = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : { deployed: false };
if (!fs.existsSync(DEP)) { console.error(`order-snapshot: ${DEP} does not exist. OrderEscrow is not deployed yet, so there is nothing to snapshot.`); process.exit(1); }
const d = JSON.parse(fs.readFileSync(DEP, 'utf8'));
if (Number(d.chainId) !== 46630 || (await client.getChainId()) !== 46630) { console.error('order-snapshot: refusing, this is not chain 46630'); process.exit(1); }
const escrow = getAddress(d.escrow);
const from = BigInt(prev.logsFromBlock ?? d.deployBlock ?? d.logsFromBlock);
const head = (await client.getBlockNumber()) - 20n;      // stay clear of the tip
const STEP = 50_000n; const events: EscrowEvent[] = [];
for (let a = from; a <= head; a += STEP) {
  events.push(...await fetchEscrowEvents(client as any, { address: escrow, abi: ORDERS_ABI, from: a, to: a + STEP - 1n > head ? head : a + STEP - 1n }));
  process.stdout.write(`\r${events.length} events up to block ${a + STEP > head ? head : a + STEP}`);
}
const timed = await attachTimes(client as any, events);
const out = {
  ...prev, deployed: true, chainId: 46630, escrow, book: getAddress(d.book), token: getAddress(d.token), market: prev.market ?? 'CASE-IP16PRO-CLEAR-MAG-001', marketId: d.market, sku: d.sku, verifier: getAddress(d.verifier), symbol: 'mUSDG', bondBps: Number(d.bondBps),
  windows: { accept: Number(d.acceptWindow), ship: Number(d.shipWindow), verify: Number(d.verifyWindow), dispute: Number(d.disputeWindow), resolve: Number(d.resolveWindow) },
  logsFromBlock: Number(from), head: Number(head), events: timed,
};
fs.writeFileSync(OUT, JSON.stringify(out, null, 1) + '\n');
console.log(`\nwrote src/data/orders.json: ${timed.length} events from block ${from} to ${head}`);
