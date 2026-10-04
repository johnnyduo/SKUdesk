import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getAddress, formatEther, parseEther, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { useWallet } from '../../lib/wallet-app';
import { client } from '../../lib/chain';
import { CHAIN, DEPLOYMENT, explorer, usdBase, usdCents, pct, short } from '../../lib/run';
import { AGENTS, PROOF, FACTORY_ABI, REGISTRY_ABI, ACCOUNT_ABI, FAUCET_ABI } from '../../lib/agents-abi';
import { CORE_ABI, TOKEN_ABI } from '../../lib/owner-abi';
import { DEFAULT_FORM, validateForm, readAgentURI, type AgentForm } from '../../lib/agent-form';
import { parseTokenAmount, parseDollars, parseMarginPct, parseSeconds, centsToInput, bpsToInput } from './parse';
import { useTx, TxButton, TxStatus } from './TxButton';
import { Addr, Field, Card, Need } from './ui';
import Provenance from '../ui/Provenance';
import './wallet.css';

// "Deploy your agent": one transaction creates a mandate vault, a locked ERC-4337 account and an identity NFT for the connected wallet.
// Reads come from the public RPC; every write goes through TxButton -> walletEngine.send (simulate first, never sign a doomed tx).

type Row = { index: number; vault: Hex; account: Hex; agentId: bigint; signer: Hex; createdAt: number; name: string };
type Live = { free: bigint; paused: boolean; daily: bigint; perTrade: bigint; bps: bigint; ttl: bigint; gas: bigint; allowance: bigint; supplier: boolean };

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const eth = (wei: bigint) => { const s = formatEther(wei); const [w, f = ''] = s.split('.'); return f ? `${w}.${f.slice(0, 6).replace(/0+$/, '') || '0'}` : w; };
const fmtWait = (s: number) => (s >= 3600 ? `${Math.ceil(s / 3600)} h` : s >= 60 ? `${Math.ceil(s / 60)} min` : `${s} s`);

async function loadRows(owner: string): Promise<Row[]> {
  const c = client();
  const idx = (await c.readContract({ address: AGENTS.factory, abi: FACTORY_ABI, functionName: 'agentsOf', args: [getAddress(owner)] })) as bigint[];
  return Promise.all(idx.map(async (i) => {
    const r = (await c.readContract({ address: AGENTS.factory, abi: FACTORY_ABI, functionName: 'agents', args: [i] })) as readonly [Hex, Hex, Hex, bigint, Hex, bigint];
    let name = `Agent #${r[3]}`;
    try { const uri = (await c.readContract({ address: AGENTS.registry, abi: REGISTRY_ABI, functionName: 'tokenURI', args: [r[3]] })) as string; name = readAgentURI(uri)?.name || name; } catch { /* keep the fallback */ }
    return { index: Number(i), vault: r[1], account: r[2], agentId: r[3], signer: r[4], createdAt: Number(r[5]), name };
  }));
}

async function loadLive(row: Row, owner: string): Promise<Live> {
  const c = client(); const rd = (address: Hex, abi: any, functionName: string, args: any[] = []) => c.readContract({ address, abi, functionName, args } as any) as Promise<any>;
  const [free, paused, daily, perTrade, bps, ttl, gas, allowance, supplier] = await Promise.all([
    rd(row.vault, CORE_ABI, 'free'), rd(row.vault, CORE_ABI, 'paused'), rd(row.vault, CORE_ABI, 'dailySpendCap'), rd(row.vault, CORE_ABI, 'maxExec'), rd(row.vault, CORE_ABI, 'minMarginBps'), rd(row.vault, CORE_ABI, 'quoteTTL'),
    rd(row.account, ACCOUNT_ABI, 'deposit'), rd(AGENTS.token, TOKEN_ABI, 'allowance', [getAddress(owner), row.vault]), rd(row.vault, CORE_ABI, 'payee', [getAddress(DEPLOYMENT.supplier)]),
  ]);
  return { free, paused, daily, perTrade, bps, ttl, gas, allowance, supplier };
}

