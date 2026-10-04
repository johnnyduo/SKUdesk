import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { WalletError, type TxResult, type TxSpec, type TxStep } from '../../lib/wallet.ts';
import { walletEngine } from '../../lib/wallet-app';
import { explorer, short } from '../../lib/run';
import './wallet.css';

// One shared write-action component for the whole Owner console. Every write goes through walletEngine.send
// (simulate, sign, wait); nothing here touches a wallet or viem directly, and nothing runs until the user clicks.

export type TxState = 'idle' | 'switching' | 'simulating' | 'signing' | 'pending' | 'confirmed' | 'error' | 'rejected';
export type TxFlavour = 'contract' | 'network' | 'declined' | '';
export type TxLink = { label: string; hash: string; key: string };
export type TxView = { state: TxState; flavour: TxFlavour; message: string; links: TxLink[]; step?: string };
export type SendFn = (label: string, spec: Omit<TxSpec, 'onStep'>, key?: string) => Promise<TxResult>;

const BUSY: TxState[] = ['switching', 'simulating', 'signing', 'pending'];
export const isBusy = (s: TxState) => BUSY.includes(s);

const STEP_TEXT: Record<TxStep, string> = {
  switching: 'Switching network in your wallet…',
  simulating: 'Checking with the contract first. Nothing is sent yet…',
  signing: 'Confirm in your wallet…',
  pending: 'Sent. Waiting for the network to confirm…',
  confirmed: 'Confirmed.',
};

/** Maps a thrown WalletError to the three visual flavours: declined (neutral), contract refusal (red), network (amber). */
export function describeError(e: unknown): { state: 'error' | 'rejected'; flavour: TxFlavour; message: string } {
  if (e instanceof WalletError) {
    if (e.kind === 'rejected') return { state: 'rejected', flavour: 'declined', message: e.message.replace(/^You declined the request in your wallet\.?$/, 'You declined the request in your wallet. Nothing was sent.') };
    if (e.kind === 'simulation') return { state: 'error', flavour: 'contract', message: e.message };
    if (e.kind === 'reverted') return { state: 'error', flavour: 'contract', message: 'The transaction was mined but the contract reverted it. Check the explorer for details.' };
    if (e.kind === 'not-connected' || e.kind === 'no-wallet') return { state: 'error', flavour: 'network', message: e.message };
    return { state: 'error', flavour: 'network', message: e.message };
  }
  return { state: 'error', flavour: 'network', message: (e as any)?.shortMessage || (e as any)?.message || 'Something went wrong. Nothing was sent.' };
}

/**
 * useTx(action, onConfirmed) -> { view, run }.
 * run(job) calls job(send): `send` wraps walletEngine.send, tracks the step, and records each confirmed tx link.
 * A job may call send several times (approve, then deposit); the last link is the action's main link.
 */
export function useTx(action: string, onConfirmed?: () => void) {
  const [view, setView] = useState<TxView>({ state: 'idle', flavour: '', message: '', links: [] });
  const done = useRef(onConfirmed); done.current = onConfirmed;
  const alive = useRef(true);
  const running = useRef(false);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const put = useCallback((v: Partial<TxView> | ((o: TxView) => Partial<TxView>)) => { if (alive.current) setView((o) => ({ ...o, ...(typeof v === 'function' ? v(o) : v) })); }, []);

  const run = useCallback(async (job: (send: SendFn) => Promise<void>) => {
    if (running.current) return; running.current = true;
    put({ state: 'simulating', flavour: '', message: '', links: [], step: undefined });
    const send: SendFn = async (label, spec, key) => {
      put({ step: label });
      const r = await walletEngine.send({ ...spec, onStep: (s) => { if (s !== 'confirmed') put({ state: s as TxState, flavour: '', message: STEP_TEXT[s] }); } });
      put((o) => ({ links: [...o.links, { label, hash: r.hash, key: key ?? 'main' }] }));
      return r;
    };
    try {
      await job(send);
      put({ state: 'confirmed', flavour: '', message: 'Confirmed on chain.', step: undefined });
      try { done.current?.(); } catch { /* refresh errors never undo a confirmed tx */ }
    } catch (e) {
      const d = describeError(e); put({ state: d.state, flavour: d.flavour, message: d.message, step: undefined });
    } finally { running.current = false; }
  }, [put]);
  const reset = useCallback(() => put({ state: 'idle', flavour: '', message: '', links: [], step: undefined }), [put]);
  return { view, run, reset, action, busy: isBusy(view.state) };
}
export type Tx = ReturnType<typeof useTx>;

