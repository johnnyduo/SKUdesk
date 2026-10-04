import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { getAddress } from 'viem';
import { useWallet, useRole, CORE, TOKEN, CORE_ABI, TOKEN_ABI, readTokenInfo } from '../../lib/wallet-app';
import { client, readVault, readPolicy, simulateCommit, type VaultState, type PolicyState, type SimResult } from '../../lib/chain';
import { RUN, ECON, SNAPSHOT, DEPLOYMENT, CHAIN, explorer, usdBase, usdCents, pct, short } from '../../lib/run';
import { useTx, TxButton, TxStatus, type Tx } from './TxButton';
import { Addr, Field, Card, Need } from './ui';
import { parseDollars, parseMarginPct, parseSeconds, parseTokenAmount, parseAddress, baseToInput, centsToInput, bpsToInput } from './parse';
import './wallet.css';

// The Owner console. Read-only data comes from the public RPC (lib/chain.ts); every write goes through TxButton ->
// walletEngine.send, which simulates first and never signs a doomed transaction. Nothing runs on page load except reads.

const POLL_MS = 15_000;
const SIM_MS = 10_000;
const SOON = 2_500;       // a second read shortly after a confirmation, in case the RPC node lags a block
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

// The honest recorded trade, read from the run (never hardcoded).
const BUY = SNAPSHOT.offers.find((o) => o.id === RUN.accepted.buyOfferId);
const SELL = SNAPSHOT.offers.find((o) => o.id === RUN.accepted.sellOfferId);
const TRADE = { buyCents: BUY?.priceCents ?? 0, shipCents: BUY?.shipCents ?? 0, sellCents: SELL?.priceCents ?? 0, units: ECON.units };
const REC = { free: BigInt(RUN.end.free), totalEscrow: BigInt(RUN.end.totalEscrow), totalPaidOut: BigInt(RUN.end.totalPaidOut), totalProceeds: BigInt(RUN.end.totalProceeds) };
const MAX_UINT_HALF = 1n << 255n;

type Role = 'owner' | 'agent' | 'visitor';

function Ago({ at }: { at: number }) {
  const [n, setN] = useState(() => Date.now());
  useEffect(() => { const t = setInterval(() => setN(Date.now()), 1000); return () => clearInterval(t); }, []);
  return <>{Math.max(0, Math.round((n - at) / 1000))}s ago</>;
}