const STANDARDS: [string, string, string][] = [
  ['ERC-4337 · the agent’s account', `Your agent does not use a plain wallet. It acts through its own small account, which can only talk to your vault, only call the agent functions, and cannot tip or overspend on gas. Everything goes through the shared EntryPoint v0.7 (${short(AGENTS.entryPoint, 6, 4)}).`, 'Live. See the proof run above.'],
  ['ERC-8004 · the agent’s public name', 'Creating an agent adds an entry to the shared ERC-8004 registry on this chain, with a file that lists the agent’s vault and account. ERC-8004 is still a draft, and the registry is run by someone else.', 'Live'],
  ['ERC-721 · the name tag', 'The registry entry is a token you own. You can move it, but moving it does not move the vault: the vault stays under the wallet that created it.', 'Live'],
  ['EIP-712 and ERC-1271 · signatures', 'The registry links an agent wallet only after that wallet signs for it, and the agent account can answer that check for its key. Covered by the contract tests; not part of the one-click flow.', 'Live (tested)'],
  ['EIP-1193 and EIP-6963 · your wallet', 'How this page finds and talks to your browser wallet.', 'Live'],
];

export default function CreateAgent() {
  const w = useWallet();
  const connected = w.status === 'connected' && !!w.account;
  const account = connected ? w.account! : undefined;

  // form
  const [f, setF] = useState<AgentForm>(DEFAULT_FORM);
  const set = (k: keyof AgentForm) => (v: string) => setF((o) => ({ ...o, [k]: v }));
  const [touched, setTouched] = useState(false);
  const [genKey, setGenKey] = useState<string>('');
  const [copied, setCopied] = useState(false);
  const check = useMemo(() => validateForm(f, { supplier: DEPLOYMENT.supplier, payer: DEPLOYMENT.payer, owner: account }), [f, account]);
  const errs = check.ok ? {} : check.errors;
  const shown = (k: keyof AgentForm): string | undefined => (touched || f[k] !== DEFAULT_FORM[k] ? (errs as any)[k] : undefined);
  const generate = () => { const k = generatePrivateKey(); setGenKey(k); setCopied(false); setF((o) => ({ ...o, agentAddress: privateKeyToAccount(k).address })); };
  const copyKey = async () => { try { await navigator.clipboard.writeText(genKey); setCopied(true); } catch { /* the key is also selectable on screen */ } };

  // chain state
  const [rows, setRows] = useState<Row[] | null>(null);
  const [sel, setSel] = useState<number | null>(null);
  const [live, setLive] = useState<Live | null>(null);
  const [tok, setTok] = useState<{ balance: bigint; next: number } | null>(null);
  const [loadErr, setLoadErr] = useState('');
  const row = rows?.find((r) => r.index === sel) ?? null;

  const seq = useRef(0);   // a slow answer for a previous account must never overwrite the current one
  const refresh = useCallback(async (pick?: 'newest') => {
    const my = ++seq.current;
    if (!account) { setRows(null); setLive(null); setTok(null); return; }
    try {
      const c = client();
      const [r, balance, next] = await Promise.all([
        loadRows(account),
        c.readContract({ address: AGENTS.token, abi: TOKEN_ABI, functionName: 'balanceOf', args: [getAddress(account)] }) as Promise<bigint>,
        c.readContract({ address: AGENTS.faucet, abi: FAUCET_ABI, functionName: 'nextDripAt', args: [getAddress(account)] }) as Promise<bigint>,
      ]);
      if (my !== seq.current) return;
      setRows(r); setTok({ balance, next: Number(next) }); setLoadErr('');
      setSel((cur) => (pick === 'newest' ? (r.length ? r[r.length - 1].index : null) : cur !== null && r.some((x) => x.index === cur) ? cur : r.length ? r[r.length - 1].index : null));
    } catch { if (my === seq.current) setLoadErr('Could not read the chain just now. Retrying.'); }
  }, [account]);
  useEffect(() => { void refresh(); const t = setInterval(() => void refresh(), 20_000); return () => clearInterval(t); }, [refresh]);
  useEffect(() => { setLive(null); }, [row?.vault]);   // never show or act on the previous agent's numbers
  useEffect(() => {
    let live = true;
    if (!row || !account) { setLive(null); return; }
    loadLive(row, account).then((l) => live && setLive(l)).catch(() => undefined);
    return () => { live = false; };
  }, [row, account, rows]);
  const after = useCallback(async (pick?: 'newest') => { await refresh(pick); await wait(2500); await refresh(pick); }, [refresh]);

  // actions
  const faucet = useTx('faucet', () => void after());
  const create = useTx('create', () => void after('newest'));
  const fund = useTx('fund', () => void after());
  const gas = useTx('gas', () => void after());
  const pause = useTx('pause', () => void after());
  const limits = useTx('limits', () => void after());

  const dripWait = tok ? Math.max(0, tok.next - Math.floor(Date.now() / 1000)) : 0;
  const doDrip = () => void faucet.run(async (send) => { await send('Get test money', { address: AGENTS.faucet, abi: FAUCET_ABI, functionName: 'drip' }); });
  const doCreate = () => {
    setTouched(true); if (!check.ok) return; const p = check.params;
    void create.run(async (send) => { await send('Create agent', { address: AGENTS.factory, abi: FACTORY_ABI, functionName: 'createAgent', args: [p] }); });
  };

  const [fundAmt, setFundAmt] = useState('1000'); const fundP = parseTokenAmount(fundAmt);
  const doFund = () => {
    if (!fundP.ok || !row) return; const amount = fundP.base; const vault = row.vault; const need = !live || live.allowance < amount;
    void fund.run(async (send) => {
      if (need) await send(`Step 1 of 2: let the vault take ${usdBase(amount)}`, { address: AGENTS.token, abi: TOKEN_ABI, functionName: 'approve', args: [vault, amount] }, 'approve');
      await send(need ? 'Step 2 of 2: put the money in the vault' : 'Fund the vault', { address: vault, abi: CORE_ABI, functionName: 'deposit', args: [amount] });
    });
  };
  const [gasAmt, setGasAmt] = useState('0.0005');
  const gasWei = (() => { try { const v = parseEther(gasAmt.trim()); return v > 0n ? v : null; } catch { return null; } })();
  const doGas = () => { if (!row || gasWei === null) return; const a = row.account; void gas.run(async (send) => { await send('Add gas money', { address: a, abi: ACCOUNT_ABI, functionName: 'addDeposit', value: gasWei }); }); };
  const doPause = () => { if (!row || !live) return; const v = row.vault; const p = !live.paused; void pause.run(async (send) => { await send(p ? 'Pause the agent' : 'Resume the agent', { address: v, abi: CORE_ABI, functionName: 'pause', args: [p] }); }); };

  const [lim, setLim] = useState({ daily: '', per: '', margin: '', ttl: '' });
  useEffect(() => { if (live) setLim({ daily: centsToInput(live.daily), per: centsToInput(live.perTrade), margin: bpsToInput(live.bps), ttl: String(live.ttl) }); }, [row?.vault, live?.daily, live?.perTrade, live?.bps, live?.ttl]);
  const limP = { d: parseDollars(lim.daily), m: parseDollars(lim.per), b: parseMarginPct(lim.margin), t: parseSeconds(lim.ttl) };
  const limOk = limP.d.ok && limP.m.ok && limP.b.ok && limP.t.ok && (limP.m as any).cents <= (limP.d as any).cents;
  const limChanged = !!live && limOk && (BigInt((limP.d as any).cents) !== live.daily || BigInt((limP.m as any).cents) !== live.perTrade || BigInt((limP.b as any).bps) !== live.bps || BigInt((limP.t as any).seconds) !== live.ttl);
  const doLimits = () => {
    if (!row || !limOk) return; const v = row.vault; const a = [BigInt((limP.d as any).cents), BigInt((limP.m as any).cents), BigInt((limP.b as any).bps), BigInt((limP.t as any).seconds)];
    void limits.run(async (send) => { await send('Save limits', { address: v, abi: CORE_ABI, functionName: 'setPolicy', args: a }); });
  };

  const needBalance = fundP.ok && tok ? fundP.base > tok.balance : false;

  return (
    <div className="wl-console" data-testid="create-agent">
      <Card id="ca-start" title="Before you start" intro="You need three things. Everything here runs on a test network with test money that has no real value.">
        <ol className="wl-faq" data-testid="create-prereqs">
          <li><b>A browser wallet</b> such as MetaMask, Rabby or Coinbase Wallet. <span className="muted">No wallet? Skip to <a className="wl-a" href="/app/">the Desk</a>: it reads the same chain without one.</span></li>
          <li><b>The test network.</b> Connecting adds {CHAIN.name} to your wallet for you. If you prefer to add it by hand: chain id <span className="mono">{CHAIN.id}</span>, RPC <span className="mono">{CHAIN.rpc}</span>, currency <span className="mono">ETH</span>, explorer <span className="mono">{CHAIN.explorer}</span>.</li>
          <li><b>A little test ETH for gas.</b> Get it free at the <a className="wl-a" href="https://faucet.testnet.chain.robinhood.com" target="_blank" rel="noopener noreferrer">Robinhood Chain testnet faucet ↗<span className="sr-only"> (opens in a new tab)</span></a>. Creating an agent costs a tiny amount.</li>
        </ol>
      </Card>

      <Card id="ca-money" title="1. Get test money" intro="Your agent trades with test dollars (mUSDG) that have no real value. The faucet gives each wallet 1,000 once a day.">
        <Need connected={connected} />
        <div className="wl-actions" style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--s3)', alignItems: 'center' }}>
          <TxButton tx={faucet} testid="faucet-drip" onClick={doDrip} disabled={!connected || dripWait > 0} why={dripWait > 0 ? `Available again in ${fmtWait(dripWait)}` : 'Connect a wallet first'} busyLabel="Getting…">Get 1,000 test mUSDG</TxButton>
          <span data-testid="token-balance" className="mono">{tok ? `You hold ${usdBase(tok.balance)}` : connected ? 'Reading your balance…' : ''}</span>
          {dripWait > 0 && <span className="wl-hint">Next drip in {fmtWait(dripWait)}.</span>}
        </div>
        {!connected && <p className="wl-hint" data-testid="why-faucet">Disabled until you connect a wallet (top bar).</p>}
        <TxStatus tx={faucet} />
      </Card>

      <Card id="ca-form" title="2. Set the budget and create your agent" intro="One transaction builds three things for you: a vault that holds the agent's money under your rules, a locked account the agent works through, and an identity token that names it. You own all three.">
        <div className="wl-mfields" style={{ display: 'grid', gridTemplateColumns: 'repeat(2,minmax(0,1fr))', gap: 'var(--s4)' }}>
          <Field id="ca-name" testid="create-name" label="Agent name" value={f.name} onChange={set('name')} inputMode="text" error={shown('name')} hint="Shown in the identity token." />
          <Field id="ca-daily" testid="create-daily" label="Daily budget" prefix="$" value={f.daily} onChange={set('daily')} error={shown('daily')} hint="The most it may commit per day." />
          <Field id="ca-per" testid="create-pertrade" label="Per-trade cap" prefix="$" value={f.perTrade} onChange={set('perTrade')} error={shown('perTrade')} hint="Spend per trade is derived by the contract, not claimed by the agent." />
          <Field id="ca-margin" testid="create-margin" label="Smallest profit margin" suffix="%" value={f.margin} onChange={set('margin')} error={shown('margin')} hint="Trades thinner than this are refused. 1% to 90%." />
          <Field id="ca-ttl" testid="create-ttl" label="Quote freshness" suffix="sec" inputMode="numeric" value={f.ttl} onChange={set('ttl')} error={shown('ttl')} hint="A price older than this is refused." />
          <Field id="ca-desc" testid="create-desc" label="Description" value={f.description} onChange={set('description')} inputMode="text" error={shown('description')} hint="Optional. Stored in the identity token." />
        </div>

        <div className="wl-group" style={{ marginTop: 'var(--s4)' }}>
          <Field id="ca-key" testid="create-agent-address" label="Agent key address" inputMode="text" placeholder="0x…" value={f.agentAddress} onChange={set('agentAddress')} error={shown('agentAddress')}
            hint="The address of the key your agent software signs with. Paste one you hold, or generate a new key here." />
          <div className="wl-actions" style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--s3)', alignItems: 'center' }}>
            <button type="button" className="btn ghost" data-testid="create-genkey" onClick={generate}>Generate a new key</button>
          </div>
          {genKey && (
            <div className="wl-note warn" data-testid="create-keybox" role="status">
              <b>Save this key now.</b> It was made in your browser, is shown only here, and is stored nowhere. Put it in your agent's settings as the signing key. It can only act inside the limits above.
              <div className="mono" style={{ overflowWrap: 'anywhere', margin: 'var(--s2) 0', userSelect: 'all' }} data-testid="create-key-value">{genKey}</div>
              <button type="button" className="btn ghost" onClick={copyKey}>{copied ? 'Copied' : 'Copy key'}</button>
            </div>
          )}
        </div>

        <fieldset className="wl-group" style={{ border: 0, padding: 0, margin: 'var(--s4) 0 0' }}>
          <legend className="wl-gl">Who may the vault pay and be paid by?</legend>
          <label className="ca-check"><input type="checkbox" data-testid="create-allow-supplier" checked={f.allowSupplier} onChange={(e) => setF((o) => ({ ...o, allowSupplier: e.target.checked }))} /><span>Allow the test supplier <Addr a={DEPLOYMENT.supplier} label={short(DEPLOYMENT.supplier, 6, 4)} />. The agent can release escrow only to allowed suppliers.</span></label>
          <label className="ca-check"><input type="checkbox" data-testid="create-allow-payer" checked={f.allowPayer} onChange={(e) => setF((o) => ({ ...o, allowPayer: e.target.checked }))} /><span>Allow the test buyer <Addr a={DEPLOYMENT.payer} label={short(DEPLOYMENT.payer, 6, 4)} />. Sale proceeds can only be pulled from allowed buyers.</span></label>
          <span className="wl-hint">In this version the two allow-lists are set here, once. The limits can be changed later.</span>
        </fieldset>

        {check.ok && (
          <p className="wl-note" data-testid="create-summary" style={{ marginTop: 'var(--s4)' }}>
            In plain words: this agent can commit at most <b>{usdCents(check.summary.dailyCents)}</b> a day, never more than <b>{usdCents(check.summary.perTradeCents)}</b> in one trade, and only on trades that keep a margin of at least <b>{pct(check.summary.marginBps)}</b>. You can pause it any time.
          </p>
        )}
        <div className="wl-actions" style={{ marginTop: 'var(--s4)' }}>
          <TxButton tx={create} testid="create-submit" big onClick={doCreate} disabled={!connected} why="Connect a wallet first" busyLabel="Creating your agent…">Create my agent</TxButton>
        </div>
        {!connected && <p className="wl-hint" data-testid="why-create">Disabled until you connect a wallet (top bar). Nothing is sent until you press the button.</p>}
        {connected && touched && !check.ok && <p className="wl-hint" role="alert" data-testid="why-create-form">Not sent yet: fix the highlighted fields above.</p>}
        <TxStatus tx={create} />
        <p className="wl-note" data-testid="create-status-note" style={{ marginTop: 'var(--s4)' }}>
          <b>What you get:</b> one transaction creates a vault, a locked smart account and an identity token, all owned by your wallet. The vault starts empty. <b>What it does not do yet:</b> it does not start trading or searching on its own. No agent software is attached to the account, and the proof run below was driven by a script (<span className="mono">tools/agent-4337.ts</span>), not by a running agent.
        </p>
      </Card>

      <Card id="ca-mine" title="3. Your agents" intro={<>Read from the chain every 20 seconds <Provenance kind="onchain" />. Pick an agent to fund and control it.</>}>
        {loadErr && <p className="wl-note warn">{loadErr}</p>}
        {!connected && <p className="wl-need">Connect a wallet to see your agents.</p>}
        {connected && rows && rows.length === 0 && <p className="wl-need" data-testid="agents-empty">You have no agents yet. Create one above.</p>}
        {rows && rows.length > 0 && (
          <ul className="wl-lists" data-testid="agent-list">
            {rows.map((r) => (
              <li key={r.index}>
                <div><b>{r.name}</b><small>Identity #{String(r.agentId)} · created {new Date(r.createdAt * 1000).toLocaleString()}</small></div>
                <button type="button" className={'btn' + (r.index === sel ? '' : ' ghost')} data-testid="agent-pick" aria-pressed={r.index === sel} onClick={() => setSel(r.index)}>{r.index === sel ? 'Selected' : 'Select'}</button>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {row && (
        <Card id="ca-ctl" title={`4. Fund and control “${row.name}”`} intro="Put test money in the vault, add a little ETH for gas, and use the kill switch if you ever need it.">
          <dl className="ov-kv wl-kv ca-kv" data-testid="agent-facts">
            <div><dt>Vault<small>Holds the money and enforces your limits</small></dt><dd><Addr a={row.vault} /></dd></div>
            <div><dt>Agent account<small>The only caller the vault accepts (ERC-4337)</small></dt><dd><Addr a={row.account} /></dd></div>
            <div><dt>Agent key<small>Signs for the account</small></dt><dd><Addr a={row.signer} /></dd></div>
            <div><dt>Identity token<small>ERC-721 in the registry</small></dt><dd><Addr a={AGENTS.registry} label={`#${String(row.agentId)} in ${short(AGENTS.registry, 6, 4)}`} /></dd></div>
            <div><dt>Vault balance<small>Free money the agent may use</small></dt><dd data-testid="agent-free">{live ? usdBase(live.free) : '…'}</dd></div>
            <div><dt>Gas money<small>ETH the account can spend on gas</small></dt><dd data-testid="agent-gas">{live ? `${eth(live.gas)} ETH` : '…'}</dd></div>
            <div><dt>Limits<small>Set when you created it</small></dt><dd>{live ? `${usdCents(live.daily)}/day · ${usdCents(live.perTrade)}/trade · margin ≥ ${pct(Number(live.bps))} · quote ≤ ${String(live.ttl)}s` : '…'}</dd></div>
            <div><dt>Status</dt><dd data-testid="agent-status">{live ? (live.paused ? 'PAUSED' : 'RUNNING') : '…'}</dd></div>
          </dl>

          <div className="wl-pair" style={{ marginTop: 'var(--s4)' }}>
            <div className="wl-group">
              <Field id="ca-fund" testid="fund-amount" label="Put money in the vault" prefix="$" value={fundAmt} onChange={setFundAmt} error={fundP.ok ? (needBalance ? 'You hold less than this. Get test money first.' : undefined) : fundP.error} />
              <TxButton tx={fund} testid="fund-submit" onClick={doFund} disabled={!fundP.ok || needBalance} why="Enter an amount you hold" busyLabel="Funding…">Fund the vault</TxButton>
              <TxStatus tx={fund} />
            </div>
            <div className="wl-group">
              <Field id="ca-gas" testid="gas-amount" label="Add gas money (ETH)" suffix="ETH" value={gasAmt} onChange={setGasAmt} error={gasWei === null ? 'Enter an amount of ETH, for example 0.0005.' : undefined} hint="Needs a little test ETH in your wallet. Unused gas money can be taken back." />
              <TxButton tx={gas} testid="gas-submit" onClick={doGas} disabled={gasWei === null} why="Enter an amount of ETH" busyLabel="Adding…">Add gas money</TxButton>
              <TxStatus tx={gas} />
            </div>
          </div>
          <div className="wl-group" style={{ marginTop: 'var(--s4)' }}>
            <h3 className="wl-gl">Change the limits</h3>
            <div className="wl-mfields" style={{ display: 'grid', gridTemplateColumns: 'repeat(2,minmax(0,1fr))', gap: 'var(--s4)' }}>
              <Field id="ca-l-daily" testid="limit-daily" label="Daily budget" prefix="$" value={lim.daily} onChange={(v) => setLim((o) => ({ ...o, daily: v }))} error={lim.daily !== '' && !limP.d.ok ? limP.d.error : undefined} />
              <Field id="ca-l-per" testid="limit-pertrade" label="Per-trade cap" prefix="$" value={lim.per} onChange={(v) => setLim((o) => ({ ...o, per: v }))} error={!limP.m.ok ? limP.m.error : limP.d.ok && (limP.m as any).cents > (limP.d as any).cents ? 'One trade cannot be bigger than the daily budget.' : undefined} />
              <Field id="ca-l-margin" testid="limit-margin" label="Smallest profit margin" suffix="%" value={lim.margin} onChange={(v) => setLim((o) => ({ ...o, margin: v }))} error={!limP.b.ok ? limP.b.error : undefined} />
              <Field id="ca-l-ttl" testid="limit-ttl" label="Quote freshness" suffix="sec" inputMode="numeric" value={lim.ttl} onChange={(v) => setLim((o) => ({ ...o, ttl: v }))} error={!limP.t.ok ? limP.t.error : undefined} />
            </div>
            <TxButton tx={limits} testid="limit-save" onClick={doLimits} disabled={!limChanged} why="Change a value first" busyLabel="Saving…">Save limits</TxButton>
            <TxStatus tx={limits} />
          </div>
          <div className="wl-group" style={{ marginTop: 'var(--s4)' }}>
            <TxButton tx={pause} testid="agent-pause" variant={live?.paused ? 'primary' : 'danger'} onClick={doPause} disabled={!live} why="Reading the vault" busyLabel="Working…">{live?.paused ? 'Resume the agent' : 'Pause the agent (kill switch)'}</TxButton>
            <TxStatus tx={pause} />
            <p className="wl-need">To act, agent software has to sign with this key and send its actions through the account. None is attached here. The proof run below shows that path, step by step. (The <a className="wl-a" href="/app/owner/">Owner console</a> page controls the original SKUdesk vault, not this one.)</p>
          </div>
        </Card>
      )}

      <Card id="ca-proof" title="Proof run on the chain" intro={<>{`Run on ${PROOF.chainId === 46630 ? 'Robinhood Chain Testnet' : 'a local chain'} by tools/agent-4337.ts. A fresh agent was created, then its key signed these UserOperations and the canonical EntryPoint ran them.`} Values are saved from that run; the hashes open on the explorer. <Provenance kind="onchain" note="saved from the run" /></>}>
        <dl className="ov-kv wl-kv ca-kv">
          <div><dt>Agent created in one transaction</dt><dd><a className="wl-a mono" href={explorer.tx(PROOF.createTx)} target="_blank" rel="noopener noreferrer">{short(PROOF.createTx, 8, 6)} ↗</a> <small className="wl-sm">({Number(PROOF.createGas).toLocaleString()} gas)</small></dd></div>
          <div><dt>Vault</dt><dd><Addr a={PROOF.vault} /></dd></div>
          <div><dt>Agent account</dt><dd><Addr a={PROOF.account} /></dd></div>
          <div><dt>Identity token</dt><dd className="mono">#{PROOF.agentId} in <Addr a={PROOF.registry} /></dd></div>
        </dl>
        <h3 className="wl-gl" style={{ marginTop: 'var(--s4)' }}>Sent through the account (included on chain)</h3>
        <div className="table-wrap" tabIndex={0} role="region" aria-label="Operations sent through the account, scrollable"><table className="wl-diff" data-testid="proof-ops">
          <thead><tr><th>What the agent tried</th><th>Result</th><th>Transaction</th></tr></thead>
          <tbody>{PROOF.ops.map((o) => (
            <tr key={o.tx}><th scope="row">{o.label}</th>
              <td>{o.executed ? <b>Executed. Spend {usdCents(o.spendCents ?? 0)} derived by the vault.</b> : <>Refused by the vault: <span className="mono">{o.error}({o.args})</span></>}</td>
              <td>{o.tx && <a className="wl-a mono" href={explorer.tx(o.tx)} target="_blank" rel="noopener noreferrer">{short(o.tx, 6, 4)} ↗</a>}</td></tr>
          ))}</tbody>
        </table></div>
        <h3 className="wl-gl" style={{ marginTop: 'var(--s4)' }}>Refused by the account before anything ran</h3>
        <p className="ov-gl">These were checked with an eth_call to the EntryPoint, which is what a bundler does before it includes a UserOperation. Nothing was sent, and the vault was found unchanged afterwards.</p>
        <div className="table-wrap" tabIndex={0} role="region" aria-label="Attempts refused before they ran, scrollable"><table className="wl-diff" data-testid="proof-attacks">
          <thead><tr><th>Attempt</th><th>Refused with</th></tr></thead>
          <tbody>{PROOF.attacks.map((a) => (<tr key={a.label}><th scope="row">{a.label}</th><td className="mono">{a.code} {a.error}{a.args ? `(${a.args})` : ''}</td></tr>))}</tbody>
        </table></div>
      </Card>

      <Card id="ca-eips" title="Standards behind your agent" intro="What each standard does for your agent. Everything in this table is running.">
        <div className="table-wrap" tabIndex={0} role="region" aria-label="Standards used, scrollable"><table className="wl-diff" data-testid="standards">
          <thead><tr><th>Standard</th><th>What it does for your agent</th><th>Status</th></tr></thead>
          <tbody>{STANDARDS.map(([n, d, s]) => (<tr key={n}><th scope="row">{n}</th><td>{d}</td><td><b style={{ color: 'var(--green)' }}>{s}</b></td></tr>))}</tbody>
        </table></div>
        <p className="wl-need">Not used, on purpose: modular accounts (ERC-7579, ERC-6900), wallet permissions (ERC-7715) and paymasters, because the account is small and fixed and you pay gas with a little ETH inside it. The ERC-8004 reputation and validation registries are not used yet.</p>
        <p className="wl-need">Contracts: <Addr a={AGENTS.factory} label={`Factory ${short(AGENTS.factory, 6, 4)}`} /> · <Addr a={AGENTS.faucet} label={`Faucet ${short(AGENTS.faucet, 6, 4)}`} />. Both are source-verified on the explorer. Identity registry (not ours, source not verified): <Addr a={AGENTS.registry} label={short(AGENTS.registry, 6, 4)} />.</p>
      </Card>
    </div>
  );
}
