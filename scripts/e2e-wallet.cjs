// Wallet + Owner console end-to-end test against the REAL deployed contracts on Robinhood Chain Testnet.
//   node --env-file=.env scripts/e2e-wallet.cjs http://127.0.0.1:4394
// A mock browser wallet (EIP-6963 + EIP-1193) lives in the page; every request is answered by this Node process, which
// signs with the real DEPLOYER (owner) or AGENT key from .env and broadcasts real transactions. All on-chain assertions use
// `cast` (independent of the app's own code). Every state change is reversible and reverted inside this script (pause <-> resume,
// deposit <-> withdraw 1 token, allowlist add <-> remove, policy set to its current values); a `finally` unpauses no matter what.
const { chromium } = require('playwright');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
// viem lives in apps/web/node_modules (not hoisted), so resolve it from there
const webRequire = require('node:module').createRequire(path.join(__dirname, '../apps/web/package.json'));
const { createWalletClient, http, defineChain } = webRequire('viem');
const { privateKeyToAccount } = webRequire('viem/accounts');

const BASE = process.argv[2] || 'http://127.0.0.1:4394';
const RPC = process.env.ROBINHOOD_RPC || 'https://rpc.testnet.chain.robinhood.com';
const dep = JSON.parse(fs.readFileSync(path.join(__dirname, '../apps/web/src/data/deployment.json'), 'utf8'));
const CHAIN_ID = dep.chainId; const CHAIN_HEX = '0x' + CHAIN_ID.toString(16);
const chain = defineChain({ id: CHAIN_ID, name: 'robinhood-testnet', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const KEYS = { owner: process.env.DEPLOYER_PRIVATE_KEY, agent: process.env.AGENT_PRIVATE_KEY };
if (!KEYS.owner || !KEYS.agent) { console.error('DEPLOYER_PRIVATE_KEY and AGENT_PRIVATE_KEY must be set (use --env-file=.env)'); process.exit(2); }

const cast = (...a) => execFileSync('cast', [...a, '--rpc-url', RPC], { encoding: 'utf8' }).trim().split(' ')[0];
const callU = (to, sig, ...args) => BigInt(cast('call', to, sig, ...args));
const callB = (to, sig, ...args) => cast('call', to, sig, ...args) === 'true';
const core = dep.core; const token = dep.token;
let failures = 0; const ok = (m) => console.log('  ok  ', m); const fail = (m) => { failures++; console.log('  FAIL', m); };
const expect = (cond, m) => (cond ? ok(m) : fail(m));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Opens a page with a mock wallet. opts: { who: 'owner'|'agent', startChain: hex, unknownChain: bool, reject: bool } */
async function openWithWallet(browser, opts) {
  const account = privateKeyToAccount(KEYS[opts.who]);
  const wc = createWalletClient({ account, chain, transport: http(RPC) });
  const st = { chainHex: opts.startChain || CHAIN_HEX, sent: 0, added: null, known: !opts.unknownChain, reject: !!opts.reject };
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await ctx.newPage(); const errs = [];
  page.on('pageerror', (e) => errs.push(String(e).slice(0, 120)));
  page.on('console', (m) => m.type() === 'error' && !/Failed to load resource|net::ERR/.test(m.text()) && errs.push(m.text().slice(0, 120)));
  await page.exposeFunction('__walletRequest', async (raw) => {
    const { method, params } = JSON.parse(raw);
    try {
      switch (method) {
        case 'eth_requestAccounts': case 'eth_accounts': return JSON.stringify({ result: [account.address] });
        case 'eth_chainId': return JSON.stringify({ result: st.chainHex });
        case 'wallet_switchEthereumChain': if (!st.known) return JSON.stringify({ error: { code: 4902, message: 'Unrecognized chain ID' } }); st.chainHex = params[0].chainId; return JSON.stringify({ result: null });
        case 'wallet_addEthereumChain': st.added = params[0]; st.known = true; st.chainHex = params[0].chainId; return JSON.stringify({ result: null });
        case 'eth_sendTransaction': {
          st.sent++; if (st.reject) return JSON.stringify({ error: { code: 4001, message: 'User rejected the request.' } });
          const t = params[0]; const hash = await wc.sendTransaction({ to: t.to, data: t.data, value: t.value ? BigInt(t.value) : undefined, gas: t.gas ? BigInt(t.gas) : undefined });
          return JSON.stringify({ result: hash });
        }
        default: return JSON.stringify({ error: { code: -32601, message: 'mock wallet: unsupported ' + method } });
      }
    } catch (e) { return JSON.stringify({ error: { code: -32000, message: String(e.shortMessage || e.message).slice(0, 200) } }); }
  });
  await page.addInitScript(() => {
    const info = { uuid: 'mock-wallet-1', name: 'Mock Wallet', icon: 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"/>', rdns: 'io.mock.wallet' };
    const listeners = {};
    const provider = {
      request: async ({ method, params }) => { const o = JSON.parse(await window.__walletRequest(JSON.stringify({ method, params }))); if (o.error) { const e = new Error(o.error.message); e.code = o.error.code; throw e; } return o.result; },
      on: (e, f) => { (listeners[e] ||= []).push(f); }, removeListener: (e, f) => { listeners[e] = (listeners[e] || []).filter((x) => x !== f); },
    };
    const announce = () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: Object.freeze({ info, provider }) }));
    window.addEventListener('eip6963:requestProvider', announce); announce();
  });
  await page.goto(`${BASE}/app/owner/`, { waitUntil: 'networkidle' });
  return { page, st, errs, account, ctx };
}
const T = (page, id) => page.getByTestId(id);
async function connect(page) {
  await T(page, 'wallet-connect-btn').first().click();
  await sleep(400);
  if (await T(page, 'wallet-chooser-item').count()) await T(page, 'wallet-chooser-item').first().click();
  await T(page, 'wallet-address').first().waitFor({ timeout: 15000 });
}
const state = (page, action) => T(page, `tx-status-${action}`).getAttribute('data-state');
async function waitState(page, action, want, ms = 90000) {
  const t0 = Date.now(); let s = '';
  while (Date.now() - t0 < ms) { s = (await state(page, action)) || ''; if (want.includes(s)) return s; await sleep(500); }
  return 'timeout:' + s;
}

