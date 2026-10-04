// Independent verification of what is on-chain: re-derive every cleared epoch from the Revealed events with the TypeScript mirror
// and compare price, volume and each fill with the contract's own events; then check conservation.
//   node --env-file=../../.env tools/market-verify.ts [--chain 46630] [--rpc URL] [--from-block N]
import { BOOK_ABI, ERC20_ABI } from '../src/lib/book-abi.ts';
import { clearBook, type BookOrder } from '../src/lib/book.ts';
import { arg, pub, BOOK, TOKEN, book, CATALOG } from './market-common.ts';

let failures = 0; const fail = (m: string) => { failures++; console.log('  FAIL', m); };
async function logsChunked(event: any, from: bigint, to: bigint) {
  const out: any[] = []; const step = 5000n;
  for (let a = from; a <= to; a += step) out.push(...(await pub.getContractEvents({ address: BOOK, abi: BOOK_ABI, eventName: event, fromBlock: a, toBlock: a + step - 1n > to ? to : a + step - 1n })));
  return out;
}
async function main() {
  const head = await pub.getBlockNumber(); const from = BigInt(arg('from-block', String(book.deployBlock))!);
  const [committed, revealed, fills, cleared] = await Promise.all((['Committed', 'Revealed', 'Fill', 'EpochCleared'] as const).map((e) => logsChunked(e, from, head)));
  console.log(`events from block ${from}: ${committed.length} committed, ${revealed.length} revealed, ${fills.length} fills, ${cleared.length} epochs cleared`);
  const tickOf = new Map(CATALOG.map((m) => [m.marketId.toLowerCase(), m.tick]));
  let traded = 0, noTrade = 0;
  for (const c of cleared) {
    const { market, epoch, price, volume, buys, sells, forfeited } = c.args as any; const key = `${market}:${epoch}`;
    // rebuild the book in COMMIT order; unrevealed orders stay in the list (ignored) so indexes line up
    const cs = committed.filter((x: any) => `${x.args.market}:${x.args.epoch}` === key).sort((a: any, b: any) => Number(a.args.index - b.args.index));
    const rs = new Map(revealed.filter((x: any) => `${x.args.market}:${x.args.epoch}` === key).map((x: any) => [Number(x.args.index), x.args]));
    const orders: BookOrder[] = cs.map((x: any) => { const r: any = rs.get(Number(x.args.index)); return r ? { side: r.side as 0 | 1, price: Number(r.price), units: Number(r.units) } : { side: 0, price: 0, units: 0, revealed: false }; });
    const mirror = clearBook(orders, tickOf.get(String(market).toLowerCase()) ?? 1);
    const label = `${CATALOG.find((m) => m.marketId.toLowerCase() === String(market).toLowerCase())?.symbol ?? market} epoch ${epoch}`;
    if (Number(price) !== mirror.price || Number(volume) !== mirror.volume) fail(`${label}: chain says ${price} x ${volume}, mirror says ${mirror.price} x ${mirror.volume}`);
    if (rs.size !== Number(buys) + Number(sells)) fail(`${label}: revealed ${rs.size} != buys+sells ${Number(buys) + Number(sells)}`);
    if (cs.length - rs.size !== Number(forfeited)) fail(`${label}: unrevealed ${cs.length - rs.size} != forfeited ${forfeited}`);
    const fs = fills.filter((x: any) => `${x.args.market}:${x.args.epoch}` === key);
    for (const f of fs) { const idx = Number(f.args.index); if (mirror.fills[idx] !== Number(f.args.units) || Number(f.args.price) !== mirror.price) fail(`${label}: fill ${idx} chain ${f.args.units}@${f.args.price} vs mirror ${mirror.fills[idx]}@${mirror.price}`); }
    const fillSum = fs.reduce((s: number, f: any) => s + Number(f.args.units), 0);
    if (fillSum !== 2 * Number(volume)) fail(`${label}: fills sum ${fillSum} != 2 x volume ${2 * Number(volume)}`);
    if (Number(volume) > 0) traded++; else noTrade++;
  }
  console.log(`re-derived ${cleared.length} cleared epochs with the TypeScript mirror: ${traded} traded, ${noTrade} had no cross`);
  // conservation
  const [accounted, bal] = await Promise.all([pub.readContract({ address: BOOK, abi: BOOK_ABI, functionName: 'accounted' }), pub.readContract({ address: TOKEN, abi: ERC20_ABI, functionName: 'balanceOf', args: [BOOK] })]) as [bigint, bigint];
  if (accounted !== bal) fail(`token balance ${bal} != accounted ${accounted}`); else console.log(`cash conserved: token balance == free + locked + bonds + treasury == ${accounted}`);
  const minCleared = Number(arg('min-cleared', '0')); const minTraded = Number(arg('min-traded', '0'));
  if (cleared.length < minCleared) fail(`only ${cleared.length} epochs cleared, expected at least ${minCleared} (a verification over nothing proves nothing)`);
  if (traded < minTraded) fail(`only ${traded} epochs traded, expected at least ${minTraded}`);
  console.log(failures ? `\n${failures} FAILURE(S)` : '\nmarket verification: all checks passed');
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error('VERIFY CRASHED:', e instanceof Error ? e.message : e); process.exit(1); });
