// BlindBook keeper: six bots place sealed orders every epoch, reveal them, and clear the markets. Runs on the developer machine;
// the chart is built from the on-chain events it produces, so history survives the keeper stopping.
//   node --env-file=../../.env tools/keeper.ts [--epochs N (0 = forever)] [--markets 1] [--pin SYMBOL[,SYMBOL] ...] [--every 1] [--gate URL] [--rpc URL] [--chain 46630]
// --pin SYMBOL (repeatable or a comma list, e.g. --pin IP16P-CLR): a pinned market is quoted in EVERY acted epoch, the other --markets slots rotate over the rest
//   of the listed pool (--markets 1 --pin X quotes X only; --markets 2 --pin X rotates the second slot). Without --pin the plain round robin runs.
import { encodeAbiParameters, keccak256, parseEventLogs, formatEther, type Hex } from 'viem';
import { randomBytes } from 'node:crypto';
import { BOOK_ABI } from '../src/lib/book-abi.ts';
import { maxGap } from './market-plan.ts';
import { arg, pub, wallet, botKeys, BOOK, book, CATALOG, plansFor, activeMarkets, pinsFromArgs, sleep, now, usd, loadSchedule, type Plan } from './market-common.ts';

const EPOCHS = Number(arg('epochs', '0'));
// one market per epoch by default: 6 commits + 6 reveals + 1 clear per epoch keeps the bots' testnet gas affordable; every listed
// market still trades every LISTED.length acted epochs (12 markets: 12). --markets N quotes N markets per epoch.
const MKTS = Number(arg('markets', '1'));
const GATE = arg('gate', process.env.KEEPER_GATE_URL);   // e.g. https://skudesk.lol : trade only while /market is open somewhere
const PIN_REQUEST = pinsFromArgs();   // catalog indices of --pin; an unknown symbol exits here, before any chain call
let PINNED: number[] = PIN_REQUEST.pinned;   // narrowed to the listed markets once the pool is known
const EVERY = Math.max(1, Number(arg('every', '1')));   // act only in every Nth epoch (saves testnet ETH; the other epochs stay empty)
const bots = botKeys().map((k) => wallet(k));
const startOf = (ep: number) => book.t0 + ep * book.epochLen;
const epochAt = (t: number) => Math.floor((t - book.t0) / book.epochLen);
const sleepUntil = async (t: number) => { const d = t - now(); if (d > 0) await sleep(d * 1000); };
const log = (...a: any[]) => console.log(new Date().toISOString().slice(11, 19), ...a);
// generous limits: only gas actually used is charged, but an out-of-gas revert wastes the whole transaction
const GAS = { commit: 500_000n, reveal: 450_000n, clear: 4_000_000n };
// The chain clock runs about a second behind this machine's clock. A transaction mined with a timestamp still inside the previous
// window reverts with WrongPhase, so every phase starts this many seconds after its nominal boundary (windows are 15-20s long).
const GUARD = 1.8;

type Placed = Plan & { salt: Hex; hash: Hex; marketId: Hex; index?: number; skip?: boolean };

async function sendMany(items: { bot: number; fn: string; args: any[]; gas: bigint; ref?: unknown }[]) {
  // one in-flight nonce stream per bot, bots in parallel; receipts are awaited together afterwards
  const byBot = new Map<number, typeof items>(); items.forEach((it) => byBot.set(it.bot, [...(byBot.get(it.bot) ?? []), it]));
  const results: { item: (typeof items)[number]; hash?: Hex; err?: string }[] = [];
  await Promise.all([...byBot.entries()].map(async ([bi, list]) => {
    let nonce = await pub.getTransactionCount({ address: bots[bi].account.address, blockTag: 'pending' });
    for (const item of list) {
      try { const hash = await bots[bi].client.writeContract({ address: BOOK, abi: BOOK_ABI, functionName: item.fn, args: item.args, nonce, gas: item.gas } as any); nonce++; results.push({ item, hash }); }   // the nonce moves only after the node accepted the tx: a failed send must not leave a gap that strands the bot's later txs
      catch (e: any) { results.push({ item, err: String(e.shortMessage ?? e.message).slice(0, 140) }); }
    }
  }));
  const receipts = await Promise.all(results.map(async (r) => { if (!r.hash) return null; try { return await pub.waitForTransactionReceipt({ hash: r.hash, timeout: 25_000 }); } catch { return null; } }));
  return results.map((r, i) => ({ ...r, receipt: receipts[i] }));
}

