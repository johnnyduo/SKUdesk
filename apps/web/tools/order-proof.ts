// OrderEscrow proof on Robinhood Chain Testnet (46630): one SKU, one named verifier, script-driven, every step a real transaction.
//   node --env-file=../../.env tools/order-proof.ts [--dry-run] [--eth 0.002] [--skip-timeout | --wait-timeout] [--rpc URL]
//        [--deployment ../../packages/contracts/deployments/orders-46630.json] [--state .env.proof-state.json] [--wallets .env.proof-wallets.json]
//
// WHO IS WHO (stated openly, also written into src/data/orders.json):
//   The deployer key is the OrderEscrow VERIFIER (it decides whether goods arrived), the BlindBook OWNER (it issues the sellers' units) and
//   the mUSDG token OWNER (it mints the test money). Buyer, seller A, seller B and a BlindBook bidder are four fresh script-controlled wallets.
//   No physical goods move: the delivery is attested by the verifier. The ship-to is an opaque hash of a random salt and a literal text.
//
// Orders: #1 delivered and released (price evidence from seller A, the cheaper ask), #2 refunded by the buyer before the seller accepts,
// #3 (only if the ship window is 20 minutes or less, or with --wait-timeout) the seller accepts and never ships: anyone calls refundUnshipped, bond slashed.
// Resumable: every transaction is recorded in the state file before its receipt is awaited, so a re-run continues where it stopped.
// --dry-run reads the chain and prints the plan; it sends nothing and writes nothing.
import { encodeAbiParameters, encodePacked, keccak256, toHex, parseAbi, parseEventLogs, parseEther, formatEther, getAddress, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ORDERS_ABI } from '../src/lib/orders-abi.ts';
import { BOOK_ABI, ERC20_ABI } from '../src/lib/book-abi.ts';
import { CENT, bondFor, fmtMusdc, fmtPrice, statusName, fetchEscrowEvents, attachTimes, type EscrowEvent } from '../src/lib/orders.ts';

const argv = (k: string, d?: string) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const DRY = process.argv.includes('--dry-run');
const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a);
const EXPLORER = 'https://explorer.testnet.chain.robinhood.com';
const txUrl = (h: string) => `${EXPLORER}/tx/${h}`;
const HERO = 'CASE-IP16PRO-CLEAR-MAG-001';
const WALLETS_FILE = path.resolve(argv('wallets', '.env.proof-wallets.json')!);   // matches the .env.* ignore rule: never committed
const STATE_FILE = path.resolve(argv('state', '.env.proof-state.json')!);          // same
const DEPLOYMENT_FILE = path.resolve(argv('deployment', '../../packages/contracts/deployments/orders-46630.json')!);
const OUT_FILE = path.resolve('src/data/orders.json');

// a missing .env must be a clear message, not a stack trace from deep inside viem
const missingEnv = ['DEPLOYER_PRIVATE_KEY'].filter((k) => !process.env[k]);
if (!process.env.ROBINHOOD_RPC && !argv('rpc')) missingEnv.unshift('ROBINHOOD_RPC');
if (missingEnv.length) { console.error(`ORDER PROOF REFUSED: missing ${missingEnv.join(', ')}. Run from apps/web with: node --env-file=../../.env tools/order-proof.ts`); process.exit(1); }
const mc = await import('./market-common.ts');
const { pub, wallet, book, BOOK, TOKEN, CATALOG, loadSchedule, sleep, now, CHAIN_ID } = mc;

const OWNER_ABI = parseAbi(['function owner() view returns (address)']);
// generous fixed limits for the time-boxed BlindBook calls (same values as the keeper): an estimate made just before a phase boundary can be wrong
const GAS = { commit: 500_000n, reveal: 450_000n };
const GUARD = Number(argv('guard', '3'));   // seconds after a nominal phase boundary: the chain clock runs 1 to 2 seconds behind this machine (the keeper uses 1.8)
const rd = (address: Hex, abi: any, functionName: string, args: any[] = []) => pub.readContract({ address, abi, functionName, args } as any) as Promise<any>;