(async () => {
  const browser = await chromium.launch();
  const ownerAddr = privateKeyToAccount(KEYS.owner).address; const agentAddr = privateKeyToAccount(KEYS.agent).address;
  const polStart = { d: callU(core, 'dailySpendCap()(uint256)'), m: callU(core, 'maxExec()(uint256)'), b: callU(core, 'minMarginBps()(uint256)'), t: callU(core, 'quoteTTL()(uint256)') };
  const restorePolicy = () => { try { if (callU(core, 'minMarginBps()(uint256)') !== polStart.b || callU(core, 'maxExec()(uint256)') !== polStart.m || callU(core, 'dailySpendCap()(uint256)') !== polStart.d || callU(core, 'quoteTTL()(uint256)') !== polStart.t) execFileSync('cast', ['send', core, 'setPolicy(uint256,uint256,uint256,uint256)', String(polStart.d), String(polStart.m), String(polStart.b), String(polStart.t), '--private-key', KEYS.owner, '--rpc-url', RPC], { stdio: 'ignore' }); } catch { /* best effort */ } };
  const unpauseNow = () => { try { if (callB(core, 'paused()(bool)')) execFileSync('cast', ['send', core, 'pause(bool)', 'false', '--private-key', KEYS.owner, '--rpc-url', RPC], { stdio: 'ignore' }); } catch { /* best effort */ } };
  try {
    console.log('precondition: vault running, owner =', ownerAddr);
    if (callB(core, 'paused()(bool)')) { console.log('  (vault was paused: resuming first)'); unpauseNow(); }
    expect(!callB(core, 'paused()(bool)'), 'vault is running');
    const snap0 = { free: callU(core, 'free()(uint256)'), dep: callU(core, 'totalDeposited()(uint256)'), wd: callU(core, 'totalWithdrawn()(uint256)') };

    console.log('\n[1] owner connects on the WRONG network with an unknown chain: switch -> add chain -> ready');
    let { page, st, errs, ctx } = await openWithWallet(browser, { who: 'owner', startChain: '0x1', unknownChain: true });
    await connect(page);
    expect((await T(page, 'wallet-role').first().innerText()).trim().toLowerCase() === 'owner', 'role is owner (read from the contract)');
    expect(await T(page, 'wallet-network-warning').first().isVisible(), 'wrong-network warning shown');
    await T(page, 'wallet-switch-btn').first().click(); await sleep(1500);
    expect(st.added && st.added.chainId === CHAIN_HEX && st.added.rpcUrls[0] === RPC && /explorer/.test(st.added.blockExplorerUrls[0]), 'chain added to the wallet with the right parameters');
    expect(!(await T(page, 'wallet-network-warning').count()) || !(await T(page, 'wallet-network-warning').first().isVisible()), 'warning cleared after switching');

    console.log('\n[2] kill switch: pause -> contract refuses agent -> resume');
    await T(page, 'owner-pause-btn').click();
    expect((await waitState(page, 'pause', ['confirmed'])) === 'confirmed', 'pause tx confirmed');
    expect(callB(core, 'paused()(bool)'), 'on-chain paused() == true');
    await page.waitForFunction(() => /PAUSED/.test(document.querySelector('[data-testid="owner-paused-state"]')?.textContent || ''), null, { timeout: 20000 });
    ok('UI shows PAUSED');
    await page.waitForFunction(() => /paused/i.test(document.querySelector('[data-testid="owner-agent-sim"]')?.textContent || ''), null, { timeout: 30000 });
    ok('agent simulation now shows the Paused refusal');
    await T(page, 'owner-pause-btn').click();
    expect((await waitState(page, 'pause', ['confirmed'])) === 'confirmed', 'resume tx confirmed');
    expect(!callB(core, 'paused()(bool)'), 'on-chain paused() == false');

    console.log('\n[3] deposit 1 token (approve + deposit) then withdraw it');
    await T(page, 'owner-deposit-input').fill('1'); await T(page, 'owner-deposit-btn').click();
    expect((await waitState(page, 'deposit', ['confirmed'])) === 'confirmed', 'deposit confirmed');
    expect(callU(core, 'totalDeposited()(uint256)') === snap0.dep + 1_000_000n, 'on-chain totalDeposited +1.000000');
    await T(page, 'owner-withdraw-input').fill('1'); await T(page, 'owner-withdraw-btn').click();
    expect((await waitState(page, 'withdraw', ['confirmed'])) === 'confirmed', 'withdraw confirmed');
    expect(callU(core, 'free()(uint256)') === snap0.free, 'vault free balance back to where it started');
    await T(page, 'owner-withdraw-input').fill('999999'); await T(page, 'owner-withdraw-btn').click();
    const wd = await waitState(page, 'withdraw', ['error']);
    expect(wd === 'error' && /free|escrow/i.test((await T(page, 'tx-status-withdraw').innerText())), 'over-withdrawal is refused with the contract\'s sentence (no tx sent)');

    console.log('\n[4] mandate: invalid input blocked, current values re-saved unchanged');
    const pol = { d: callU(core, 'dailySpendCap()(uint256)'), m: callU(core, 'maxExec()(uint256)'), b: callU(core, 'minMarginBps()(uint256)'), t: callU(core, 'quoteTTL()(uint256)') };
    const sentBefore = st.sent;
    await T(page, 'owner-policy-margin').fill('0.5'); await sleep(500);
    expect(await T(page, 'owner-policy-save').isDisabled(), 'margin 0.5% (below the 1% minimum) disables Save');
    await T(page, 'owner-policy-margin').fill('95'); await sleep(500);
    expect(await T(page, 'owner-policy-save').isDisabled(), 'margin 95% (above the 90% maximum) disables Save');
    expect(st.sent === sentBefore, 'invalid input never reaches the wallet');
    const bumped = Number(pol.b) / 100 + 1;
    await T(page, 'owner-policy-margin').fill(String(bumped)); await sleep(400);
    expect(!(await T(page, 'owner-policy-save').isDisabled()), 'a real change enables Save');
    await T(page, 'owner-policy-save').click();
    expect((await waitState(page, 'policy', ['confirmed'])) === 'confirmed', 'setPolicy confirmed');
    expect(callU(core, 'minMarginBps()(uint256)') === pol.b + 100n && callU(core, 'maxExec()(uint256)') === pol.m && callU(core, 'dailySpendCap()(uint256)') === pol.d && callU(core, 'quoteTTL()(uint256)') === pol.t, 'on-chain margin floor +1%, every other field untouched');
    await T(page, 'owner-policy-margin').fill(String(Number(pol.b) / 100)); await sleep(400);
    await T(page, 'owner-policy-save').click();
    expect((await waitState(page, 'policy', ['confirmed'])) === 'confirmed', 'setPolicy back confirmed');
    expect(callU(core, 'minMarginBps()(uint256)') === pol.b, 'on-chain policy restored exactly');

    console.log('\n[5] allowlist: add then remove a throwaway payee');
    const rand = '0x' + [...Array(40)].map(() => '0123456789abcdef'[Math.floor(Math.random() * 16)]).join('');
    await T(page, 'owner-payee-input').fill(rand); await T(page, 'owner-payee-add').click();
    expect((await waitState(page, 'payee-add', ['confirmed'])) === 'confirmed', 'add payee confirmed');
    expect(callB(core, 'payee(address)(bool)', rand), 'on-chain payee(addr) == true');
    await T(page, 'owner-payee-remove').click();
    expect((await waitState(page, 'payee-remove', ['confirmed'])) === 'confirmed', 'remove payee confirmed');
    expect(!callB(core, 'payee(address)(bool)', rand), 'on-chain payee(addr) == false');
    expect(errs.length === 0, 'no page or console errors in the owner session' + (errs.length ? ': ' + errs.join(' | ') : ''));
    await ctx.close();

    console.log('\n[6] the AGENT wallet is refused by the contract before anything is signed');
    ({ page, st, errs, ctx } = await openWithWallet(browser, { who: 'agent' }));
    await connect(page);
    expect((await T(page, 'wallet-role').first().innerText()).trim().toLowerCase() === 'agent', 'role is agent');
    await T(page, 'owner-pause-btn').click();
    const ag = await waitState(page, 'pause', ['error']);
    expect(ag === 'error' && /owner wallet/i.test(await T(page, 'tx-status-pause').innerText()), 'UI shows "Only the owner wallet..." (the contract\'s own refusal)');
    expect(st.sent === 0, 'the wallet was never asked to sign a doomed transaction');
    expect(!callB(core, 'paused()(bool)'), 'on-chain paused() unchanged');
    await T(page, 'owner-mint-btn').click();
    expect((await waitState(page, 'mint', ['error'])) === 'error' && st.sent === 0, 'non-token-owner mint refused before signing');
    await ctx.close();

    console.log('\n[7] the owner declines in their wallet: neutral message, nothing changes');
    ({ page, st, errs, ctx } = await openWithWallet(browser, { who: 'owner', reject: true }));
    await connect(page); await T(page, 'owner-pause-btn').click();
    const rj = await waitState(page, 'pause', ['rejected', 'error']);
    expect(rj === 'rejected' && /declined/i.test(await T(page, 'tx-status-pause').innerText()), 'UI says the request was declined (not an error)');
    expect(!callB(core, 'paused()(bool)'), 'on-chain paused() unchanged');
    await ctx.close();

    console.log('\n[8] session survives a page reload (silent restore, no prompt)');
    ({ page, st, errs, ctx } = await openWithWallet(browser, { who: 'owner' }));
    await connect(page); await page.reload({ waitUntil: 'networkidle' });
    await T(page, 'wallet-address').first().waitFor({ timeout: 15000 }); ok('wallet reconnected silently after reload');
    await ctx.close();
  } catch (e) { fail('crashed: ' + (e && e.message)); } finally {
    unpauseNow(); restorePolicy(); await browser.close();
    expect(!callB(core, 'paused()(bool)'), 'cleanup: vault left running');
    expect(callU(core, 'minMarginBps()(uint256)') === polStart.b && callU(core, 'maxExec()(uint256)') === polStart.m, 'cleanup: mandate left exactly as found');
  }
  console.log(failures ? `\n${failures} FAILURE(S)` : '\nwallet e2e: all checks passed');
  process.exit(failures ? 1 : 0);
})();