/** Catalog indices that are listed on this book (a market added to the catalog is quoted only after tools/market-setup.ts lists it). */
let LISTED: number[] = [];
async function listedPool(): Promise<number[]> {
  const flags = await Promise.all(CATALOG.map((m) => pub.readContract({ address: BOOK, abi: BOOK_ABI, functionName: 'markets', args: [m.marketId] }) as Promise<readonly [boolean, bigint]>));
  const pool = CATALOG.map((_, i) => i).filter((i) => flags[i][0]);
  const missing = CATALOG.filter((_, i) => !flags[i][0]).map((m) => m.symbol);
  if (missing.length) log(`not listed on this book yet, skipped (run tools/market-setup.ts): ${missing.join(', ')}`);
  if (!pool.length) throw new Error(`no catalog market is listed on ${BOOK}: run tools/market-setup.ts first`);
  return pool;
}

let sweptAll = false;
async function sweepUncleared(current: number) {
  for (let ep = Math.max(0, current - 3); ep < current; ep++) {
    if (now() < startOf(ep) + book.revealEnd + 1) continue;
    // the first sweep after a start checks every listed market (an earlier run may have used another rotation); later sweeps only the
    // markets this keeper quoted in that epoch, which keeps the reads per epoch flat as the catalog grows
    for (const m of (sweptAll ? activeMarkets(ep, MKTS, LISTED, EVERY, PINNED) : LISTED).map((i) => CATALOG[i])) {
      const [n, done] = await Promise.all([pub.readContract({ address: BOOK, abi: BOOK_ABI, functionName: 'orderCount', args: [m.marketId, BigInt(ep)] }), pub.readContract({ address: BOOK, abi: BOOK_ABI, functionName: 'cleared', args: [m.marketId, BigInt(ep)] })]) as [bigint, boolean];
      if (n > 0n && !done) { const r = await sendMany([{ bot: 0, fn: 'clear', args: [m.marketId, BigInt(ep)], gas: GAS.clear }]); log(`swept epoch ${ep} ${m.symbol}: ${r[0].receipt?.status ?? r[0].err}`); }
    }
  }
  sweptAll = true;
}

let lastWatched: boolean | undefined;
/** Asks the site whether /market was opened recently. Any error counts as "not watched" so a broken gate never burns ETH. */
async function watched(): Promise<boolean> {
  let on = false;
  try { const r = await fetch(`${GATE}/api/market/active`, { signal: AbortSignal.timeout(8000) }); on = r.ok && (await r.json()).active === true; } catch { on = false; }
  if (on !== lastWatched) { lastWatched = on; log(on ? 'someone is watching /market: bots trading' : 'nobody is watching /market: bots idle (no transactions)'); }
  return on;
}

async function runEpoch(ep: number) {
  const mIdxs = activeMarkets(ep, MKTS, LISTED, EVERY, PINNED);
  const orders: Placed[] = mIdxs.flatMap((mi) => plansFor(CATALOG[mi], mi, ep)).map((p) => {
    const m = CATALOG[p.marketIdx]; const salt = ('0x' + randomBytes(32).toString('hex')) as Hex;
    const hash = keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'uint256' }, { type: 'address' }, { type: 'uint8' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'bytes32' }], [m.marketId, BigInt(ep), bots[p.bot].account.address, p.side, BigInt(p.price), BigInt(p.units), salt]));
    // a couple of the noise traders occasionally never reveal: the bond is forfeited, which is part of the protocol
    const flaky = (p.bot === 2 || p.bot === 5) && Number(BigInt(keccak256(salt)) % 100n) < 6;
    return { ...p, salt, hash, marketId: m.marketId, skip: flaky };
  });

  // COMMIT (hashes only: nothing about price, size or side is visible on-chain yet)
  await sleepUntil(startOf(ep) + GUARD);
  if (epochAt(now()) !== ep) { log(`epoch ${ep}: missed the window, skipping`); return; }
  const commits = await sendMany(orders.map((o) => ({ bot: o.bot, fn: 'commit', args: [o.marketId, o.hash], gas: GAS.commit, ref: o })));
  let okCommits = 0;
  // results come back in completion order, so each one carries the order it belongs to (never match by array position)
  for (const r of commits) if (r.receipt?.status === 'success') { const ev = parseEventLogs({ abi: BOOK_ABI, logs: r.receipt.logs, eventName: 'Committed' })[0]; (r.item.ref as Placed).index = Number(ev.args.index); okCommits++; }
  log(`epoch ${ep}: committed ${okCommits}/${orders.length} sealed orders across ${mIdxs.map((i) => CATALOG[i].symbol).join(', ')}`);
  const badCommits = commits.filter((r) => r.receipt?.status !== 'success');
  if (badCommits.length) { log(`   commit problem: ${badCommits.length} failed. first: ${badCommits[0].err ?? (badCommits[0].receipt ? 'reverted on-chain' : 'no receipt')}`); if (badCommits[0].hash) log(`   tx ${badCommits[0].hash}`); }

  // REVEAL
  await sleepUntil(startOf(ep) + book.commitEnd + GUARD);
  const toReveal = orders.filter((o) => o.index !== undefined && !o.skip);
  const reveals = await sendMany(toReveal.map((o) => ({ bot: o.bot, fn: 'reveal', args: [o.marketId, BigInt(ep), BigInt(o.index!), o.side, BigInt(o.price), BigInt(o.units), o.salt], gas: GAS.reveal })));
  const revealed = reveals.filter((r) => r.receipt?.status === 'success').length;
  log(`epoch ${ep}: revealed ${revealed}/${toReveal.length}${orders.length - toReveal.length > 0 ? ` (${orders.filter((o) => o.index !== undefined && o.skip).length} deliberately not revealed)` : ''}`);
  reveals.filter((r) => r.err || r.receipt?.status !== 'success').forEach((r) => log('   reveal problem:', r.err ?? (r.receipt ? 'reverted' : 'no receipt'), r.hash ?? ''));

  // CLEAR
  await sleepUntil(startOf(ep) + book.revealEnd + GUARD);
  const clears = await sendMany(mIdxs.filter((mi) => orders.some((o) => o.marketIdx === mi && o.index !== undefined)).map((mi) => ({ bot: 0, fn: 'clear', args: [CATALOG[mi].marketId, BigInt(ep)], gas: GAS.clear })));
  for (const c of clears) {
    const m = CATALOG.find((x) => x.marketId === (c.item.args[0] as Hex))!;
    if (c.receipt?.status === 'success') { const ev = parseEventLogs({ abi: BOOK_ABI, logs: c.receipt.logs, eventName: 'EpochCleared' })[0]; log(`   ${m.symbol.padEnd(10)} ${ev.args.volume > 0n ? `cleared at ${usd(ev.args.price)} for ${ev.args.volume} units` : 'no cross, no trade'}  (${ev.args.buys} bids, ${ev.args.sells} asks, ${ev.args.forfeited} forfeited)  gas ${c.receipt.gasUsed}`); }
    else log(`   ${m.symbol} clear FAILED:`, c.err ?? 'reverted');
  }
}

