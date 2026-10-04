// Writes src/data/blindbook-history.json: every BlindBook market event up to a recent block, so /market opens instantly
// and only fetches the few newest blocks from the (rate-limited) public RPC.
//   node --env-file=../../.env tools/market-snapshot.ts
// Re-run it whenever you want a fresher snapshot; the page still reads anything newer than the snapshot live from the chain.
import { createPublicClient, http, defineChain, type Hex } from 'viem';
import fs from 'node:fs';
import { BOOK_ABI } from '../src/lib/book-abi.ts';

const dep = JSON.parse(fs.readFileSync('src/data/blindbook.json', 'utf8')) as { chainId: number; book: Hex; deployBlock: number };
const RPC = process.env.ROBINHOOD_RPC ?? 'https://rpc.testnet.chain.robinhood.com';
const client = createPublicClient({ chain: defineChain({ id: dep.chainId, name: 'robinhood-testnet', nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } }), transport: http(RPC, { timeout: 30_000 }) });
const KEEP = ['Committed', 'Revealed', 'Fill', 'EpochCleared'];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function range(from: bigint, to: bigint): Promise<any[]> {
  for (let attempt = 0; ; attempt++) {
    try { return (await client.getContractEvents({ address: dep.book, abi: BOOK_ABI, fromBlock: from, toBlock: to } as any)) as any[]; }
    catch (e: any) {
      const msg = String(e?.message ?? e) + String(e?.details ?? '');
      if (to > from && /limit|too many|exceed|more than/i.test(msg)) { const mid = from + (to - from) / 2n; return [...(await range(from, mid)), ...(await range(mid + 1n, to))]; }
      if (attempt >= 6) throw e; await sleep(1000 * (attempt + 1));
    }
  }
}

const head = (await client.getBlockNumber()) - 20n;        // stay clear of the tip
const logs: any[] = []; const step = 5000n;
for (let a = BigInt(dep.deployBlock); a <= head; a += step) {
  const to = a + step - 1n > head ? head : a + step - 1n;
  logs.push(...(await range(a, to)));
  process.stdout.write(`\r${Number(a - BigInt(dep.deployBlock)) / Number(head - BigInt(dep.deployBlock)) * 100 | 0}%  ${logs.length} events`); await sleep(150);
}
const FULL_EPOCHS = 150;   // full order books only for the newest epochs (the sealed-book replay); older epochs keep just their EpochCleared point for the chart
const all = logs.filter((l) => KEEP.includes(l.eventName));
const newest = Math.max(...all.map((l) => Number(l.args.epoch)));
const events = all.filter((l) => l.eventName === 'EpochCleared' || Number(l.args.epoch) > newest - FULL_EPOCHS).sort((a, b) => Number(a.blockNumber - b.blockNumber) || a.logIndex - b.logIndex)
  .map((l) => ({ e: l.eventName, b: Number(l.blockNumber), i: l.logIndex, t: l.transactionHash, a: Object.fromEntries(Object.entries(l.args).map(([k, v]) => [k, typeof v === 'bigint' ? v.toString() : v])) }));
fs.writeFileSync('src/data/blindbook-history.json', JSON.stringify({ chainId: dep.chainId, book: dep.book, head: Number(head), events }));
console.log(`\nwrote src/data/blindbook-history.json: ${events.length} events up to block ${head}`);
