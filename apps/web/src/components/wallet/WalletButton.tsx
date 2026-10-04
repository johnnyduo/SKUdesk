import { useEffect, useId, useRef, useState } from 'react';
import { useWallet, useRole, walletEngine } from '../../lib/wallet-app';
import { CHAIN, short } from '../../lib/run';
import { describeError } from './TxButton';
import './wallet.css';

// Top-bar wallet control. Never prompts on load: connecting only happens on a click, and the silent restore in
// useWallet() uses eth_accounts (no popup). All wallet logic lives in lib/wallet.ts; this is presentation.

const HELP_HREF = '/app/owner/#install-wallet';
const ROLE_NOTE = { owner: 'You are connected as the vault owner.', agent: 'You are connected as the AI agent wallet.', visitor: 'You are connected as a visitor wallet.' } as const;
const safeIcon = (s?: string) => (s && s.startsWith('data:image/') ? s : '');

export default function WalletButton() {
  const w = useWallet();
  const { role } = useRole(w.account);
  const [open, setOpen] = useState(false);
  const [dismissed, setDismissed] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [switchErr, setSwitchErr] = useState<string | undefined>();
  const [settled, setSettled] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const panelId = useId();

  // wallets announce asynchronously; wait for the legacy fallback window before claiming none exist
  useEffect(() => { const t = setTimeout(() => setSettled(true), 700); return () => clearTimeout(t); }, []);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { setOpen(false); btn.current?.focus(); } };
    document.addEventListener('mousedown', onDoc); document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey); };
  }, [open]);
  useEffect(() => { if (w.status === 'connected') setOpen(false); }, [w.status]);
  useEffect(() => { if (w.onTargetChain) setSwitchErr(undefined); }, [w.onTargetChain]);
  useEffect(() => { if (open) box.current?.querySelector<HTMLElement>('[data-testid="wallet-chooser-item"], .wl-help a')?.focus(); }, [open]);

  const connect = async (rdns?: string) => {
    setDismissed(undefined);
    try { await walletEngine.connect(rdns); } catch { /* state.error carries the sentence */ }
  };
  const onConnectClick = () => {
    if (w.wallets.length === 0) { setOpen((o) => !o); return; }      // nothing to pick: explain what to install
    if (w.wallets.length === 1) { void connect(w.wallets[0].rdns); return; }
    setOpen((o) => !o);                                              // several wallets: let the user choose
  };
  const doSwitch = async () => {
    setBusy(true); setSwitchErr(undefined);
    try { await walletEngine.switchToTargetChain(); } catch (e) { setSwitchErr(describeError(e).message); } finally { setBusy(false); }
  };

  const connected = w.status === 'connected' && !!w.account;
  const err = w.status === 'error' && w.error && w.error !== dismissed ? w.error : undefined;
  const announce = connected ? `Wallet connected: ${w.account}${role ? ', role ' + role : ''}${w.onTargetChain ? ', on ' + CHAIN.name : ', wrong network'}` : w.status === 'connecting' ? 'Connecting. Approve the request in your wallet.' : err ?? '';

  return (
    <div className="wl" ref={box}>
      <span className="sr-only" role="status" aria-live="polite">{announce}</span>

      {!connected && (
        <>
          <button ref={btn} type="button" className="btn ghost wl-btn" data-testid="wallet-connect-btn" onClick={onConnectClick}
            aria-busy={w.status === 'connecting' || w.restoring || undefined}
            aria-expanded={w.wallets.length === 1 ? undefined : open} aria-controls={w.wallets.length === 1 ? undefined : panelId}>
            {w.status === 'connecting' ? <><i className="wl-spin" aria-hidden="true" />Connecting…</> : w.restoring ? <><i className="wl-spin" aria-hidden="true" />Reconnecting…</> : <><WalletIcon />Connect wallet</>}
          </button>
          {open && (
            <div className="wl-pop" id={panelId}>
              {w.wallets.length > 1 ? (
                <>
                  <p className="wl-pop-h" id={panelId + '-h'}>Choose a wallet</p>
                  <ul className="wl-list" aria-labelledby={panelId + '-h'}>
                    {w.wallets.map((x) => (
                      <li key={x.uuid}>
                        <button type="button" className="wl-item" data-testid="wallet-chooser-item" data-rdns={x.rdns} onClick={() => void connect(x.rdns)}>
                          {safeIcon(x.icon) ? <img src={safeIcon(x.icon)} alt="" width="24" height="24" /> : <span className="wl-ico-fb" aria-hidden="true"><WalletIcon /></span>}
                          <span>{x.name}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </>
              ) : (
                <div className="wl-help">
                  <p className="wl-pop-h">{settled ? 'No browser wallet found' : 'Looking for a wallet…'}</p>
                  <p>Install a browser wallet such as MetaMask, Rabby or Coinbase Wallet, then reload this page and press Connect wallet again. {CHAIN.name} is added to your wallet for you, if it is missing.</p>
                  <a className="wl-link" href={HELP_HREF}>What to install and why</a>
                </div>
              )}
            </div>
          )}
        </>
      )}

      {connected && (
        <div className={'wl-conn' + (w.onTargetChain ? '' : ' is-wrong')}>
          {w.onTargetChain ? (
            <span className="wl-net" title={`${CHAIN.name} (chain id ${CHAIN.id})`}><i className="wl-dot ok" aria-hidden="true" /><span className="wl-net-t">{CHAIN.name.replace(' Testnet', '')}</span><span className="sr-only">{CHAIN.name}</span></span>
          ) : (
            <button type="button" className="btn wl-btn wl-switch" data-testid="wallet-switch-btn" onClick={doSwitch} disabled={busy} aria-busy={busy || undefined} aria-label={`Switch to ${CHAIN.name}`}>
              {busy ? <><i className="wl-spin" aria-hidden="true" />Switching…</> : <><span className="wl-long">Switch to {CHAIN.name}</span><span className="wl-short" aria-hidden="true">Switch network</span></>}
            </button>
          )}
          <span className="wl-id" title={w.wallet?.name ? `${w.wallet.name}` : undefined}>
            {role ? <span className={'wl-role r-' + role} data-testid="wallet-role" title={ROLE_NOTE[role]}>{role}</span> : <span className="wl-role r-wait" aria-label="Checking role">…</span>}
            <span className="wl-addr mono" data-testid="wallet-address" title={w.account}>{short(w.account!, 4, 4)}</span>
          </span>
          <button type="button" className="btn ghost wl-x" data-testid="wallet-disconnect" onClick={() => walletEngine.disconnect()} aria-label="Disconnect wallet" title="Disconnect wallet">
            <span className="wl-x-t">Disconnect</span><span className="wl-x-i" aria-hidden="true">×</span>
          </button>
        </div>
      )}

      {connected && !w.onTargetChain && (
        <div className="wl-pop wl-warn" data-testid="wallet-network-warning" role="alert">
          <p className="wl-pop-h">Wrong network</p>
          <p>Your wallet is on {w.chainId ? `chain ${w.chainId}` : 'another network'}, not {CHAIN.name} (chain id {CHAIN.id}). Press the button to switch. If your wallet does not know this network yet, it is added automatically and you only have to approve it.</p>
          {switchErr && <p className="wl-pop-err">{switchErr}</p>}
        </div>
      )}

      {err && !connected && (
        <div className="wl-pop wl-err" role="alert">
          <p>{err}</p>
          <div className="wl-pop-row">
            {/No browser wallet/i.test(err) && <a className="wl-link" href={HELP_HREF}>What to install</a>}
            <button type="button" className="wl-dismiss" onClick={() => setDismissed(w.error)}>Dismiss</button>
          </div>
        </div>
      )}
    </div>
  );
}

function WalletIcon() {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h13v4" /><path d="M3 7v10a2 2 0 0 0 2 2h14a1 1 0 0 0 1-1v-9a1 1 0 0 0-1-1H5a2 2 0 0 1-2-2" /><circle cx="16.5" cy="13.5" r="1" fill="currentColor" /></svg>;
}
