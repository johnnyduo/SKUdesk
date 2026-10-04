// Captures the public BlindBook event logs the market tests use. READ-ONLY: three eth_getLogs calls against the public RPC,
// no keys, no writes. The ranges are fixed historic blocks, so the output is identical on every run.
//   node test/market/capture-fixtures.mjs        (from apps/web; writes test/market/fixtures/chain-logs.json)
import { writeFileSync } from 'node:fs';

const RPC = 'https://rpc.testnet.chain.robinhood.com';
const BOOK = '0x2BA62631d74827aBF2f7467B20370dC2DC59aa11';
const MARKET_TOPICS = [
  '0x35b40b32da2f1b3785ff0610aa3cc6be770cc1a7a4f925c46b906a81b937dacf', // Committed
  '0x9387de0c497d7c0d28fd9ae5059019c782ed124c45a7e177653e8caa2b389e01', // Revealed
  '0x0322763aeeb80b92cfe722292ea1e9ee7a3a31c26e086701b5e06a17a293dce6', // Fill
  '0xbb2d1e15bc81d4183ebf63b19acfc5ac6c5f42b21e0d3842a127f69603d0c11a', // EpochCleared
];
// epochs 982-983 (three no-trade clears) and 1136-1139 (forfeited bonds, partial fills); one MarketListed log (an event the decoder must ignore)
const RANGES = [
  { from: 127948591, to: 127949240, topics: [MARKET_TOPICS] },
  { from: 127998007, to: 127999285, topics: [MARKET_TOPICS] },
  { from: 127690104, to: 127690104, topics: [] },
];
const hex = (n) => '0x' + n.toString(16);
async function getLogs(r) {
  const res = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getLogs', params: [{ address: BOOK, fromBlock: hex(r.from), toBlock: hex(r.to), topics: r.topics }] }) });
  const j = await res.json();
  if (!Array.isArray(j.result)) throw new Error('eth_getLogs failed: ' + JSON.stringify(j.error ?? j).slice(0, 200));
  return j.result;
}
const keep = (l) => ({ topics: l.topics, data: l.data, blockNumber: l.blockNumber, transactionHash: l.transactionHash, logIndex: l.logIndex, blockHash: l.blockHash, removed: l.removed });
const out = { note: 'Public on-chain BlindBook logs from Robinhood Chain Testnet (chain 46630). Captured read-only by capture-fixtures.mjs.', chainId: 46630, book: BOOK.toLowerCase(), ranges: RANGES.map(({ from, to }) => ({ from, to })), logs: [] };
for (const r of RANGES) out.logs.push(...(await getLogs(r)).map(keep));
const path = new URL('./fixtures/chain-logs.json', import.meta.url);
writeFileSync(path, JSON.stringify(out, null, 0) + '\n');
console.log('wrote', out.logs.length, 'logs to', path.pathname);