// preflight (shared by --dry-run and the real run)
type Check = { ok: boolean; label: string; detail?: string };
const checks: Check[] = [];
const check = (ok: boolean, label: string, detail?: string) => { checks.push({ ok, label, detail }); log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? '  ' + detail : ''}`); return ok; };

type Dep = { chainId: number; escrow: Hex; book: Hex; token: Hex; market: Hex; sku: Hex; verifier: Hex; bondBps: number; acceptWindow: number; shipWindow: number; verifyWindow: number; disputeWindow: number; resolveWindow: number };
const deployer = privateKeyToAccount(process.env.DEPLOYER_PRIVATE_KEY as Hex);   // only the address is ever printed
const MARKET_ID = keccak256(toHex(HERO));
const SKU = keccak256(encodeAbiParameters([{ type: 'string' }, { type: 'string' }, { type: 'string' }, { type: 'string' }], ['SKU1', 'iPhone 16 Pro Clear MagSafe Case', 'iPhone 16 Pro', 'new-sealed']));
const catalogEntry = CATALOG.find((m) => m.id === HERO);

async function preflight() {
  const chainId = await pub.getChainId();
  check(CHAIN_ID === 46630 && chainId === 46630, 'chain is Robinhood Chain Testnet (46630)', `configured ${CHAIN_ID}, RPC reports ${chainId}`);
  check(!!catalogEntry, `catalog lists ${HERO}`);
  const [bookOwner, tokenOwner, paused, listed, ethBal] = await Promise.all([rd(BOOK, BOOK_ABI, 'owner'), rd(TOKEN, OWNER_ABI, 'owner'), rd(BOOK, BOOK_ABI, 'paused'), rd(BOOK, BOOK_ABI, 'markets', [MARKET_ID]), pub.getBalance({ address: deployer.address })]) as any[];
  check(getAddress(bookOwner) === deployer.address, 'deployer key is the BlindBook owner (issues the sellers’ units)', deployer.address);
  check(getAddress(tokenOwner) === deployer.address, 'deployer key is the mUSDG owner (mints test money)');
  check(!paused, 'BlindBook is not paused'); check(listed[0] === true, 'hero market is listed in BlindBook', `tick ${listed[1]}`);
  await loadSchedule();
  check(book.epochLen >= 30 && book.commitEnd >= 10, 'BlindBook schedule is long enough to commit, reveal and clear', `${book.epochLen}s epoch, commit < ${book.commitEnd}s, reveal < ${book.revealEnd}s, bond ${fmtMusdc(book.bond)}`);

  // the escrow: refuse unless the lead deployed it and recorded it
  let dep: Dep | undefined;
  if (!fs.existsSync(DEPLOYMENT_FILE)) check(false, 'deployments/orders-46630.json exists (the lead creates it when OrderEscrow is deployed)', DEPLOYMENT_FILE);
  else {
    const j = JSON.parse(fs.readFileSync(DEPLOYMENT_FILE, 'utf8'));
    check(Number(j.chainId) === 46630, 'deployment file is for chain 46630', String(j.chainId));
    dep = { chainId: Number(j.chainId), escrow: getAddress(j.escrow), book: getAddress(j.book), token: getAddress(j.token), market: j.market, sku: j.sku, verifier: getAddress(j.verifier), bondBps: Number(j.bondBps),
      acceptWindow: Number(j.acceptWindow), shipWindow: Number(j.shipWindow), verifyWindow: Number(j.verifyWindow), disputeWindow: Number(j.disputeWindow), resolveWindow: Number(j.resolveWindow) };
    const code = await pub.getCode({ address: dep.escrow });
    if (!check(!!code && code !== '0x', 'OrderEscrow has code at the recorded address', dep.escrow)) dep = undefined;
  }
  if (dep) {
    // trust the chain, not the file: every parameter is read back from the contract
    let on: any[] | undefined;
    try { on = await Promise.all(['token', 'book', 'MARKET', 'SKU', 'verifier', 'bondBps', 'acceptWindow', 'shipWindow', 'verifyWindow', 'disputeWindow', 'resolveWindow', 'CENT', 'nextId'].map((f) => rd(dep!.escrow, ORDERS_ABI, f))); }
    catch (e: any) { check(false, 'the contract at that address answers like OrderEscrow', String(e?.shortMessage ?? e?.message).slice(0, 120)); dep = undefined; }
    if (on) {
    const [token, bk, market, sku, verifier, bps, accept, ship, verify, dispute, resolve, cent] = on;
    check(getAddress(bk) === BOOK && getAddress(token) === TOKEN, 'escrow points at the deployed BlindBook and mUSDG');
    check(market === MARKET_ID, 'escrow MARKET is keccak256("CASE-IP16PRO-CLEAR-MAG-001")'); check(sku === SKU, 'escrow SKU is keccak256(abi.encode("SKU1", model, variant, condition))');
    check(getAddress(verifier) === deployer.address, 'the deployer key is the escrow verifier (needed for attest)', verifier);
    check(BigInt(cent) === CENT, 'CENT is 10000');
    Object.assign(dep!, { verifier: getAddress(verifier), bondBps: Number(bps), acceptWindow: Number(accept), shipWindow: Number(ship), verifyWindow: Number(verify), disputeWindow: Number(dispute), resolveWindow: Number(resolve), market, sku });
    log(`     escrow ${dep!.escrow}, bond ${Number(bps) / 100}%, windows accept ${accept}s ship ${ship}s verify ${verify}s dispute ${dispute}s resolve ${resolve}s, next order id ${on[12]}`);
    }
  }
  return { dep, ethBal: ethBal as bigint, tick: Number(listed[1]) };
}

// plan (amounts)
const ETH_EACH = parseEther(argv('eth', '0.002')!);
const QTY = 1n; const SELL_UNITS = 2n; const BID_UNITS = 4n;
const ATTEMPTS = 3n;   // a round that is missed (late block, full book) forfeits each commit bond to BlindBook, so cash for three tries is deposited
type Plan = { ref: number; askA: number; askB: number; bid: number; cap: number; bond: bigint; timeoutPath: boolean; orders: number; mint: Record<string, bigint>; totalMint: bigint };
async function makePlan(dep: Dep | undefined, tick: number): Promise<Plan> {
  const last = Number(await rd(BOOK, BOOK_ABI, 'lastPrice', [MARKET_ID]));
  const ref = last > 0 ? last : (catalogEntry?.referenceCents ?? 1099);
  const snap = (x: number) => Math.max(tick, Math.round(x / tick) * tick);
  const askA = snap(ref * 0.97); const askB = Math.max(snap(ref * 0.98), askA + tick); const bid = snap(ref * 1.06);
  const cap = Math.ceil(ref * 1.2);
  const bps = dep?.bondBps ?? 2000; const ship = dep?.shipWindow ?? 1800;
  const timeoutPath = !process.argv.includes('--skip-timeout') && (ship <= 1200 || process.argv.includes('--wait-timeout'));
  const orders = timeoutPath ? 3 : 2;
  const bond = bondFor(cap, QTY, bps);
  const bookBond = BigInt(book.bond) * ATTEMPTS;
  const mint = { buyer: BigInt(cap) * QTY * CENT * BigInt(orders), sellerA: bond + bookBond, sellerB: bond + bookBond, bidder: BigInt(bid) * BID_UNITS * CENT + bookBond };
  return { ref, askA, askB, bid, cap, bond, timeoutPath, orders, mint, totalMint: Object.values(mint).reduce((a, b) => a + b, 0n) };
}

const revivePlan = (p: any): Plan => ({ ...p, bond: BigInt(p.bond), totalMint: BigInt(p.totalMint), mint: Object.fromEntries(Object.entries(p.mint).map(([k, v]) => [k, BigInt(v as string)])) });

// state (resumable) and wallets (gitignored)
type StepRec = { label: string; role: string; cat: 'setup' | 'round' | 'order'; order?: number; hash: Hex; status: 'sent' | 'ok'; block?: number; extra?: any };
type State = { v: 1; escrow: string; startedAt: string; startBlock?: number; steps: Record<string, StepRec>; vars: Record<string, any> };
let S: State;
const save = () => fs.writeFileSync(STATE_FILE, JSON.stringify(S, null, 1), { mode: 0o600 });
type Role = 'owner' | 'buyer' | 'sellerA' | 'sellerB' | 'bidder';
type Wlt = ReturnType<typeof wallet>;
const W = {} as Record<Role, Wlt>;
const NAMES: Role[] = ['buyer', 'sellerA', 'sellerB', 'bidder'];
function loadWallets(create: boolean) {
  let f: { chainId: number; wallets: Record<string, { address: string; key: Hex }> } | undefined;
  if (fs.existsSync(WALLETS_FILE)) f = JSON.parse(fs.readFileSync(WALLETS_FILE, 'utf8'));
  else if (create) {
    f = { chainId: 46630, wallets: Object.fromEntries(NAMES.map((n) => { const key = generatePrivateKey(); return [n, { address: privateKeyToAccount(key).address, key }]; })) };
    fs.writeFileSync(WALLETS_FILE, JSON.stringify(f, null, 1), { mode: 0o600 }); log(`generated 4 fresh wallets into ${path.basename(WALLETS_FILE)} (gitignored, keys are never printed)`);
  }
  if (!f) return null;
  W.owner = wallet(process.env.DEPLOYER_PRIVATE_KEY as Hex);
  for (const n of NAMES) W[n] = wallet(f.wallets[n].key);
  return Object.fromEntries(NAMES.map((n) => [n, getAddress(f!.wallets[n].address)])) as Record<Role, Hex>;
}

/** One transaction, recorded in the state file BEFORE its receipt is awaited, skipped when already done, resumed when only sent. */
async function send<T = undefined>(o: { key: string; label: string; role: Role; cat: StepRec['cat']; order?: number; to: Hex; abi?: any; fn?: string; args?: any[]; value?: bigint; gas?: bigint; parse?: (rc: any) => T }): Promise<{ hash: Hex; block: number; extra: T }> {
  const prev = S.steps[o.key];
  if (prev?.status === 'ok') { log(`  skip   ${o.label} (already done) ${txUrl(prev.hash)}`); return { hash: prev.hash, block: prev.block!, extra: prev.extra }; }
  let hash: Hex;
  if (prev?.status === 'sent') { hash = prev.hash; log(`  resume ${o.label}: waiting for the transaction sent earlier`); }
  else {
    const c = W[o.role].client as any;
    hash = o.fn ? await c.writeContract({ address: o.to, abi: o.abi, functionName: o.fn, args: o.args ?? [], gas: o.gas }) : await c.sendTransaction({ to: o.to, value: o.value });
    S.steps[o.key] = { label: o.label, role: o.role, cat: o.cat, order: o.order, hash, status: 'sent' }; save();
  }
  const rc = await pub.waitForTransactionReceipt({ hash, timeout: 120_000 });
  if (rc.status !== 'success') { delete S.steps[o.key]; save(); throw new Error(`${o.label} reverted on chain: ${txUrl(hash)}`); }
  const extra = o.parse ? o.parse(rc) : undefined;
  S.steps[o.key] = { ...S.steps[o.key], status: 'ok', block: Number(rc.blockNumber), extra }; save();
  log(`  done   ${o.label}  ${txUrl(hash)}`);
  return { hash, block: Number(rc.blockNumber), extra: extra as T };
}
const stepHash = (key: string) => S.steps[key]?.hash;
const escrowLogs = (rc: any, escrow: Hex) => rc.logs.filter((l: any) => getAddress(l.address) === escrow);

// assertions (recorded into orders.json)
const asserts: { order: number | 'setup'; label: string; ok: boolean; detail: string }[] = [];
function must(order: number | 'setup', label: string, ok: boolean, detail: string) {
  const i = asserts.findIndex((a) => a.order === order && a.label === label); const rec = { order, label, ok, detail }; if (i >= 0) asserts[i] = rec; else asserts.push(rec);
  S.vars.asserts = asserts; save(); log(`  ASSERT ${ok ? 'PASS' : 'FAIL'} ${label}: ${detail}`);
  if (!ok) throw new Error(`assertion failed: ${label} (${detail})`);
}

// the run
async function main() {
  const { dep, ethBal, tick } = await preflight();
  const resumeState = fs.existsSync(STATE_FILE) ? (JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) as State) : null;
  // prices come from BlindBook's last clearing price, which moves: a resumed run must keep the plan it started with (caps, bonds, funding)
  const plan: Plan = resumeState?.vars.plan ? revivePlan(resumeState.vars.plan) : await makePlan(dep, tick);
  const existing = fs.existsSync(WALLETS_FILE) ? loadWallets(false) : null;
  const need = ETH_EACH * 4n + parseEther('0.004');
  check(ethBal >= need, `deployer has enough ETH for gas + funding the four wallets`, `${formatEther(ethBal)} ETH, needs about ${formatEther(need)}`);
  if (resumeState && dep) check(getAddress(resumeState.escrow) === dep.escrow, 'state file belongs to this escrow', resumeState.escrow);

  printPlan(dep, plan, existing, resumeState);
  const failed = checks.filter((c) => !c.ok);
  if (DRY) { log(failed.length ? `dry run: ${failed.length} check(s) FAILED, a real run would refuse. Nothing was sent.` : 'dry run: all checks passed. Nothing was sent.'); process.exit(failed.length ? 1 : 0); }
  if (failed.length || !dep) { console.error(`ORDER PROOF REFUSED: ${failed.length} check(s) failed (see FAIL lines above). Nothing was sent.`); process.exit(1); }

  // real run from here
  const addr = loadWallets(true)!;
  S = resumeState ?? { v: 1, escrow: dep.escrow, startedAt: new Date().toISOString(), steps: {}, vars: {} };
  if (S.startBlock === undefined) S.startBlock = Number(await pub.getBlockNumber()) - 3;
  S.vars.plan ??= JSON.parse(JSON.stringify(plan, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
  asserts.push(...((S.vars.asserts as typeof asserts) ?? [])); save();
  log(`OPENLY: the deployer ${deployer.address} is the escrow VERIFIER, the BlindBook OWNER and the mUSDG OWNER. Buyer, sellers and bidder are fresh script wallets.`);
  const E = dep.escrow; const bondBook = BigInt(book.bond) * ATTEMPTS;

  // 1. gas and test money
  log('== 1. fund the four wallets: ETH for gas, mUSDG minted by the token owner');
  for (const n of NAMES) {
    await send({ key: `fund:eth:${n}`, label: `send ${formatEther(ETH_EACH)} ETH to ${n}`, role: 'owner', cat: 'setup', to: addr[n], value: ETH_EACH });
    await send({ key: `fund:mint:${n}`, label: `mint ${fmtMusdc(plan.mint[n])} to ${n}`, role: 'owner', cat: 'setup', to: TOKEN, abi: ERC20_ABI, fn: 'mint', args: [addr[n], plan.mint[n]] });
  }
  // 2. operator-issued units, bonds, BlindBook cash
  log('== 2. the BlindBook owner issues units to both sellers; both sellers lock a bond in the escrow and put commit-bond cash into BlindBook');
  for (const n of ['sellerA', 'sellerB'] as Role[]) {
    await send({ key: `issue:${n}`, label: `owner issues ${SELL_UNITS} units to ${n} (operator-issued, not goods)`, role: 'owner', cat: 'setup', to: BOOK, abi: BOOK_ABI, fn: 'issue', args: [MARKET_ID, addr[n], SELL_UNITS] });
    await send({ key: `${n}:approve-escrow`, label: `${n} approves the escrow for the bond`, role: n, cat: 'setup', to: TOKEN, abi: ERC20_ABI, fn: 'approve', args: [E, plan.bond] });
    await send({ key: `${n}:deposit-bond`, label: `${n} deposits a ${fmtMusdc(plan.bond)} bond`, role: n, cat: 'setup', to: E, abi: ORDERS_ABI, fn: 'depositBond', args: [plan.bond] });
  }
  for (const n of ['sellerA', 'sellerB', 'bidder'] as Role[]) {
    const cash = n === 'bidder' ? BigInt(plan.bid) * BID_UNITS * CENT + bondBook : bondBook;
    await send({ key: `${n}:approve-book`, label: `${n} approves BlindBook`, role: n, cat: 'setup', to: TOKEN, abi: ERC20_ABI, fn: 'approve', args: [BOOK, cash] });
    await send({ key: `${n}:deposit-book`, label: `${n} deposits ${fmtMusdc(cash)} into BlindBook`, role: n, cat: 'setup', to: BOOK, abi: BOOK_ABI, fn: 'deposit', args: [cash] });
  }
  // 3. the buyer funds the orders BEFORE the round starts (the escrow only accepts a round that began after funding)
  log(`== 3. the buyer approves and funds ${plan.orders} orders (cap ${fmtPrice(plan.cap)} per unit, 1 unit each); ship-to is an opaque hash`);
  await send({ key: 'buyer:approve-escrow', label: 'buyer approves the escrow', role: 'buyer', cat: 'setup', to: TOKEN, abi: ERC20_ABI, fn: 'approve', args: [E, plan.mint.buyer] });
  S.vars.shipTo ??= {}; const ids: number[] = [];
  for (let k = 1; k <= plan.orders; k++) {
    const salt = (S.vars.shipTo[k] ??= hex32()); save();      // a random salt, kept only in the ignored state file so a resumed run computes the same hash
    const shipToHash = keccak256(encodePacked(['bytes32', 'string'], [salt, 'proof-ship-to']));
    const r = await send({ key: `order${k}:create`, label: `buyer funds order ${k} (ship-to hash ${shipToHash.slice(0, 12)}…, opaque)`, role: 'buyer', cat: 'order', order: k, to: E, abi: ORDERS_ABI, fn: 'createOrder',
      args: [QTY, BigInt(plan.cap), shipToHash, BigInt(Math.floor(now()) + 7200)], parse: (rc) => String(parseEventLogs({ abi: ORDERS_ABI, logs: escrowLogs(rc, E), eventName: 'OrderCreated' })[0].args.id) });
    ids.push(Number(r.extra));
  }
  S.vars.ids = ids; save(); log(`     order ids on chain: ${ids.join(', ')}`);

  // 4. one BlindBook round
  const rnd = await runRound(plan, addr);
  // 5. match
  await matchAndSettle(dep, plan, addr, rnd, ids);
  // 6. write orders.json
  await writeOrdersJson(dep, plan, addr, rnd, ids);
  log('PROOF COMPLETE. Review src/data/orders.json and docs/order-escrow.md; the lead commits.');
}

// the BlindBook round
type Round = { epoch: number; price: number; volume: number; orderCount: number; clearTx: Hex; clearedBy: string; sells: { who: 'sellerA' | 'sellerB'; trader: Hex; index: number; ask: number; units: number; filled: number }[]; bid: { trader: Hex; index: number; price: number; units: number; filled: number }; keeperOrders: number };
const startOf = (ep: number) => book.t0 + ep * book.epochLen;
const epochAt = (t: number) => Math.floor((t - book.t0) / book.epochLen);
const sleepUntil = async (t: number) => { const d = t - now(); if (d > 0) await sleep(d * 1000); };
const commitHash = (ep: number, who: Hex, side: 0 | 1, price: number, units: bigint, salt: Hex) =>
  keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'uint256' }, { type: 'address' }, { type: 'uint8' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'bytes32' }], [MARKET_ID, BigInt(ep), who, side, BigInt(price), units, salt]));

async function runRound(plan: Plan, addr: Record<Role, Hex>): Promise<Round> {
  if (S.vars.round?.done) { log('== 4. BlindBook round already cleared (resuming)'); return S.vars.round.done as Round; }
  for (let attempt = 1; attempt <= 3; attempt++) {
    let r = S.vars.round as { epoch: number; salts: Record<string, Hex>; indexes?: Record<string, number> } | undefined;
    const usable = r && (now() < startOf(r.epoch) + book.revealEnd - 2);   // still inside the round: continue it (salts are kept so reveals work)
    if (!usable) {
      let ep = epochAt(now()) + 1; if (startOf(ep) - now() < 4) ep++;
      r = { epoch: ep, salts: { sellerA: hex32(), sellerB: hex32(), bidder: hex32() } }; S.vars.round = r; save();
    }
    const ep = r!.epoch; const tag = `round${ep}`;
    log(`== 4. BlindBook round: epoch ${ep} starts in ${(startOf(ep) - now()).toFixed(0)}s (attempt ${attempt}). Prices: ask A ${plan.askA}c, ask B ${plan.askB}c, bid ${plan.bid}c (cents), units A ${SELL_UNITS}, B ${SELL_UNITS}, bid ${BID_UNITS}`);
    try {
      const orders: { who: 'sellerA' | 'sellerB' | 'bidder'; side: 0 | 1; price: number; units: bigint }[] = [
        { who: 'sellerA', side: 1, price: plan.askA, units: SELL_UNITS }, { who: 'sellerB', side: 1, price: plan.askB, units: SELL_UNITS }, { who: 'bidder', side: 0, price: plan.bid, units: BID_UNITS }];
      const idx: Record<string, number> = r!.indexes ?? {};
      if (Object.keys(idx).length < 3) {
        await sleepUntil(startOf(ep) + GUARD);
        if (epochAt(now()) !== ep) throw new Error('missed the commit window');
        const have = Number(await rd(BOOK, BOOK_ABI, 'orderCount', [MARKET_ID, BigInt(ep)]));
        if (have > 24 - 6) throw new Error(`the book for this epoch is nearly full (${have} of 24 orders)`);
        await Promise.all(orders.map(async (o) => {
          const res = await send({ key: `${tag}:commit:${o.who}`, label: `${o.who} commits a sealed ${o.side ? 'sell' : 'buy'} (hash only)`, role: o.who, cat: 'round', to: BOOK, abi: BOOK_ABI, fn: 'commit', gas: GAS.commit,
            args: [MARKET_ID, commitHash(ep, addr[o.who], o.side, o.price, o.units, r!.salts[o.who])], parse: (rc) => Number(parseEventLogs({ abi: BOOK_ABI, logs: rc.logs, eventName: 'Committed' })[0].args.index) });
          idx[o.who] = res.extra;
        }));
        r!.indexes = idx; save();
      }
      await sleepUntil(startOf(ep) + book.commitEnd + GUARD);
      if (epochAt(now()) !== ep || now() > startOf(ep) + book.revealEnd - 1) throw new Error('missed the reveal window');
      await Promise.all(orders.map((o) => send({ key: `${tag}:reveal:${o.who}`, label: `${o.who} reveals the ${o.side ? 'sell' : 'buy'}: ${o.price}c x ${o.units}`, role: o.who, cat: 'round', to: BOOK, abi: BOOK_ABI, fn: 'reveal', gas: GAS.reveal,
        args: [MARKET_ID, BigInt(ep), BigInt(idx[o.who]), o.side, BigInt(o.price), o.units, r!.salts[o.who]] })));
      await sleepUntil(startOf(ep) + book.revealEnd + GUARD);
      // someone may have cleared already (the keeper does): then use their transaction as the record
      let clearTx = stepHash(`${tag}:clear`) as Hex | undefined; let clearedBy = 'this script (bidder wallet)';
      const isCleared = () => rd(BOOK, BOOK_ABI, 'cleared', [MARKET_ID, BigInt(ep)]) as Promise<boolean>;
      if (!clearTx) {
        if (!(await isCleared())) {
          // gas is estimated here (not fixed): the call is not phase-sensitive once the reveal window is over, and a fixed 4M limit would need a large ETH balance
          for (let i = 0; i < 6 && !clearTx; i++) {
            try { clearTx = (await send({ key: `${tag}:clear`, label: 'bidder wallet clears the round (anyone may)', role: 'bidder', cat: 'round', to: BOOK, abi: BOOK_ABI, fn: 'clear', args: [MARKET_ID, BigInt(ep)] })).hash; }
            catch (e: any) { if (await isCleared()) break; if (!/TooEarly/.test(String(e?.message))) throw e; log('   chain clock is slightly behind the reveal deadline; retrying in 2s'); await sleep(2000); }
          }
        }
        if (!clearTx) {
          const logs = await pub.getContractEvents({ address: BOOK, abi: BOOK_ABI, eventName: 'EpochCleared', args: { market: MARKET_ID, epoch: BigInt(ep) }, fromBlock: BigInt(S.startBlock!) } as any) as any[];
          if (!logs.length) throw new Error('round is cleared but its EpochCleared log was not found');
          clearTx = logs[0].transactionHash; clearedBy = 'another address (the keeper), which is allowed'; log(`  round already cleared by another address: ${txUrl(clearTx!)}`);
        }
      }
      const [price, volume] = await rd(BOOK, BOOK_ABI, 'results', [MARKET_ID, BigInt(ep)]) as [bigint, bigint];
      const total = Number(await rd(BOOK, BOOK_ABI, 'orderCount', [MARKET_ID, BigInt(ep)]));
      const get = async (who: 'sellerA' | 'sellerB' | 'bidder') => { const o = await rd(BOOK, BOOK_ABI, 'getOrder', [MARKET_ID, BigInt(ep), BigInt(idx[who])]) as any[]; return { trader: getAddress(o[0]), revealed: o[1] as boolean, price: Number(o[3]), units: Number(o[4]), filled: Number(o[5]) }; };
      const [a, b, bd] = await Promise.all([get('sellerA'), get('sellerB'), get('bidder')]);
      if (!a.revealed || !b.revealed || !bd.revealed) throw new Error('an order was not revealed');
      log(`     cleared: ${volume > 0n ? `${fmtPrice(price)} per unit for ${volume} units` : 'no cross'}; filled A ${a.filled}/${a.units}, B ${b.filled}/${b.units}, bid ${bd.filled}/${bd.units}; ${total - 3} other orders in the round`);
      if (volume === 0n || a.filled + b.filled === 0) throw new Error('the round did not fill our sells (another order set the price?)');
      const done: Round = { epoch: ep, price: Number(price), volume: Number(volume), orderCount: total, clearTx: clearTx!, clearedBy, keeperOrders: total - 3,
        sells: [{ who: 'sellerA', trader: a.trader, index: idx.sellerA, ask: a.price, units: a.units, filled: a.filled }, { who: 'sellerB', trader: b.trader, index: idx.sellerB, ask: b.price, units: b.units, filled: b.filled }],
        bid: { trader: bd.trader, index: idx.bidder, price: bd.price, units: bd.units, filled: bd.filled } };
      S.vars.round = { ...r, done }; save();
      return done;
    } catch (e: any) {
      log(`   round attempt ${attempt} failed: ${e?.shortMessage ?? e?.message}`);
      if (attempt === 3) throw new Error('could not complete a BlindBook round in 3 epochs; re-run to resume or retry');
      S.vars.round = undefined; save();   // abandon: unrevealed commits forfeit their bond to BlindBook, which is the protocol
    }
  }
  throw new Error('unreachable');
}
const hex32 = () => ('0x' + randomBytes(32).toString('hex')) as Hex;
const hex = (n: number) => ('0x' + randomBytes(n).toString('hex')) as Hex;

// match, accept, ship, attest, release, refunds
async function matchAndSettle(dep: Dep, plan: Plan, addr: Record<Role, Hex>, rnd: Round, ids: number[]) {
  const E = dep.escrow; const tok = (a: Hex) => rd(TOKEN, ERC20_ABI, 'balanceOf', [a]) as Promise<bigint>;
  const bondFree = (a: Hex) => rd(E, ORDERS_ABI, 'bondFree', [a]) as Promise<bigint>;
  const orderOf = async (id: number) => await rd(E, ORDERS_ABI, 'getOrder', [BigInt(id)]) as any;
  const [id1, id2, id3] = ids;
  const cheap = [...rnd.sells].sort((x, y) => x.ask - y.ask);
  log(`== 5. the buyer matches each order to a cleared sell fill (round price ${fmtPrice(rnd.price)} per unit; cap ${fmtPrice(plan.cap)})`);
  must('setup', 'round price is within the buyer cap', rnd.price <= plan.cap, `${rnd.price}c <= ${plan.cap}c`);
  for (const id of ids) { const o = await orderOf(id); must('setup', `order ${id} was funded before the round began`, BigInt(startOf(rnd.epoch)) >= BigInt(o.createdAt), `epoch start ${startOf(rnd.epoch)} >= createdAt ${o.createdAt}`); }

  // order 1 -> the cheaper ask that is filled; orders 2 and 3 -> the other seller when it has capacity
  const planned = new Map<number, bigint>();   // units this run is about to reserve per fill (the contract's consumed counter only moves at matchOrder)
  async function pick(prefer: 'cheapest' | 'other', id: number) {
    const order = [...cheap]; if (prefer === 'other') order.reverse();
    for (const c of order) {
      const consumed = BigInt(await rd(E, ORDERS_ABI, 'consumedAt', [BigInt(rnd.epoch), BigInt(c.index)])) + (planned.get(c.index) ?? 0n);
      if (BigInt(c.filled) >= consumed + QTY) { planned.set(c.index, (planned.get(c.index) ?? 0n) + QTY); must(id === id1 ? 1 : id === id2 ? 2 : 3, `filled >= consumed + qty for ${c.who} before matchOrder`, true, `filled ${c.filled} >= consumed ${consumed} + qty ${QTY} (ask ${c.ask}c)`); return c; }
    }
    throw new Error(`no seller has fill capacity left for order ${id}`);
  }
  // the picks are saved before the first matchOrder, so a resumed run keeps the same seller for each order
  type Pick = (typeof rnd.sells)[number];
  const saved = S.vars.picks as Record<string, number> | undefined; const byIndex = (i: number) => rnd.sells.find((x) => x.index === i)!;
  let s1: Pick; let s2: Pick | undefined; let s3: Pick | undefined;
  if (saved) { s1 = byIndex(saved['1']); s2 = id2 ? byIndex(saved['2']) : undefined; s3 = id3 ? byIndex(saved['3']) : undefined; log('     (resuming: sellers already chosen for each order)'); }
  else {
    s1 = await pick('cheapest', id1); s2 = id2 ? await pick('other', id2) : undefined; s3 = id3 ? await pick('other', id3) : undefined;
    S.vars.picks = { 1: s1.index, ...(s2 ? { 2: s2.index } : {}), ...(s3 ? { 3: s3.index } : {}) }; save();
  }
  log(`     order 1 goes to ${s1.who}: the cheapest ask (${s1.ask}c) that the round filled`);
  const role = (s: { who: string }) => s.who as Role;
  const match = async (k: number, id: number, s: { who: string; index: number }) => (await send({ key: `order${k}:match`, label: `buyer matches order ${k} to ${s.who}'s fill (round ${rnd.epoch}, order #${s.index})`, role: 'buyer', cat: 'order', order: k, to: E, abi: ORDERS_ABI, fn: 'matchOrder', args: [BigInt(id), BigInt(rnd.epoch), BigInt(s.index)] }));
  await match(1, id1, s1); if (s2) await match(2, id2, s2); if (s3) await match(3, id3, s3);
  const o1 = await orderOf(id1); must(1, 'the price is the BlindBook round price', Number(o1.priceCents) === rnd.price && o1.seller === addr[role(s1)], `price ${o1.priceCents}c, seller ${o1.seller}`);

  // order 3: the seller accepts now so the ship clock starts early, then never ships
  if (s3) { await send({ key: 'order3:accept', label: `${s3.who} accepts order 3 (locks the bond) and will not ship`, role: role(s3), cat: 'order', order: 3, to: E, abi: ORDERS_ABI, fn: 'accept', args: [BigInt(id3)] }); }
  // order 2: the buyer withdraws the offer before acceptance
  if (s2) {
    const before = await tok(addr.buyer); const consBefore = BigInt(await rd(E, ORDERS_ABI, 'consumedAt', [BigInt(rnd.epoch), BigInt(s2.index)])); const fundedBase = BigInt(plan.cap) * QTY * CENT;
    const alreadyDone = S.steps['order2:refund-unaccepted']?.status === 'ok';
    await send({ key: 'order2:refund-unaccepted', label: 'buyer withdraws offer 2 before the seller accepts (refundUnaccepted)', role: 'buyer', cat: 'order', order: 2, to: E, abi: ORDERS_ABI, fn: 'refundUnaccepted', args: [BigInt(id2)] });
    const o2 = await orderOf(id2); must(2, 'order 2 is REFUNDED', statusName(o2.status) === 'REFUNDED', statusName(o2.status));
    if (!alreadyDone) {
      must(2, 'buyer got the full funded amount back', (await tok(addr.buyer)) - before === fundedBase, `+${fmtMusdc(fundedBase)}`);
      const consAfter = BigInt(await rd(E, ORDERS_ABI, 'consumedAt', [BigInt(rnd.epoch), BigInt(s2.index)])); must(2, 'the fill reservation was released', consBefore - consAfter === QTY, `consumed ${consBefore} -> ${consAfter}`);
    }
  }

  // order 1: accept, ship (agent attested), attest (verifier), release
  log('== 6. order 1: accept, ship, attest, release');
  const seller1 = role(s1); const sa = addr[seller1];
  const bondBefore = S.vars.bondBefore1 ??= String(await bondFree(sa)); save();
  // bondNeeded is only defined while the order is OFFERED, so it is read (and remembered) before the seller accepts
  const need1 = BigInt(S.vars.need1 ??= String(await rd(E, ORDERS_ABI, 'bondNeeded', [BigInt(id1)]))); save();
  await send({ key: 'order1:accept', label: `${seller1} accepts order 1 and locks its bond`, role: seller1, cat: 'order', order: 1, to: E, abi: ORDERS_ABI, fn: 'accept', args: [BigInt(id1)] });
  must(1, 'bond locked equals bondNeeded', BigInt((await orderOf(id1)).bondLocked) === need1, fmtMusdc(need1));
  const tracking = (S.vars.tracking ??= 'tracking:' + randomBytes(8).toString('hex')); save();
  await send({ key: 'order1:ship', label: `${seller1} reports shipment ${tracking} (AGENT ATTESTED: only a hash on chain)`, role: seller1, cat: 'order', order: 1, to: E, abi: ORDERS_ABI, fn: 'ship', args: [BigInt(id1), keccak256(toHex(tracking))] });
  const receipt = keccak256(toHex((S.vars.receipt1 ??= 'receipt:order1:' + randomBytes(8).toString('hex')))); save();
  await send({ key: 'order1:attest', label: 'verifier (deployer) attests delivery with the expected SKU. No goods moved; this is the named verifier\'s statement', role: 'owner', cat: 'order', order: 1, to: E, abi: ORDERS_ABI, fn: 'attest', args: [BigInt(id1), dep.sku, true, receipt] });
  const pre = S.vars.pre1 ??= { seller: String(await tok(sa)), buyer: String(await tok(addr.buyer)) }; save();
  const rel = await send({ key: 'order1:release', label: 'buyer releases the payment', role: 'buyer', cat: 'order', order: 1, to: E, abi: ORDERS_ABI, fn: 'release', args: [BigInt(id1)],
    parse: (rc) => { const a = parseEventLogs({ abi: ORDERS_ABI, logs: escrowLogs(rc, E), eventName: 'Released' })[0].args; return { payment: String(a.paid), buyerRefund: String(a.refundedToBuyer), bondReturned: String(a.bondReturned), why: Number(a.why) }; } });
  const price = BigInt(rnd.price); const pay = price * QTY * CENT; const funded = BigInt(plan.cap) * QTY * CENT; const back = funded - pay;
  must(1, 'Released event: payment = price x qty x CENT', BigInt(rel.extra!.payment) === pay, fmtMusdc(pay));
  must(1, 'Released event: buyer refund = cap payment minus payment', BigInt(rel.extra!.buyerRefund) === back, fmtMusdc(back));
  must(1, 'bond is back in bondFree', (await bondFree(sa)) === BigInt(bondBefore) && BigInt(rel.extra!.bondReturned) === need1, `${fmtMusdc(BigInt(bondBefore))} (bond ${fmtMusdc(need1)} returned)`);
  if (!S.vars.post1 && S.steps['order3:refund-unshipped']?.status !== 'ok') {
    // balances are only comparable when nothing else touched these two wallets between the two reads (true unless the run was resumed late)
    const post = { seller: await tok(sa), buyer: await tok(addr.buyer) };
    const ds = post.seller - BigInt(pre.seller); const db = post.buyer - BigInt(pre.buyer); S.vars.post1 = { ds: String(ds), db: String(db) }; save();
    must(1, 'seller token balance rose by payment', ds === pay, `+${fmtMusdc(ds)}`); must(1, 'buyer token balance rose by the refund of the difference', db === back, `+${fmtMusdc(db)}`);
  }
  const f1 = await orderOf(id1); must(1, 'order 1 is RELEASED', statusName(f1.status) === 'RELEASED', statusName(f1.status));

  // order 3: wait for the ship window, then ANYONE calls refundUnshipped
  if (s3) {
    log('== 7. order 3: the seller accepted and does not ship; wait for the ship window, then an unrelated wallet calls refundUnshipped');
    const o3 = await orderOf(id3); const shipBy = Number(o3.shipBy); const bond3 = BigInt(o3.bondLocked);
    if (statusName(o3.status) === 'MATCHED') {
      const beforeBuyer = await tok(addr.buyer);
      for (let waited = 0; ; waited++) {
        const left = shipBy + 3 - now();
        if (left <= 0) {
          try { await send({ key: 'order3:refund-unshipped', label: 'an unrelated wallet (the bidder) calls refundUnshipped: buyer refunded, seller bond slashed to the buyer', role: 'bidder', cat: 'order', order: 3, to: E, abi: ORDERS_ABI, fn: 'refundUnshipped', args: [BigInt(id3)] }); break; }
          catch (e: any) { if (/TooEarly|too early/i.test(String(e?.message))) { log('   chain clock is slightly behind; trying again in 5s'); await sleep(5000); continue; } throw e; }
        }
        if (waited % 6 === 0) log(`   waiting ${Math.ceil(left)}s for the ship window of order 3 to pass (about ${Math.ceil(left / 60)} min)`);
        await sleep(Math.min(10_000, left * 1000));
      }
      const afterBuyer = await tok(addr.buyer); const expect = funded + bond3;
      if (!S.vars.post3) { S.vars.post3 = String(afterBuyer - beforeBuyer); save(); must(3, 'buyer received the funded amount plus the slashed bond', afterBuyer - beforeBuyer === expect, `+${fmtMusdc(afterBuyer - beforeBuyer)} (funded ${fmtMusdc(funded)} + bond ${fmtMusdc(bond3)})`); }
    }
    const f3 = await orderOf(id3); must(3, 'order 3 is REFUNDED', statusName(f3.status) === 'REFUNDED', statusName(f3.status));
  }
  const lastId = Number(await rd(E, ORDERS_ABI, 'nextId')); const held = await tok(E); const free = (await bondFree(addr.sellerA)) + (await bondFree(addr.sellerB));
  if (lastId === ids.length) must('setup', 'the escrow holds exactly the sellers’ free bonds (nothing stranded)', held === free, `escrow ${fmtMusdc(held)}, bondFree A+B ${fmtMusdc(free)}`);
}