const ICON: Record<string, string> = { confirmed: '✓', error: '!', rejected: '–' };

/** The status line under every write action. Always in the DOM (the e2e test reads data-state), empty and collapsed while idle. */
export function TxStatus({ tx }: { tx: Tx }) {
  const { view, action } = tx;
  const main = view.links.find((l) => l.key === 'main');
  const extra = view.links.filter((l) => l.key !== 'main');
  const cls = ['wl-tx', 'is-' + view.state, view.flavour && 'f-' + view.flavour].filter(Boolean).join(' ');
  return (
    <div className={cls} data-testid={`tx-status-${action}`} data-state={view.state} data-kind={view.flavour || undefined} role="status" aria-live="polite" aria-atomic="true">
      {view.state !== 'idle' && (
        <>
          <span className="wl-tx-ic" aria-hidden="true">{isBusy(view.state) ? <i className="wl-spin" /> : ICON[view.state]}</span>
          <div className="wl-tx-b">
            {view.step && isBusy(view.state) && <b className="wl-tx-step">{view.step}</b>}
            {view.state === 'error' && view.flavour === 'contract' && <b className="wl-tx-step">The contract refused this</b>}
            {view.state === 'error' && view.flavour === 'network' && <b className="wl-tx-step">Network or wallet problem</b>}
            {view.state === 'rejected' && <b className="wl-tx-step">Declined</b>}
            <span>{view.message}</span>
            {(extra.length > 0 || main) && (
              <span className="wl-tx-links">
                {extra.map((l) => explorer.tx(l.hash) && <a key={l.hash} data-testid={`tx-link-${action}-${l.key}`} href={explorer.tx(l.hash)} target="_blank" rel="noopener noreferrer">{l.label}: <span className="mono">{short(l.hash, 6, 4)}</span> ↗<span className="sr-only"> (opens the block explorer in a new tab)</span></a>)}
                {view.state === 'confirmed' && main && explorer.tx(main.hash) && <a data-testid={`tx-link-${action}`} href={explorer.tx(main.hash)} target="_blank" rel="noopener noreferrer">{main.label}: <span className="mono">{short(main.hash, 6, 4)}</span> ↗<span className="sr-only"> (opens the block explorer in a new tab)</span></a>}
              </span>
            )}
          </div>
        </>
      )}
    </div>
  );
}

type BtnProps = { tx: Tx; testid: string; onClick: () => void; children: ReactNode; busyLabel?: string; disabled?: boolean; why?: string; variant?: 'primary' | 'ghost' | 'danger'; big?: boolean; describedBy?: string };
/** The action button: disabled while its own transaction is in flight, or when `why` explains a missing precondition. */
export function TxButton({ tx, testid, onClick, children, busyLabel = 'Working…', disabled, why, variant = 'primary', big, describedBy }: BtnProps) {
  const off = !!disabled || tx.busy;
  return (
    <button type="button" className={['btn', variant === 'ghost' && 'ghost', variant === 'danger' && 'danger', big && 'lg'].filter(Boolean).join(' ')} data-testid={testid}
      onClick={onClick} disabled={off} aria-busy={tx.busy || undefined} aria-describedby={describedBy} title={disabled && why ? why : undefined}>
      {tx.busy ? <><i className="wl-spin" aria-hidden="true" />{busyLabel}</> : children}
    </button>
  );
}
