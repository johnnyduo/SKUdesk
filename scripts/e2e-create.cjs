// "Deploy your agent" end-to-end test against the REAL contracts on Robinhood Chain Testnet.
//   node --env-file=.env scripts/e2e-create.cjs http://127.0.0.1:4394
// A fresh throwaway wallet (funded with a little ETH by the deployer, swept back at the end) drives the page through a mock EIP-6963 wallet:
// faucet -> invalid form never reaches the wallet -> generate key -> create agent -> read everything back with `cast` -> fund vault -> add gas -> pause/resume.
// Finally the agent key generated IN THE PAGE signs a real ERC-4337 UserOperation that commits an opportunity through the account the page created,
// and a forbidden UserOperation (token transfer) is refused. All on-chain assertions use cast / viem, independent of the page's own code.
const { chromium } = require('playwright');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const webRequire = require('node:module').createRequire(path.join(__dirname, '../apps/web/package.json'));
const { createWalletClient, createPublicClient, http, defineChain, parseEther, keccak256, encodeAbiParameters, parseAbiParameters, encodeFunctionData, toHex, getAddress } = webRequire('viem');
const { privateKeyToAccount, generatePrivateKey } = webRequire('viem/accounts');

const BASE = process.argv[2] || 'http://127.0.0.1:4394';
const RPC = process.env.ROBINHOOD_RPC || 'https://rpc.testnet.chain.robinhood.com';
const AG = JSON.parse(fs.readFileSync(path.join(__dirname, '../apps/web/src/data/agents.json'), 'utf8'));
const CHAIN_ID = AG.chainId; const CHAIN_HEX = '0x' + CHAIN_ID.toString(16);
const chain = defineChain({ id: CHAIN_ID, name: 'robinhood-testnet', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const DEPLOYER = process.env.DEPLOYER_PRIVATE_KEY;
if (!DEPLOYER) { console.error('DEPLOYER_PRIVATE_KEY must be set (use --env-file=.env)'); process.exit(2); }

const cast = (...a) => execFileSync('cast', [...a, '--rpc-url', RPC], { encoding: 'utf8' }).trim().split(' ')[0];
const castFull = (...a) => execFileSync('cast', [...a, '--rpc-url', RPC], { encoding: 'utf8' }).trim();
const callU = (to, sig, ...args) => BigInt(cast('call', to, sig, ...args));
const callA = (to, sig, ...args) => getAddress(cast('call', to, sig, ...args));
let failures = 0; const ok = (m) => console.log('  ok  ', m); const fail = (m) => { failures++; console.log('  FAIL', m); };
const expect = (cond, m) => (cond ? ok(m) : fail(m));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const T = (page, id) => page.getByTestId(id);
const state = (page, action) => T(page, `tx-status-${action}`).getAttribute('data-state');
async function waitState(page, action, want, ms = 120000) {
  const t0 = Date.now(); let s = '';
  while (Date.now() - t0 < ms) { s = (await state(page, action)) || ''; if (want.includes(s)) return s; await sleep(500); }
  return 'timeout:' + s;
}

(async () => {
  const pub = createPublicClient({ chain, transport: http(RPC) });
  const funder = privateKeyToAccount(DEPLOYER); const fw = createWalletClient({ account: funder, chain, transport: http(RPC) });
  const userKey = generatePrivateKey(); const user = privateKeyToAccount(userKey);
  const uw = createWalletClient({ account: user, chain, transport: http(RPC) });
  console.log('throwaway wallet', user.address);
  const fundTx = await fw.sendTransaction({ to: user.address, value: parseEther(process.env.E2E_FUND || '0.0008') }); await pub.waitForTransactionReceipt({ hash: fundTx });

  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1200 } });
  const page = await ctx.newPage(); const errs = []; let sent = 0;
  page.on('pageerror', (e) => errs.push(String(e).slice(0, 160)));
  page.on('console', (m) => m.type() === 'error' && !/Failed to load resource|net::ERR/.test(m.text()) && errs.push(m.text().slice(0, 160)));
  await page.exposeFunction('__walletRequest', async (raw) => {
    const { method, params } = JSON.parse(raw);
    try {
      switch (method) {
        case 'eth_requestAccounts': case 'eth_accounts': return JSON.stringify({ result: [user.address] });
        case 'eth_chainId': return JSON.stringify({ result: CHAIN_HEX });
        case 'wallet_switchEthereumChain': return JSON.stringify({ result: null });
        case 'eth_sendTransaction': {
          sent++; const t = params[0];
          const hash = await uw.sendTransaction({ to: t.to, data: t.data, value: t.value ? BigInt(t.value) : undefined, gas: t.gas ? BigInt(t.gas) : undefined });
          return JSON.stringify({ result: hash });
        }
        default: return JSON.stringify({ error: { code: -32601, message: 'mock wallet: unsupported ' + method } });
      }
    } catch (e) { return JSON.stringify({ error: { code: -32000, message: String(e.shortMessage || e.message).slice(0, 200) } }); }
  });
  await page.addInitScript(() => {
    const info = { uuid: 'mock-wallet-1', name: 'Mock Wallet', icon: 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"/>', rdns: 'io.mock.wallet' };
    const provider = {
      request: async ({ method, params }) => { const o = JSON.parse(await window.__walletRequest(JSON.stringify({ method, params }))); if (o.error) { const e = new Error(o.error.message); e.code = o.error.code; throw e; } return o.result; },
      on: () => {}, removeListener: () => {},
    };
    const announce = () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: Object.freeze({ info, provider }) }));
    window.addEventListener('eip6963:requestProvider', announce); announce();
  });

  try {
    await page.goto(`${BASE}/app/create/`, { waitUntil: 'networkidle' });
    console.log('\n[1] not connected: nothing can be sent');
    expect(await T(page, 'create-submit').isDisabled(), 'Create is disabled until a wallet is connected');
    expect(await T(page, 'faucet-drip').isDisabled(), 'Faucet is disabled until a wallet is connected');
    expect(/Disabled until you connect/.test(await T(page, 'why-create').innerText()) && /Disabled until you connect/.test(await T(page, 'why-faucet').innerText()), 'the page says why the buttons are disabled');
    const pre = await T(page, 'create-prereqs').innerText();
    expect(/wallet/i.test(pre) && /test ETH/.test(pre) && /46630/.test(pre) && (await T(page, 'create-prereqs').locator('a[href="https://faucet.testnet.chain.robinhood.com"]').count()) === 1, 'prerequisites list the wallet, the network details and the testnet ETH faucet link');
    expect((await T(page, 'create-prereqs').locator('a[href="/app/"]').count()) === 1, 'a visitor without a wallet is pointed to step 4');

    await T(page, 'wallet-connect-btn').first().click(); await sleep(400);
    if (await T(page, 'wallet-chooser-item').count()) await T(page, 'wallet-chooser-item').first().click();
    await T(page, 'wallet-address').first().waitFor({ timeout: 15000 });
    await page.waitForFunction(() => /You hold/.test(document.querySelector('[data-testid="token-balance"]')?.textContent || ''), null, { timeout: 30000 });
    ok('wallet connected, balance read from chain');
    expect(await T(page, 'agents-empty').count() === 1, 'a new wallet has no agents');

    console.log('\n[2] test money from the faucet');
    await T(page, 'faucet-drip').click();
    expect((await waitState(page, 'faucet', ['confirmed'])) === 'confirmed', 'drip confirmed');
    expect(callU(AG.token, 'balanceOf(address)(uint256)', user.address) === 1_000_000_000n, 'on-chain: wallet holds 1,000 mUSDG');
    await page.waitForFunction(() => /\$1,000\.00/.test(document.querySelector('[data-testid="token-balance"]')?.textContent || ''), null, { timeout: 30000 });
    ok('UI shows $1,000.00');
    await page.waitForFunction(() => document.querySelector('[data-testid="faucet-drip"]')?.disabled === true, null, { timeout: 30000 });
    ok('a second drip is blocked by the cooldown');

    console.log('\n[3] an invalid form never reaches the wallet');
    const sent0 = sent;
    await T(page, 'create-margin').fill('0.5');
    await T(page, 'create-agent-address').fill('0x123');
    await T(page, 'create-submit').click(); await sleep(600);
    expect(sent === sent0, 'no wallet request for an invalid form');
    expect(/between 1% and 90%/.test(await page.locator('#ca-margin-e').innerText()), 'margin error is a sentence');
    expect(/not a valid address/.test(await page.locator('#ca-key-e').innerText()), 'address error is a sentence');
    await T(page, 'create-daily').fill('100'); await T(page, 'create-pertrade').fill('200'); await sleep(300);
    expect(/daily budget/.test(await page.locator('#ca-per-e').innerText()), 'a trade bigger than the daily budget is explained');

    console.log('\n[4] generate a key in the page, then create the agent');
    await T(page, 'create-genkey').click();
    const genKey = (await T(page, 'create-key-value').innerText()).trim();
    expect(/^0x[0-9a-f]{64}$/.test(genKey), 'a 32-byte key is shown once');
    const genAddr = privateKeyToAccount(genKey).address;
    expect((await T(page, 'create-agent-address').inputValue()) === genAddr, 'the address field holds the key\'s address');
    await T(page, 'create-name').fill('E2E agent'); await T(page, 'create-daily').fill('3000'); await T(page, 'create-pertrade').fill('1500'); await T(page, 'create-margin').fill('20'); await T(page, 'create-ttl').fill('120');
    await sleep(400);
    expect(/at most \$3,000\.00 a day/.test(await T(page, 'create-summary').innerText()), 'plain-words summary matches the inputs');
    await T(page, 'create-submit').click();
    expect((await waitState(page, 'create', ['confirmed'])) === 'confirmed', 'createAgent confirmed');

    console.log('\n[5] everything the page created, read back independently');
    const idx = castFull('call', AG.factory, 'agentsOf(address)(uint256[])', user.address);
    expect(/^\[0*\d+\]$|^\[\d+\]/.test(idx.replace(/\s/g, '')) && idx.split(',').length === 1, 'factory lists exactly one agent for this wallet: ' + idx);
    const i = idx.replace(/[\[\]\s]/g, '').split(' ')[0];
    const rec = castFull('call', AG.factory, 'agents(uint256)(address,address,address,uint256,address,uint64)', i).split('\n').map((x) => x.split(' ')[0]);
    const [, vault, account, agentId, signer] = rec.map((x, k) => (k === 0 || k === 1 || k === 2 || k === 4 ? getAddress(x) : x));
    expect(callA(vault, 'owner()(address)') === getAddress(user.address), 'vault owner is the connected wallet');
    expect(callA(vault, 'agent()(address)') === account, 'vault agent is the locked account');
    expect(callA(account, 'signer()(address)') === genAddr && signer === genAddr, 'account signer is the key generated in the page');
    expect(callA(account, 'vault()(address)') === vault, 'account is bound to the vault');
    expect(callU(vault, 'dailySpendCap()(uint256)') === 300_000n && callU(vault, 'maxExec()(uint256)') === 150_000n && callU(vault, 'minMarginBps()(uint256)') === 2000n && callU(vault, 'quoteTTL()(uint256)') === 120n, 'on-chain limits equal the form ($3,000 / $1,500 / 20% / 120s)');
    expect(cast('call', vault, 'payee(address)(bool)', '0x935A27083d49495a2F6E13E2e8Db5e97D94a04A4') === 'true', 'the test supplier is allowed');
    expect(callA(AG.registry, 'ownerOf(uint256)(address)', agentId) === getAddress(user.address), 'the identity token is owned by the wallet');
    const uri = castFull('call', AG.registry, 'tokenURI(uint256)(string)', agentId).replace(/^"|"$/g, '');
    expect(/^data:application\/json;base64,/.test(uri) && JSON.parse(Buffer.from(uri.split(',')[1], 'base64').toString()).name === 'E2E agent', 'the registration file carries the name');
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="agent-pick"]').length === 1, null, { timeout: 30000 });
    ok('the page lists the new agent and selected it');
    await page.waitForFunction(() => /RUNNING/.test(document.querySelector('[data-testid="agent-status"]')?.textContent || ''), null, { timeout: 30000 }); ok('status RUNNING shown');

    console.log('\n[6] fund the vault (approve + deposit), add gas');
    await T(page, 'fund-amount').fill('500'); await T(page, 'fund-submit').click();
    expect((await waitState(page, 'fund', ['confirmed'])) === 'confirmed', 'fund confirmed (two steps)');
    expect(callU(vault, 'free()(uint256)') === 500_000_000n, 'on-chain vault free == 500 mUSDG');
    expect(callU(AG.token, 'balanceOf(address)(uint256)', user.address) === 500_000_000n, 'wallet holds the other 500');
    await T(page, 'fund-amount').fill('99999'); await sleep(300);
    expect(await T(page, 'fund-submit').isDisabled(), 'funding more than you hold is blocked in the form');
    await T(page, 'gas-amount').fill('0.0004'); await T(page, 'gas-submit').click();
    expect((await waitState(page, 'gas', ['confirmed'])) === 'confirmed', 'gas deposit confirmed');
    expect(callU(AG.entryPoint, 'balanceOf(address)(uint256)', account) === parseEther('0.0004'), 'EntryPoint holds 0.0004 ETH for the account');

    console.log('\n[6b] change the limits');
    await T(page, 'limit-margin').fill('25'); await sleep(300);
    await T(page, 'limit-save').click();
    expect((await waitState(page, 'limits', ['confirmed'])) === 'confirmed', 'setPolicy confirmed');
    expect(callU(vault, 'minMarginBps()(uint256)') === 2500n && callU(vault, 'dailySpendCap()(uint256)') === 300_000n && callU(vault, 'maxExec()(uint256)') === 150_000n && callU(vault, 'quoteTTL()(uint256)') === 120n, 'on-chain margin floor is 25%, other limits untouched');
    await T(page, 'limit-margin').fill('0.5'); await sleep(300);
    expect(await T(page, 'limit-save').isDisabled(), 'an invalid margin disables Save');

    console.log('\n[7] kill switch');
    await T(page, 'agent-pause').click();
    expect((await waitState(page, 'pause', ['confirmed'])) === 'confirmed', 'pause confirmed');
    expect(cast('call', vault, 'paused()(bool)') === 'true', 'on-chain paused');
    await page.waitForFunction(() => /PAUSED/.test(document.querySelector('[data-testid="agent-status"]')?.textContent || ''), null, { timeout: 30000 }); ok('UI shows PAUSED');
    await T(page, 'agent-pause').click();
    expect((await waitState(page, 'pause', ['confirmed'])) === 'confirmed', 'resume confirmed');
    expect(cast('call', vault, 'paused()(bool)') === 'false', 'on-chain running again');

    await T(page, 'limit-margin').fill('18'); await sleep(300); await T(page, 'limit-save').click();
    expect((await waitState(page, 'limits', ['confirmed'])) === 'confirmed', 'limits set back to 18%');

    console.log('\n[8] the agent created in the page actually works: its key signs real ERC-4337 UserOperations');
    const { userOpClient } = await import('file://' + path.join(__dirname, '../apps/web/tools/userop.ts'));
    const uop = userOpClient(pub, AG.entryPoint, funder.address, (data) => fw.sendTransaction({ to: AG.entryPoint, data, gas: 4_000_000n }));
    const QUOTE = 'uint256 purchaseCents,uint256 shipCents,uint256 dutyCents,uint256 taxCents,uint256 procFeeCents,uint256 payFeeCents,uint256 sellCents,uint256 mktFeeBps,uint256 fulfillCents,uint256 retBps,uint256 chainCents';
    const q = [590n, 42n, 12n, 8n, 5n, 2n, 1099n, 800n, 65n, 200n, 4n];
    const qh = keccak256(encodeAbiParameters(parseAbiParameters(QUOTE), q));
    const PROD = keccak256(toHex('CASE-IP16PRO-CLEAR-MAG-001')); const SNAP = keccak256(toHex('e2e-' + Date.now()));
    const qo = { purchaseCents: q[0], shipCents: q[1], dutyCents: q[2], taxCents: q[3], procFeeCents: q[4], payFeeCents: q[5], sellCents: q[6], mktFeeBps: q[7], fulfillCents: q[8], retBps: q[9], chainCents: q[10] };
    const abi = webRequire('viem').parseAbi([`function commitOpportunity(bytes32,bytes32,bytes32,uint256,uint256,(${QUOTE}),int256,uint256) returns (bytes32,uint256,int256)`, 'function transfer(address,uint256) returns (bool)', 'function withdraw(uint256)']);
    const commit = (units, net, bps) => encodeFunctionData({ abi, functionName: 'commitOpportunity', args: [PROD, qh, SNAP, BigInt(Math.floor(Date.now() / 1000) - 5), units, qo, net, bps] });
    const oppHash = keccak256(encodeAbiParameters(parseAbiParameters('bytes32,bytes32,bytes32'), [PROD, qh, SNAP]));
    const opExists = () => castFull('call', vault, 'opps(bytes32)(bytes32,uint256,uint256,uint256,int256,bool,bool)', oppHash).split('\n')[5].startsWith('true');
    const honest = await uop.buildOp(account, uop.exec(vault, 0n, commit(100n, 261n, 2374n)), genKey);
    const run = await uop.bundle(honest);
    expect(run.success && opExists(), 'honest UserOp signed by the page-generated key committed an opportunity in the page-created vault');
    expect(callU(vault, 'spentToday()(uint256)') === 65_900n, 'vault derived the spend itself: 659 x 100 = 65,900 cents');
    const steal = await uop.buildOp(account, uop.exec(AG.token, 0n, encodeFunctionData({ abi, functionName: 'transfer', args: ['0x000000000000000000000000000000000000dEaD', 1000000n] })), genKey);
    const refused = await uop.dryRun(steal);
    expect(!refused.accepted && refused.error === 'TargetNotAllowed', 'a token transfer UserOp is refused by the account: ' + refused.code + ' ' + refused.error);
    const wd = await uop.buildOp(account, uop.exec(vault, 0n, encodeFunctionData({ abi, functionName: 'withdraw', args: [1000000n] })), genKey);
    const r2 = await uop.dryRun(wd);
    expect(!r2.accepted && r2.error === 'SelectorNotAllowed', 'an owner-only call is refused by the account: ' + r2.error);
    const stranger = await uop.buildOp(account, uop.exec(vault, 0n, commit(100n, 261n, 2374n)), generatePrivateKey());
    const r3 = await uop.dryRun(stranger);
    expect(!r3.accepted && r3.code === 'AA24', 'a UserOp signed by anyone else is refused (AA24)');
    expect(callU(vault, 'free()(uint256)') === 500_000_000n, 'vault money untouched by all refused attempts');

    console.log('\n[9] page health');
    expect(errs.length === 0, 'no page or console errors' + (errs.length ? ': ' + errs.join(' | ') : ''));
    await page.setViewportSize({ width: 390, height: 844 }); await sleep(400);
    expect(!(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)), 'no horizontal overflow at phone width');
  } catch (e) { fail('crashed: ' + (e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e)); } finally {
    await browser.close();
    try { // sweep what is left of the throwaway wallet's ETH back to the deployer (best effort)
      const bal = await pub.getBalance({ address: user.address }); const keep = parseEther('0.00003');
      if (bal > keep) await pub.waitForTransactionReceipt({ hash: await uw.sendTransaction({ to: funder.address, value: bal - keep }) });
    } catch { /* leaving a few wei behind is fine */ }
  }
  console.log(failures ? `\n${failures} FAILURE(S)` : '\ncreate-agent e2e: all checks passed');
  process.exit(failures ? 1 : 0);
})();