export default function OwnerConsole() {
  const w = useWallet();
  const connected = w.status === 'connected' && !!w.account;
  const account = connected ? w.account! : undefined;
  const { role, owner } = useRole(account);
  const ownerAddr = owner ?? DEPLOYMENT.owner;

  // live reads
  const [vault, setVault] = useState<VaultState | null>(null);
  const [policy, setPolicy] = useState<PolicyState | null>(null);
  const [vaultFail, setVaultFail] = useState(false);
  const [tok, setTok] = useState<{ balance: bigint; allowance: bigint } | null>(null);
  const [tokenOwner, setTokenOwner] = useState<string | null>(null);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  const loadChain = useCallback(async () => {
    try {
      const [v, p] = await Promise.all([readVault(), readPolicy()]);
      if (!alive.current) return; setVault(v); setPolicy(p); setVaultFail(false);
    } catch { if (alive.current) setVaultFail(true); }
  }, []);
  const loadToken = useCallback(async () => {
    try {
      if (account) { const t = await readTokenInfo(account); if (alive.current) { setTok({ balance: t.balance, allowance: t.allowance }); setTokenOwner(t.tokenOwner); } }
      else { setTok(null); const o = await client().readContract({ address: getAddress(TOKEN), abi: TOKEN_ABI, functionName: 'owner' }); if (alive.current) setTokenOwner(o as string); }
    } catch { /* leave the previous values; the vault status line reports RPC trouble */ }
  }, [account]);

  // agent's view (simulateCommit as the agent, nothing is sent)
  const [sim, setSim] = useState<{ phase: 'wait' | 'ok' | 'refused' | 'rpc'; res?: SimResult; at: number; busy: boolean }>({ phase: 'wait', at: 0, busy: true });
  const simSeq = useRef(0);
  const runSim = useCallback(async () => {
    const id = ++simSeq.current;
    setSim((s) => ({ ...s, busy: true }));
    try {
      const res = await simulateCommit(TRADE);
      if (alive.current && id === simSeq.current) setSim({ phase: res.accepted ? 'ok' : 'refused', res, at: Date.now(), busy: false });
    } catch { if (alive.current && id === simSeq.current) setSim(() => ({ phase: 'rpc', res: undefined, at: Date.now(), busy: false })); }
  }, []);

  // allowlists
  const [addrIn, setAddrIn] = useState('');
  const [listTick, setListTick] = useState(0);
  const [demoList, setDemoList] = useState<{ supplier: boolean | null; payer: boolean | null }>({ supplier: null, payer: null });
  const [custom, setCustom] = useState<{ addr: string; payee: boolean; payer: boolean } | null>(null);
  const addrP = useMemo(() => parseAddress(addrIn), [addrIn]);
  const readLists = useCallback(async () => {
    const c = client(); const core = getAddress(CORE);
    const rd = (fn: 'payee' | 'payer', a: string) => c.readContract({ address: core, abi: CORE_ABI, functionName: fn, args: [getAddress(a)] }) as Promise<boolean>;
    try {
      const [s, p] = await Promise.all([rd('payee', DEPLOYMENT.supplier), rd('payer', DEPLOYMENT.payer)]);
      if (alive.current) setDemoList({ supplier: s, payer: p });
    } catch { /* keep previous */ }
    if (addrP.ok) {
      try { const [a, b] = await Promise.all([rd('payee', addrP.address), rd('payer', addrP.address)]); if (alive.current) setCustom({ addr: addrP.address, payee: a, payer: b }); } catch { /* */ }
    } else setCustom(null);
  }, [addrP]);

  const refreshAll = useCallback(() => {
    void loadChain(); void loadToken(); void runSim(); setListTick((n) => n + 1);
    setTimeout(() => { if (!alive.current) return; void loadChain(); void loadToken(); void runSim(); setListTick((n) => n + 1); }, SOON);
  }, [loadChain, loadToken, runSim]);

  useEffect(() => { void loadChain(); const t = setInterval(loadChain, POLL_MS); return () => clearInterval(t); }, [loadChain]);
  useEffect(() => { void loadToken(); }, [loadToken]);
  useEffect(() => { void runSim(); const t = setInterval(runSim, SIM_MS); return () => clearInterval(t); }, [runSim]);
  useEffect(() => { void readLists(); }, [readLists, listTick]);

  // transactions
  const dep = useTx('deposit', refreshAll);
  const wd = useTx('withdraw', refreshAll);
  const pol = useTx('policy', () => { setDirty(false); refreshAll(); });
  const pau = useTx('pause', refreshAll);
  const pyAdd = useTx('payee-add', refreshAll);
  const pyRem = useTx('payee-remove', refreshAll);
  const prAdd = useTx('payer-add', refreshAll);
  const prRem = useTx('payer-remove', refreshAll);
  const mnt = useTx('mint', refreshAll);

  // deposit / withdraw
  const [depIn, setDepIn] = useState('');
  const [wdIn, setWdIn] = useState('');
  const depP = parseTokenAmount(depIn); const wdP = parseTokenAmount(wdIn);
  const needApprove = !!(tok && depP.ok && tok.allowance < depP.base);
  const lowBal = !!(tok && depP.ok && tok.balance < depP.base);
  const doDeposit = () => {
    if (!depP.ok || !account) return; const amount = depP.base;
    void dep.run(async (send) => {
      const fresh = await readTokenInfo(account);                       // never trust a stale allowance
      let approved = false;
      if (fresh.allowance < amount) {
        await send(`Step 1 of 2: approve the vault to take ${usdBase(amount)}`, { address: TOKEN, abi: TOKEN_ABI, functionName: 'approve', args: [CORE, amount] }, 'approve');
        approved = true;
      }
      const label = approved ? 'Step 2 of 2: deposit' : 'Deposit';
      for (let i = 0; ; i++) {
        try { await send(label, { address: CORE, abi: CORE_ABI, functionName: 'deposit', args: [amount] }); return; }
        catch (e: any) { // right after an approval some RPC nodes lag a block: retry the simulation a few times
          if (approved && i < 3 && e?.kind === 'simulation' && /Allowance|TransferFailed/.test(e.errorName ?? '')) { await wait(2000); continue; }
          throw e;
        }
      }
    });
  };
  const doWithdraw = () => { if (wdP.ok) void wd.run(async (send) => { await send('Withdraw', { address: CORE, abi: CORE_ABI, functionName: 'withdraw', args: [wdP.base] }); }); };

  // mandate
  const [form, setForm] = useState({ exec: '', daily: '', margin: '', ttl: '' });
  const [dirty, setDirty] = useState(false);
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const fromPolicy = (p: PolicyState) => ({ exec: centsToInput(p.maxExec), daily: centsToInput(p.dailySpendCap), margin: bpsToInput(p.minMarginBps), ttl: String(p.quoteTTL) });
  useEffect(() => { if (policy && !dirty) setForm(fromPolicy(policy)); }, [policy, dirty]);
  const edit = (k: keyof typeof form) => (v: string) => { setDirty(true); setForm((f) => ({ ...f, [k]: v })); };
  const touch = (k: string) => () => setTouched((t) => ({ ...t, [k]: true }));
  const pe = parseDollars(form.exec), pd = parseDollars(form.daily), pm = parseMarginPct(form.margin), pt = parseSeconds(form.ttl);
  const errOf = (k: keyof typeof form, p: { ok: boolean; error?: string }) => (!p.ok && (form[k] !== '' || touched[k]) && policy ? (p as any).error : undefined);
  const valid = pe.ok && pd.ok && pm.ok && pt.ok;
  const next = valid ? { exec: BigInt(pe.cents), daily: BigInt(pd.cents), bps: BigInt(pm.bps), ttl: BigInt(pt.seconds) } : null;
  const changed = !!(policy && next && (next.exec !== policy.maxExec || next.daily !== policy.dailySpendCap || next.bps !== policy.minMarginBps || next.ttl !== policy.quoteTTL));
  const diffRows = policy ? [
    { k: 'Per-trade cap', now: usdCents(policy.maxExec), after: next ? usdCents(next.exec) : '', diff: !!next && next.exec !== policy.maxExec },
    { k: 'Per-day cap', now: usdCents(policy.dailySpendCap), after: next ? usdCents(next.daily) : '', diff: !!next && next.daily !== policy.dailySpendCap },
    { k: 'Margin floor', now: pct(Number(policy.minMarginBps)), after: next ? pct(Number(next.bps)) : '', diff: !!next && next.bps !== policy.minMarginBps },
    { k: 'Quote freshness', now: `${policy.quoteTTL} s`, after: next ? `${next.ttl} s` : '', diff: !!next && next.ttl !== policy.quoteTTL },
  ] : [];
  const doPolicy = () => { if (!next) return; void pol.run(async (send) => { await send('Save mandate', { address: CORE, abi: CORE_ABI, functionName: 'setPolicy', args: [next.daily, next.exec, next.bps, next.ttl] }); }); };
  const execOverDaily = pe.ok && pd.ok && pe.cents > pd.cents;

  // kill switch
  const paused = vault?.paused;
  const doPause = () => { if (paused === undefined) return; void pau.run(async (send) => { await send(paused ? 'Resume the vault' : 'Pause the vault', { address: CORE, abi: CORE_ABI, functionName: 'pause', args: [!paused] }); }); };

  // allowlist writes
  const setList = (tx: Tx, fn: 'setPayee' | 'setPayer', ok: boolean, label: string) => { if (!addrP.ok) return; const a = addrP.address; void tx.run(async (send) => { await send(label, { address: CORE, abi: CORE_ABI, functionName: fn, args: [a, ok] }); }); };

  // mint
  const [mintIn, setMintIn] = useState('1000');
  const mintP = parseTokenAmount(mintIn);
  const doMint = () => { if (mintP.ok && account) void mnt.run(async (send) => { await send('Mint test tokens', { address: TOKEN, abi: TOKEN_ABI, functionName: 'mint', args: [account, mintP.base] }); }); };

  // derived display
  const v = vault ?? (vaultFail ? { ...REC, totalDeposited: 0n, totalWithdrawn: 0n, spentToday: 0n, paused: undefined as unknown as boolean, block: 0n, at: 0 } : null);
  const total = v ? (v.free + v.totalEscrow + v.totalPaidOut) || 1n : 1n;
  const bar = (x: bigint) => `${v ? Number((x * 10000n) / total) / 100 : 0}%`;
  const d = (b?: bigint) => (v && b !== undefined ? usdBase(b) : '…');
  const roleOf = (r: Role | null) => r;
  const offDisable = !connected;
  const needId = connected ? undefined : 'wl-need';
  const unlimited = tok && tok.allowance >= MAX_UINT_HALF;

  return (
    <div className="wl-console">
      {/* a. connection and role */}
      <Card id="conn" title="Your connection" intro="Who you are connected as decides what the contract will let you do. The vault has exactly one owner address; the AI agent has its own, separate address.">
        <div className={'wl-banner ' + (!connected ? 'idle' : role === 'owner' ? 'owner' : role ? 'notowner' : 'idle')} data-testid="owner-role-banner" role="status" aria-live="polite">
          {!connected && <><b>Not connected.</b> Connect the owner wallet <Addr a={ownerAddr} /> with the button in the top bar to make changes. You can read everything below without a wallet.</>}
          {connected && !role && <>Checking who you are on the contract…</>}
          {connected && role === 'owner' && <><b>You are the owner.</b> Anything you save here is a real testnet transaction that changes the vault for the agent too.</>}
          {connected && role === 'agent' && <><b>You are not the owner.</b> This is the agent wallet: it can propose trades but cannot change anything on this page. Buttons still work as a test: the contract will refuse and tell you why.</>}
          {connected && role === 'visitor' && <><b>You are not the owner.</b> Buttons still work as a test: the contract will refuse and tell you why.</>}
        </div>
        <dl className="ov-kv wl-kv">
          <div><dt>Connected account<small>{w.wallet?.name ?? 'No wallet connected'}</small></dt><dd className="mono">{account ? <Addr a={account} label={short(account, 8, 6)} /> : <span className="muted">none</span>}</dd></div>
          <div><dt>Your role<small>Read from the contract</small></dt><dd>{roleOf(role) ? <span className={'wl-role r-' + role}>{role}</span> : <span className="muted">{connected ? '…' : 'none'}</span>}</dd></div>
          <div><dt>Network<small>The contract lives on {CHAIN.name}</small></dt><dd>{!connected ? <span className="muted">not connected</span> : w.onTargetChain ? <span className="pill good">{CHAIN.name}</span> : <span className="pill warn">wrong network{w.chainId ? ` (chain ${w.chainId})` : ''}</span>}</dd></div>
          <div><dt>Vault owner<small>The only wallet that can change the mandate</small></dt><dd className="mono"><Addr a={ownerAddr} label={short(ownerAddr, 8, 6)} /></dd></div>
          <div><dt>AI agent<small>Can propose trades, cannot change these settings</small></dt><dd className="mono"><Addr a={RUN.meta.agent} label={short(RUN.meta.agent, 8, 6)} /></dd></div>
        </dl>
        {connected && !w.onTargetChain && <p className="wl-note warn">Your wallet is on the wrong network. Use the Switch button in the top bar; {CHAIN.name} is added to your wallet automatically if it is missing. Writing from here also offers to switch first.</p>}
      </Card>

      {/* b. vault */}
      <Card id="vault" title="The vault" intro={<>The pot of test money the contract holds. <b>Free</b> can be moved by the owner, <b>in escrow</b> is locked to one purchase, <b>paid out</b> went to the approved supplier. Everything refreshes after each confirmed transaction.</>}>
        <p className="ov-status mono" role="status" aria-live="polite">
          {vault && !vaultFail ? <><span className="ov-dot live" aria-hidden="true" />LIVE from {CHAIN.name}, block {vault.block.toString()}, updated <Ago at={vault.at} /></>
            : vaultFail ? <><span className="ov-dot off" aria-hidden="true" />RPC unreachable. Showing the saved values from the end of the run. <button type="button" className="ov-link" onClick={() => void loadChain()}>Try again</button></>
            : <><span className="ov-dot wait" aria-hidden="true" />Reading the chain…</>}
        </p>
        <div className="ov-bar" role="img" aria-label={v ? `Free ${d(v.free)}, in escrow ${d(v.totalEscrow)}, paid out ${d(v.totalPaidOut)}` : 'Loading vault balances'}>
          <i className="free" style={{ width: bar(v?.free ?? 0n) }} /><i className="escrow" style={{ width: bar(v?.totalEscrow ?? 0n) }} /><i className="paid" style={{ width: bar(v?.totalPaidOut ?? 0n) }} />
        </div>
        <div className="ov-legend">
          <div><i className="free" /><small>Free</small><b className="mono" data-testid="owner-vault-free">{d(v?.free)}</b></div>
          <div><i className="escrow" /><small>In escrow</small><b className="mono" data-testid="owner-vault-escrow">{d(v?.totalEscrow)}</b></div>
          <div><i className="paid" /><small>Paid out</small><b className="mono" data-testid="owner-vault-paid">{d(v?.totalPaidOut)}</b></div>
          <div><i className="proc" /><small>Sale proceeds received</small><b className="mono" data-testid="owner-vault-proceeds">{d(v?.totalProceeds)}</b></div>
        </div>
        <dl className="ov-kv wl-kv">
          <div><dt>Your test-token balance<small>mUSDG, a testnet stand-in token, in your connected wallet</small></dt><dd className="mono" data-testid="owner-token-balance">{account ? (tok ? usdBase(tok.balance) : '…') : <span className="muted wl-sm">connect a wallet</span>}</dd></div>
          <div><dt>Allowance you gave the vault<small>How much the vault may pull from your wallet when you deposit</small></dt><dd className="mono" data-testid="owner-token-allowance">{account ? (tok ? (unlimited ? 'Unlimited' : usdBase(tok.allowance)) : '…') : <span className="muted wl-sm">connect a wallet</span>}</dd></div>
        </dl>
      </Card>

      {/* c. deposit and withdraw */}
      <div className="wl-two">
        <Card id="dep" title="Deposit" intro="Put test money into the vault so the agent has something to work with. The vault first needs your permission to take it (an approval), then it takes it (the deposit). That is two confirmations when the approval is missing.">
          <Field id="wl-dep" label="Amount to deposit" prefix="$" value={depIn} onChange={setDepIn} testid="owner-deposit-input" placeholder="500.00" error={depIn && !depP.ok ? depP.error : undefined}
            hint={account && tok ? <>You hold {usdBase(tok.balance)}. <button type="button" className="ov-link" onClick={() => setDepIn(baseToInput(tok.balance))}>Use all</button></> : 'In test dollars (mUSDG), up to six decimals.'} />
          {depP.ok && connected && tok && (
            <ol className="wl-steps" aria-label="Steps for this deposit">
              <li className={needApprove ? (dep.view.links.some((l) => l.key === 'approve') ? 'done' : 'todo') : 'skip'}><span>1</span>{needApprove ? `Approve the vault to take exactly ${usdBase(depP.base)}` : 'Approval already in place'}</li>
              <li className={dep.view.state === 'confirmed' ? 'done' : 'todo'}><span>2</span>Deposit {usdBase(depP.base)}</li>
            </ol>
          )}
          {lowBal && <p className="wl-note warn">Your balance is lower than this amount, so the deposit will be refused. Mint test tokens below if you are the token owner.</p>}
          <Need connected={connected} />
          <TxButton tx={dep} testid="owner-deposit-btn" onClick={doDeposit} disabled={offDisable || !depP.ok} why={offDisable ? 'Connect a wallet first' : 'Enter a valid amount'} describedBy={needId}>
            {needApprove ? 'Approve, then deposit' : 'Deposit'}
          </TxButton>
          <TxStatus tx={dep} />
        </Card>
        <Card id="wd" title="Withdraw" intro="Take free money back to your wallet. Only free funds can leave: money in escrow is locked to a purchase, and the contract will tell you the exact figures if you ask for too much.">
          <Field id="wl-wd" label="Amount to withdraw" prefix="$" value={wdIn} onChange={setWdIn} testid="owner-withdraw-input" placeholder="100.00" error={wdIn && !wdP.ok ? wdP.error : undefined}
            hint={v ? <>{usdBase(v.free)} is free right now. <button type="button" className="ov-link" onClick={() => setWdIn(baseToInput(v.free))}>Use all</button></> : 'Only free funds can be withdrawn.'} />
          <Need connected={connected} />
          <TxButton tx={wd} testid="owner-withdraw-btn" onClick={doWithdraw} disabled={offDisable || !wdP.ok} why={offDisable ? 'Connect a wallet first' : 'Enter a valid amount'} variant="ghost" describedBy={needId}>Withdraw</TxButton>
          <TxStatus tx={wd} />
        </Card>
      </div>

      {/* d. mandate */}
      <Card id="mandate" title="The mandate" intro={<>The rules the agent has to stay inside. Change them and the contract enforces the new numbers on new commitments; pause to stop funding of earlier ones. <b>Margin</b> is profit as a share of the sell price; <b>quote freshness</b> is how old a price may be, by the date the agent supplies, before the contract refuses it. <b>Per-day cap</b> limits new commitments per UTC day, not cash-out.</>}>
        <div className="wl-mfields">
          <Field id="wl-exec" label="Per-trade cap" prefix="$" value={form.exec} onChange={edit('exec')} onBlur={touch('exec')} testid="owner-policy-exec" error={errOf('exec', pe)} hint="Most the agent may spend on one purchase." disabled={!policy} />
          <Field id="wl-daily" label="Per-day cap" prefix="$" value={form.daily} onChange={edit('daily')} onBlur={touch('daily')} testid="owner-policy-daily" error={errOf('daily', pd)} hint="Most new buying it may commit to in one UTC day. Not a cash-out limit." disabled={!policy} />
          <Field id="wl-margin" label="Margin floor" suffix="%" value={form.margin} onChange={edit('margin')} onBlur={touch('margin')} testid="owner-policy-margin" error={errOf('margin', pm)} hint="Trades below this profit share are refused. 1 to 90." disabled={!policy} />
          <Field id="wl-ttl" label="Quote freshness" suffix="seconds" inputMode="numeric" value={form.ttl} onChange={edit('ttl')} onBlur={touch('ttl')} testid="owner-policy-ttl" error={errOf('ttl', pt)} hint="Prices the agent dates as older are refused." disabled={!policy} />
        </div>
        {execOverDaily && <p className="wl-note">The per-trade cap is above the per-day cap, so the daily cap will be the one that bites.</p>}
        {policy ? (
          <table className="wl-diff" data-testid="owner-policy-diff">
            <caption className="sr-only">Current mandate compared with your edits</caption>
            <thead><tr><th scope="col">Setting</th><th scope="col">Now</th><th scope="col">After saving</th></tr></thead>
            <tbody>{diffRows.map((r) => (
              <tr key={r.k} className={r.diff ? 'chg' : ''}><th scope="row">{r.k}</th><td className="mono">{r.now}</td><td className="mono">{r.after ? (r.diff ? <><span aria-hidden="true">→ </span><b>{r.after}</b><span className="sr-only"> (changed)</span></> : <span className="muted">no change</span>) : <span className="muted">fix the field</span>}</td></tr>
            ))}</tbody>
          </table>
        ) : <p className="wl-note">{vaultFail ? 'Could not read the current mandate from the chain. Try again in a moment.' : 'Reading the current mandate from the chain…'}</p>}
        <Need connected={connected} />
        <div className="wl-actions">
          <TxButton tx={pol} testid="owner-policy-save" onClick={doPolicy} disabled={offDisable || !valid || !changed} why={offDisable ? 'Connect a wallet first' : !valid ? 'Fix the highlighted fields' : 'Change at least one number'} describedBy={needId}>Save mandate</TxButton>
          {dirty && <button type="button" className="btn ghost" onClick={() => { setDirty(false); setTouched({}); }} disabled={pol.busy}>Reset to current</button>}
        </div>
        <TxStatus tx={pol} />
      </Card>

      {/* e. kill switch */}
      <section className="wl-kill" aria-labelledby="kill-h">
        <div className={'card wl-card wl-switch-card ' + (paused === true ? 'is-paused' : paused === false ? 'is-running' : '')}>
          <h2 id="kill-h" className="wl-h2">Kill switch</h2>
          <p className="ov-gl">One press stops every action the agent can take, until you resume it. Money already in escrow stays where it is. It does not touch your own deposit and withdraw buttons.</p>
          <div className="wl-state">
            <span className="wl-state-ic" aria-hidden="true">{paused ? '❚❚' : paused === false ? '▶' : '…'}</span>
            <div><small>The vault is</small><b data-testid="owner-paused-state" className={paused ? 'bad' : 'ok'}>{paused === undefined ? '…' : paused ? 'PAUSED' : 'RUNNING'}</b></div>
          </div>
          <Need connected={connected} />
          <TxButton tx={pau} testid="owner-pause-btn" onClick={doPause} disabled={offDisable || paused === undefined} why={offDisable ? 'Connect a wallet first' : 'Reading the current state…'} variant={paused ? 'primary' : 'danger'} big describedBy={needId}>{paused ? 'Resume the vault' : 'Pause the vault'}</TxButton>
          <TxStatus tx={pau} />
        </div>
        <div className="card wl-card">
          <h2 id="sim-h" className="wl-h2">What the agent would see now</h2>
          <p className="ov-gl">A read-only test call to the real contract, made as the agent, for the honest trade from the run: buy {TRADE.units} units at {usdCents(TRADE.buyCents)} plus {usdCents(TRADE.shipCents)} shipping, sell at {usdCents(TRADE.sellCents)}. Nothing is sent. It re-checks every 10 seconds and right after you change something, so you can watch the switch take effect.</p>
          <div className={'wl-verdict ' + sim.phase} data-testid="owner-agent-sim" data-phase={sim.phase} aria-busy={sim.busy || undefined} role="status" aria-live="polite">
            <span className="wl-stamp">{sim.phase === 'ok' ? 'ACCEPTED' : sim.phase === 'refused' ? 'REFUSED' : sim.phase === 'rpc' ? 'NO ANSWER' : 'CHECKING'}</span>
            <div className="wl-verdict-t">
              {sim.phase === 'ok' && sim.res?.accepted && <p>ACCEPTED: the contract would take this trade. Net {usdCents(sim.res.net)} per unit, margin {pct(sim.res.marginBps)}, spend {usdCents(sim.res.spendCents)}.</p>}
              {sim.phase === 'refused' && sim.res && !sim.res.accepted && <><p>{sim.res.sentence}</p><span className="mono">{sim.res.error}({sim.res.args.map(String).join(', ')})</span></>}
              {sim.phase === 'rpc' && <p>The public RPC did not answer. Trying again shortly.</p>}
              {sim.phase === 'wait' && <p>Asking the contract…</p>}
              {sim.at > 0 && <span className="wl-sm muted">Checked <Ago at={sim.at} />{sim.busy ? ' (refreshing)' : ''}</span>}
            </div>
          </div>
          <button type="button" className="btn ghost wl-retry" onClick={() => void runSim()} disabled={sim.busy}>Check again now</button>
        </div>
      </section>

      {/* f. allowlists */}
      <Card id="lists" title="Allowlists" intro={<>The agent can only move escrow to a <b>payee</b> you approved, and settlement can only pull sale proceeds from a <b>payer</b> you approved. Any other address is refused, so the agent cannot pay itself.</>}>
        <ul className="wl-lists">
          <li><div><b>Supplier</b><small>Payee in the run</small><Addr a={DEPLOYMENT.supplier} label={short(DEPLOYMENT.supplier, 8, 6)} /></div><Allowed v={demoList.supplier} what="payee" /></li>
          <li><div><b>Payer</b><small>Where the sale proceeds came from</small><Addr a={DEPLOYMENT.payer} label={short(DEPLOYMENT.payer, 8, 6)} /></div><Allowed v={demoList.payer} what="payer" /></li>
        </ul>
        <Field id="wl-addr" label="Add or remove any address" value={addrIn} onChange={setAddrIn} testid="owner-payee-input" inputMode="text" placeholder="0x…" error={addrIn && !addrP.ok ? addrP.error : undefined}
          hint="Paste a wallet address, then pick which list to change." />
        {custom && addrP.ok && custom.addr === addrP.address && (
          <p className="wl-note" data-testid="owner-addr-status">That address is {custom.payee ? <b>on</b> : <b>not on</b>} the payee list and {custom.payer ? <b>on</b> : <b>not on</b>} the payer list right now.</p>
        )}
        <Need connected={connected} />
        <div className="wl-pair">
          <div className="wl-group" role="group" aria-label="Payee list: addresses escrow may be paid to">
            <span className="wl-gl">Payee <small>may receive escrow</small></span>
            <div className="wl-actions">
              <TxButton tx={pyAdd} testid="owner-payee-add" onClick={() => setList(pyAdd, 'setPayee', true, 'Add payee')} disabled={offDisable || !addrP.ok} why={offDisable ? 'Connect a wallet first' : 'Enter a valid address'} variant="ghost" describedBy={needId}>Add as payee</TxButton>
              <TxButton tx={pyRem} testid="owner-payee-remove" onClick={() => setList(pyRem, 'setPayee', false, 'Remove payee')} disabled={offDisable || !addrP.ok} why={offDisable ? 'Connect a wallet first' : 'Enter a valid address'} variant="ghost" describedBy={needId}>Remove payee</TxButton>
            </div>
            <TxStatus tx={pyAdd} /><TxStatus tx={pyRem} />
          </div>
          <div className="wl-group" role="group" aria-label="Payer list: addresses sale proceeds may be pulled from">
            <span className="wl-gl">Payer <small>may send sale proceeds</small></span>
            <div className="wl-actions">
              <TxButton tx={prAdd} testid="owner-payer-add" onClick={() => setList(prAdd, 'setPayer', true, 'Add payer')} disabled={offDisable || !addrP.ok} why={offDisable ? 'Connect a wallet first' : 'Enter a valid address'} variant="ghost" describedBy={needId}>Add as payer</TxButton>
              <TxButton tx={prRem} testid="owner-payer-remove" onClick={() => setList(prRem, 'setPayer', false, 'Remove payer')} disabled={offDisable || !addrP.ok} why={offDisable ? 'Connect a wallet first' : 'Enter a valid address'} variant="ghost" describedBy={needId}>Remove payer</TxButton>
            </div>
            <TxStatus tx={prAdd} /><TxStatus tx={prRem} />
          </div>
        </div>
      </Card>

      {/* g. test token */}
      <Card id="mint" title="Test token" intro={<>The vault is funded in <b>mUSDG</b>, a token we deployed on the testnet as a stand-in. It has no real value and is not a real stablecoin. Only the token's own owner{tokenOwner ? <> (<Addr a={tokenOwner} />)</> : null} can mint it; anyone else will be refused with the contract's own sentence.</>}>
        <Field id="wl-mint" label="Amount to mint to my wallet" prefix="$" value={mintIn} onChange={setMintIn} testid="owner-mint-input" error={mintIn && !mintP.ok ? mintP.error : undefined} hint="In test dollars. Sent to the connected account." />
        <Need connected={connected} />
        <TxButton tx={mnt} testid="owner-mint-btn" onClick={doMint} disabled={offDisable || !mintP.ok} why={offDisable ? 'Connect a wallet first' : 'Enter a valid amount'} variant="ghost" describedBy={needId}>Mint test tokens to my wallet</TxButton>
        <TxStatus tx={mnt} />
      </Card>

      {/* help: which wallet */}
      <section className="card wl-card" id="install-wallet" aria-labelledby="inst-h">
        <h2 id="inst-h" className="wl-h2">Which wallet do I need?</h2>
        <p className="ov-gl">Any browser wallet that supports custom networks, for example MetaMask, Rabby or Coinbase Wallet. Install one, reload this page, then press Connect wallet in the top bar. If you have several, you will be asked to pick one.</p>
        <ul className="wl-faq">
          <li><b>The network.</b> {CHAIN.name} (chain id {CHAIN.id}) is added to your wallet automatically the first time you press Switch, so you do not have to type any settings.</li>
          <li><b>Gas.</b> Transactions cost a little testnet ETH, which you can get from the Robinhood Chain testnet faucet. It has no real value.</li>
          <li><b>Privacy and safety.</b> This page never sees a private key. Every action shows in your wallet first, and a transaction that the contract would refuse is caught before it reaches your wallet.</li>
          <li><b>No wallet?</b> You can still read the live vault, the mandate and the kill-switch view on this page, and try the cheating simulator on the <a className="wl-a" href="/app/policies/">Mandate and guardrails</a> page.</li>
        </ul>
      </section>
    </div>
  );
}

function Allowed({ v, what }: { v: boolean | null; what: string }) {
  if (v === null) return <span className="pill">reading…</span>;
  return v ? <span className="pill good" data-testid={`owner-allow-${what}`}><span aria-hidden="true">✓ </span>Allowed as {what}</span> : <span className="pill bad" data-testid={`owner-allow-${what}`}><span aria-hidden="true">✕ </span>Not allowed as {what}</span>;
}