async function main() {
  await loadSchedule(); LISTED = await listedPool();
  const unlistedPins = pinsFromArgs(LISTED).unlisted; PINNED = PINNED.filter((i) => LISTED.includes(i));
  if (unlistedPins.length) log(`WARNING: --pin ${unlistedPins.join(', ')} is not listed on this book (run tools/market-setup.ts), ignored`);
  if (PINNED.length > MKTS) log(`WARNING: ${PINNED.length} pinned markets exceed --markets ${MKTS}: all ${PINNED.length} are quoted every acted epoch and nothing rotates`);
  const latest = await pub.getBlock(); const skew = Number(latest.timestamp) - now();
  log(`keeper up. book ${BOOK}, schedule ${book.epochLen}s (commit <${book.commitEnd}s, reveal <${book.revealEnd}s), ${LISTED.length}/${CATALOG.length} markets listed, ${MKTS} active per acted epoch (${PINNED.length ? `pinned every acted epoch: ${PINNED.map((i) => CATALOG[i].symbol).join(', ')}; the others` : 'each'} quoted at least every ${maxGap(LISTED.length, MKTS, PINNED.length)} acted epochs), acting in 1 of every ${EVERY} epochs, chain-vs-wall skew ${skew.toFixed(1)}s (latest block may be older than now on a quiet chain)`);
  for (let i = 0; i < bots.length; i++) log(`  bot ${i} ${bots[i].account.address} gas ${formatEther(await pub.getBalance({ address: bots[i].account.address }))} ETH`);
  let done = 0;
  for (;;) {
    try { if (!GATE || lastWatched) await sweepUncleared(epochAt(now())); } catch (e: any) { log(`sweep skipped: ${e?.shortMessage ?? e?.message}`); await sleep(2000); }   // one RPC read error must not stop the keeper
    const ep = epochAt(now()) + (now() - startOf(epochAt(now())) < 2 ? 0 : 1);
    if (ep % EVERY !== 0) { await sleep(Math.max(500, (startOf(ep) - now()) * 1000 + 300)); continue; }   // idle epoch: no transactions
    if (GATE && !(await watched())) { await sleep(Math.max(500, (startOf(ep + 1) - now()) * 1000 + 300)); continue; }   // nobody is looking: no transactions
    try { await runEpoch(ep); } catch (e: any) { log(`epoch ${ep} crashed: ${e?.shortMessage ?? e?.message}`); await sleep(2000); }
    if (EPOCHS && ++done >= EPOCHS) break;
  }
  for (let i = 0; i < bots.length; i++) log(`  bot ${i} gas left ${formatEther(await pub.getBalance({ address: bots[i].account.address }))} ETH`);
  log('keeper finished');
}
main().catch((e) => { console.error('KEEPER FAILED:', e instanceof Error ? e.message : e); process.exit(1); });
process.on('SIGINT', () => { console.log('\nstopping'); process.exit(0); });