// orders.json
async function writeOrdersJson(dep: Dep, plan: Plan, addr: Record<Role, Hex>, rnd: Round, ids: number[]) {
  const head = await pub.getBlockNumber();
  const all = await fetchEscrowEvents(pub as any, { address: dep.escrow, abi: ORDERS_ABI, from: BigInt(S.startBlock!), to: head });
  const mine = all.filter((e: EscrowEvent) => ids.includes(Number(e.args.id)) || ([addr.sellerA, addr.sellerB].map((a) => a.toLowerCase()).includes(String(e.args.seller).toLowerCase()) && /^Bond/.test(e.name)));
  const events = await attachTimes(pub as any, mine);
  const stepList = (cat: StepRec['cat'], order?: number) => Object.entries(S.steps).filter(([, s]) => s.cat === cat && s.order === order && s.status === 'ok').sort((a, b) => a[1].block! - b[1].block!).map(([, s]) => ({ label: s.label, caller: s.role === 'owner' ? 'verifier / operator (deployer)' : s.role, tx: s.hash, block: s.block }));
  const scenario: Record<number, string> = { 1: 'delivered and released', 2: 'refunded by the buyer before acceptance', 3: 'seller accepted and never shipped: refunded, bond slashed' };
  const out = {
    deployed: true, chainId: 46630, escrow: dep.escrow, verifier: dep.verifier, token: dep.token, book: dep.book, market: HERO, marketId: MARKET_ID, sku: dep.sku, symbol: 'mUSDG', bondBps: dep.bondBps,
    windows: { accept: dep.acceptWindow, ship: dep.shipWindow, verify: dep.verifyWindow, dispute: dep.disputeWindow, resolve: dep.resolveWindow },
    logsFromBlock: S.startBlock, head: Number(head),
    proof: {
      ranAt: new Date().toISOString(), script: 'apps/web/tools/order-proof.ts',
      statement: 'Script-controlled wallets and operator-issued test units. The deployer key is the verifier, the BlindBook owner and the mUSDG owner. No physical goods moved: delivery was attested by the verifier.',
      operator: deployer.address, wallets: { buyer: addr.buyer, sellerA: addr.sellerA, sellerB: addr.sellerB, bidder: addr.bidder },
      shipTo: 'Opaque: keccak256(random salt, "proof-ship-to"). The salt is not published.',
      prices: { referenceCents: plan.ref, askACents: plan.askA, askBCents: plan.askB, bidCents: plan.bid, capCents: plan.cap },
      round: rnd, setup: stepList('setup'), roundSteps: stepList('round'),
      orders: ids.map((id, i) => ({ id, scenario: scenario[i + 1], steps: stepList('order', i + 1), assertions: asserts.filter((a) => a.order === i + 1) })),
      assertions: asserts.filter((a) => a.order === 'setup'),
      skipped: plan.timeoutPath ? [] : ['unshipped timeout (the ship window is longer than 20 minutes; run with --wait-timeout to wait for it)'],
    },
    events,
  };
  fs.writeFileSync(OUT_FILE, JSON.stringify(out, null, 1) + '\n'); log(`wrote ${path.relative(process.cwd(), OUT_FILE)} (${events.length} events, head ${head})`);
}

