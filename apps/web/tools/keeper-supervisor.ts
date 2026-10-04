// Keeps the market alive across testnet outages. Waits until the chain really accepts a transaction, tops up bot gas from the owner,
// then runs the keeper in batches; if a batch ends (or the chain stalls again) it waits and starts over.
//   node --env-file=../../.env tools/keeper-supervisor.ts [--batch 40] [--max-epochs 300] [--markets 1] [--pin SYMBOL[,SYMBOL] ...] [--every 1] [--gate URL] [--chain 46630] [--rpc URL]
// --pin is passed to the keeper (the pinned market is quoted in every acted epoch) and to market-setup (cash and inventory are sized for it).
import { spawn } from 'node:child_process';
import { parseEther, formatEther } from 'viem';
import { parsePins } from './market-plan.ts';
import { arg, pinsFromArgs, pub, wallet, ownerKey, botKeys, sleep } from './market-common.ts';

pinsFromArgs();   // an unknown --pin symbol exits now instead of failing every keeper batch
const PIN_ARGS = parsePins(process.argv).length ? ['--pin', parsePins(process.argv).join(',')] : [];   // forwarded as one comma list
const BATCH = Number(arg('batch', '40')); const MAX = Number(arg('max-epochs', '300'));
const MIN_GAS = parseEther('0.0008'); const TOP_TO = parseEther('0.002');
const owner = wallet(ownerKey()); const bots = botKeys().map((k) => wallet(k));
const log = (...a: any[]) => console.log(new Date().toISOString().slice(11, 19), 'supervisor:', ...a);
const withTimeout = <T,>(p: Promise<T>, ms: number) => Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);

/** A chain that is "up" for reads can still refuse writes (the public testnet did): prove it with a real zero-value transaction. */
// The probe is sent from the OWNER wallet: a bot with no ETH must not make a healthy chain look dead.
async function chainAcceptsTransactions(): Promise<boolean> {
  try { const b = owner; const hash = await withTimeout(b.client.sendTransaction({ to: b.account.address, value: 0n }), 20_000); const rc = await pub.waitForTransactionReceipt({ hash, timeout: 25_000 }); return rc.status === 'success'; } catch { return false; }
}
async function topUp() {
  for (const b of bots) {
    const bal = await pub.getBalance({ address: b.account.address });
    if (bal < MIN_GAS) { const hash = await owner.client.sendTransaction({ to: b.account.address, value: TOP_TO - bal }); await pub.waitForTransactionReceipt({ hash }); log(`topped up ${b.account.address} to ${formatEther(TOP_TO)} ETH`); }
  }
}
/** Buyers pay sellers every trade, so book cash drifts to the sellers (a buyer bot ran out and could no longer afford the commit bond).
 *  Before each batch, run the idempotent setup, which tops up only what is missing: bot gas, book cash, and seller inventory. */
const rebalance = () => new Promise<number>((resolve) => {
  const child = spawn(process.execPath, ['--env-file=../../.env', 'tools/market-setup.ts', '--batch', String(BATCH), '--markets', arg('markets', '1')!, ...PIN_ARGS, ...(arg('chain') ? ['--chain', arg('chain')!] : []), ...(arg('rpc') ? ['--rpc', arg('rpc')!] : [])], { stdio: ['ignore', 'inherit', 'inherit'] });
  child.on('exit', (code) => resolve(code ?? 1));
});
const runKeeper = (epochs: number) => new Promise<number>((resolve) => {
  const child = spawn(process.execPath, ['--env-file=../../.env', 'tools/keeper.ts', '--epochs', String(epochs), '--markets', arg('markets', '1')!, '--every', arg('every', '1')!, ...PIN_ARGS, ...(arg('gate') ? ['--gate', arg('gate')!] : []), ...(arg('chain') ? ['--chain', arg('chain')!] : []), ...(arg('rpc') ? ['--rpc', arg('rpc')!] : [])], { stdio: ['ignore', 'inherit', 'inherit'] });
  child.on('exit', (code) => resolve(code ?? 1));
});

let done = 0;
while (done < MAX) {
  let waited = 0; while (!(await chainAcceptsTransactions())) { if (waited % 10 === 0) log(`chain is not accepting transactions, waiting (${waited * 30}s)`); waited++; await sleep(30_000); }
  log('chain accepts transactions'); try { await topUp(); } catch (e: any) { log('top-up failed:', e?.shortMessage ?? e?.message); }
  log('rebalancing bot cash and inventory'); const rc = await rebalance(); if (rc !== 0) log(`rebalance exited with ${rc} (continuing)`);
  const n = Math.min(BATCH, MAX - done); log(`starting keeper batch of ${n} epochs (${done}/${MAX} done)`); const code = await runKeeper(n); done += n; log(`batch ended with exit code ${code}`);
}
log('supervisor finished');
