// Lists every catalog market the book does not list yet (the six Accessories are listed by DeployBook at deploy time, so only the twelve
// main products need listMarket; the listed flag is read first and a listed market is never listed again), then prepares the bot wallets: gas, mock tokens, book cash, and inventory units.
// Idempotent: it only lists and tops up what is missing.
//   node --env-file=../../.env tools/market-setup.ts [--generate] [--rpc URL] [--chain 46630] [--eth 0.0025] [--batch 40] [--markets 1] [--pin SYMBOL[,SYMBOL] ...]
// --pin: the keeper quotes those markets in every acted epoch, so their cash and seller inventory are sized for --batch quotes each.
// --generate creates 6 bot wallets and appends BOT_PRIVATE_KEYS / BOT_ADDRESSES to the gitignored .env (keys are never printed).
import fs from 'node:fs';
import path from 'node:path';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { parseEther, formatEther, type Hex } from 'viem';
import { BOOK_ABI, ERC20_ABI } from '../src/lib/book-abi.ts';
import { cashTargetTokens, marketsToList, sellerUnitsTarget, worstBuyerSpendCents } from './market-plan.ts';
import { arg, pinsFromArgs, pub, wallet, ownerKey, botKeys, BOOK, TOKEN, CATALOG, usd } from './market-common.ts';

// Book cash per bot (6 decimals): enough for the worst case of one supervisor batch (--batch epochs, --markets per epoch) at the catalog's
// reference prices, every buyer order filling completely, plus 25 % (tools/market-plan.ts). The supervisor tops up before every batch.
const BATCH = Number(arg('batch', '40')); const MKTS = Number(arg('markets', '1'));
const PINNED = pinsFromArgs().pinned;   // catalog indices; an unknown symbol exits before anything is sent
const CASH_TARGET = BigInt(cashTargetTokens(CATALOG, BATCH, MKTS, PINNED)) * 1_000_000n;
// Inventory units per seller bot per market: 50 batches of the lot's largest sale, never below the lot's floor (tools/market-plan.ts).
const unitsTarget = (lot: Parameters<typeof sellerUnitsTarget>[0], idx: number) => BigInt(sellerUnitsTarget(lot, BATCH, MKTS, CATALOG.length, PINNED.length, PINNED.includes(idx)));
const ETH_EACH = parseEther(arg('eth', '0.0025')!);
const SELLERS = [3, 4, 5];

async function main() {
  if (!process.env.BOT_PRIVATE_KEYS && process.argv.includes('--generate')) {
    const keys = Array.from({ length: 6 }, () => generatePrivateKey());
    const envPath = path.resolve('../../.env'); fs.appendFileSync(envPath, `\nBOT_PRIVATE_KEYS=${keys.join(',')}\nBOT_ADDRESSES=${keys.map((k) => privateKeyToAccount(k).address).join(',')}\n`);
    process.env.BOT_PRIVATE_KEYS = keys.join(','); console.log('generated 6 bot wallets into .env (keys not shown)');
  }
  const owner = wallet(ownerKey()); const bots = botKeys().map((k: Hex) => wallet(k));
  console.log('owner', owner.account.address, 'book', BOOK, 'token', TOKEN);
  const send = async (w: ReturnType<typeof wallet>, address: Hex, abi: any, fn: string, args: any[]) => {
    const hash = await w.client.writeContract({ address, abi, functionName: fn, args } as any); const rc = await pub.waitForTransactionReceipt({ hash });
    if (rc.status !== 'success') throw new Error(`${fn} reverted (${hash})`); return rc;
  };
  console.log(`book cash target ${usd(CASH_TARGET / 10_000n)} per bot (worst buyer spend ${usd(worstBuyerSpendCents(CATALOG, BATCH, MKTS, PINNED))} in ${BATCH} epochs at ${MKTS} market(s) per epoch${PINNED.length ? `, pinned every epoch: ${PINNED.map((i) => CATALOG[i].symbol).join(', ')}` : ''})`);
  // 0) list the catalog markets the book does not know yet (owner only; a catalog entry cannot trade or receive units before this).
  //    Idempotent: markets(id) is read first, and listMarket would revert on an already listed id.
  const flags: boolean[] = [];
  for (const m of CATALOG) { const [listed] = (await pub.readContract({ address: BOOK, abi: BOOK_ABI, functionName: 'markets', args: [m.marketId] })) as readonly [boolean, bigint]; flags.push(listed); }
  for (const m of marketsToList(CATALOG, flags)) { await send(owner, BOOK, BOOK_ABI, 'listMarket', [m.marketId, BigInt(m.tick)]); console.log('  listed', m.symbol, m.marketId); }
  // 1) gas for the bots (sequential from the owner so nonces never collide)
  for (const b of bots) {
    const bal = await pub.getBalance({ address: b.account.address });
    if (bal < ETH_EACH / 2n) { const hash = await owner.client.sendTransaction({ to: b.account.address, value: ETH_EACH - bal }); await pub.waitForTransactionReceipt({ hash }); console.log('  funded gas', b.account.address, formatEther(ETH_EACH)); }
  }
  // 2) tokens -> book cash (parallel across bots, sequential within one bot)
  const mintNeeded: bigint[] = [];
  for (const b of bots) { const inBook = (await pub.readContract({ address: BOOK, abi: BOOK_ABI, functionName: 'cash', args: [b.account.address] })) as bigint; const held = (await pub.readContract({ address: TOKEN, abi: ERC20_ABI, functionName: 'balanceOf', args: [b.account.address] })) as bigint; mintNeeded.push(inBook + held < CASH_TARGET ? CASH_TARGET - inBook - held : 0n); }
  for (let i = 0; i < bots.length; i++) if (mintNeeded[i] > 0n) await send(owner, TOKEN, ERC20_ABI, 'mint', [bots[i].account.address, mintNeeded[i]]);
  await Promise.all(bots.map(async (b) => {
    const held = (await pub.readContract({ address: TOKEN, abi: ERC20_ABI, functionName: 'balanceOf', args: [b.account.address] })) as bigint;
    if (held > 0n) { await send(b, TOKEN, ERC20_ABI, 'approve', [BOOK, 2n ** 256n - 1n]); await send(b, BOOK, BOOK_ABI, 'deposit', [held]); }
  }));
  // 3) inventory units for the sellers (owner-issued receipts)
  for (const si of SELLERS) for (const [mi, m] of CATALOG.entries()) {
    const have = (await pub.readContract({ address: BOOK, abi: BOOK_ABI, functionName: 'unitsOf', args: [m.marketId, bots[si].account.address] })) as bigint;
    const target = unitsTarget(m.lot, mi);
    if (have < target) await send(owner, BOOK, BOOK_ABI, 'issue', [m.marketId, bots[si].account.address, target - have]);
  }
  for (let i = 0; i < bots.length; i++) {
    const cash = (await pub.readContract({ address: BOOK, abi: BOOK_ABI, functionName: 'cash', args: [bots[i].account.address] })) as bigint;
    console.log(`bot ${i} ${bots[i].account.address} ${SELLERS.includes(i) ? 'seller' : 'buyer '}  book cash ${usd(cash / 10_000n)}  gas ${formatEther(await pub.getBalance({ address: bots[i].account.address }))} ETH`);
  }
  console.log('setup complete');
}
main().catch((e) => { console.error('SETUP FAILED:', e instanceof Error ? e.message : e); process.exit(1); });