// plan printout
function printPlan(dep: Dep | undefined, p: Plan, addr: Record<Role, Hex> | null, st: State | null) {
  const who = (n: Role) => (addr ? addr[n] : '(generated on the first real run)');
  console.log('\nPLAN' + (DRY ? ' (dry run: nothing is sent)' : ''));
  console.log(` escrow     ${dep?.escrow ?? '(not deployed yet: deployments/orders-46630.json is missing)'}`);
  console.log(` verifier   ${deployer.address}  = the deployer. It is ALSO the BlindBook owner and the mUSDG owner (stated openly).`);
  console.log(` wallets    buyer ${who('buyer')}\n            sellerA ${who('sellerA')}\n            sellerB ${who('sellerB')}\n            bidder ${who('bidder')}`);
  console.log(` prices     reference ${p.ref}c; ask A ${p.askA}c, ask B ${p.askB}c, bid ${p.bid}c, buyer cap ${p.cap}c per unit (the round price is ONE uniform price for every fill)`);
  console.log(` bond       ${fmtMusdc(p.bond)} per seller (bondBps ${dep?.bondBps ?? '2000 assumed'}), BlindBook commit bond ${fmtMusdc(BigInt(book.bond))} per order, cash for ${ATTEMPTS} tries each`);
  console.log(` fund       ${formatEther(ETH_EACH)} ETH to each wallet; mUSDG minted: buyer ${fmtMusdc(p.mint.buyer)}, sellers ${fmtMusdc(p.mint.sellerA)} each, bidder ${fmtMusdc(p.mint.bidder)} (total ${fmtMusdc(p.totalMint)})`);
  console.log(` steps      1 fund wallets   2 issue ${SELL_UNITS} units to A and B, both deposit bond and BlindBook cash   3 buyer funds ${p.orders} orders (before the round starts)`);
  console.log(`            4 one BlindBook epoch: A and B commit+reveal sells, the bidder commits+reveals a buy of ${BID_UNITS} units, clear; assert filled >= qty`);
  console.log(`            5 order 1 -> cheaper ask (A): accept, ship (agent attested), verifier attests, buyer releases; assert payout, refund and bond`);
  console.log(`            6 order 2 -> buyer calls refundUnaccepted`);
  console.log(`            7 ${p.timeoutPath ? `order 3 -> seller accepts, never ships; after the ${dep?.shipWindow ?? 1800}s ship window an unrelated wallet calls refundUnshipped (about ${Math.round((dep?.shipWindow ?? 1800) / 60)} min wait)` : 'order 3 (unshipped timeout) SKIPPED: the ship window is longer than 20 minutes (add --wait-timeout to wait for it)'}`);
  console.log(`            8 write src/data/orders.json with every tx hash (${EXPLORER}/tx/<hash>)`);
  console.log(` state      ${st ? `${Object.keys(st.steps).length} step(s) recorded in ${path.basename(STATE_FILE)}: a real run resumes` : 'none: a real run starts fresh'}\n`);
}

main().catch((e) => { console.error('ORDER PROOF FAILED:', e instanceof Error ? e.message : e, '\nRe-run the same command to resume; finished steps are skipped.'); process.exit(1); });
process.on('SIGINT', () => { console.log('\nstopped; re-run to resume'); process.exit(0); });
