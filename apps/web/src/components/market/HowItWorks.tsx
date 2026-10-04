// Plain-language explainer: a dialog (opened from the header '?' or the testnet note) and a first-visit banner.
import { useEffect, useRef } from 'react';
import { useMarket } from '../../lib/market-app';

const STEPS: [string, string, string][] = [
  ['1', 'Commit (sealed)', 'Each trader posts only a hash of its order (side, price, size and a secret salt) and locks a small bond. Nobody can read the price or size yet.'],
  ['2', 'Reveal', 'Orders are opened. The contract checks each one against its hash and reserves the cash or units it needs. Orders never revealed lose their bond.'],
  ['3', 'Match at ONE uniform price', 'All revealed buys and sells are matched together at a single clearing price: the one that trades the most units (the midpoint if several tie). Everyone who trades gets that same price.'],
  ['4', 'Settle', 'Cash and units move on chain in the same transaction that clears the epoch. The price you see on this page is that on-chain result.'],
];

const FACTS = [
  <><b>It clears test units.</b> Nothing is delivered to a buyer, and the market owner can issue new units (BlindBook.issue) that are not backed by on-chain collateral. They are not tied to real stock.</>,
  <><b>The price is not a retail price.</b> It is where these test units cleared on BlindBook. It is not what the product costs in a shop and not the Uniswap v4 pool price.</>,
  <><b>Bids are hidden only while orders are committed.</b> After a reveal, side, price and size are public before the clearing transaction runs, and they stay public. The forfeited bond is the only deterrent against never revealing.</>,
  <><b>Ties go to the earlier commit.</b> Orders at the same price fill in the order they were committed.</>,
  <><b>Liquidity is provided by SKUdesk bots</b> on Robinhood Chain Testnet. They are scripted wallets run by a keeper script. This is a testnet market, not a public one.</>,
  <><b>The reference price is a fixed snapshot</b> plus a deterministic drift. It is not a live price feed.</>,
  <><b>The market owner can pause trading.</b> A pause that runs to the end of the reveal window forfeits the bond of every order not yet revealed to the owner’s treasury.</>,
  <><b>The settlement token is mUSDG</b>, the test USDG token of this testnet build. It has no value.</>,
  <><b>Early reveals are visible to later revealers</b>, so a trader who reveals first can be read by those who reveal after. The forfeited bond is the only deterrent against never revealing.</>,
];

export const INTRO_KEY = 'robinize-market-intro-dismissed';

export function HowBanner({ onOpen, onDismiss }: { onOpen: () => void; onDismiss: () => void }) {
  return (
    <div className="mk-banner" role="region" aria-label="Introduction">
      <p><b>New here?</b> Each epoch (about 45 seconds) is a sealed-bid auction: orders are hidden, then revealed, then everyone trades at one uniform price. Bots provide the liquidity on Robinhood Chain Testnet.</p>
      <div className="mk-banner-a">
        <button type="button" className="mk-btn mk-btn-pri" onClick={onOpen}>How it works</button>
        <button type="button" className="mk-btn" onClick={onDismiss} aria-label="Dismiss introduction">Dismiss</button>
      </div>
    </div>
  );
}

export default function HowItWorks({ open, onClose }: { open: boolean; onClose: () => void }) {
  const s = useMarket(); const box = useRef<HTMLDivElement>(null); const prev = useRef<Element | null>(null);
  const sc = s.schedule;
  useEffect(() => {
    if (!open) return; prev.current = document.activeElement;
    const el = box.current!; el.querySelector<HTMLElement>('button')?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); onClose(); return; }
      if (e.key !== 'Tab') return; const f = el.querySelectorAll<HTMLElement>('button, a[href]'); if (!f.length) return;
      const a = f[0], z = f[f.length - 1];
      if (e.shiftKey && document.activeElement === a) { z.focus(); e.preventDefault(); } else if (!e.shiftKey && document.activeElement === z) { a.focus(); e.preventDefault(); }
    };
    document.addEventListener('keydown', onKey); const prevOverflow = document.body.style.overflow; document.body.style.overflow = 'hidden';
    return () => { document.removeEventListener('keydown', onKey); document.body.style.overflow = prevOverflow; (prev.current as HTMLElement | null)?.focus?.(); };
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="mk-modal" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="mk-dialog" role="dialog" aria-modal="true" aria-labelledby="mk-how-h" ref={box} data-testid="howitworks-dialog">
        <div className="mk-dialog-h">
          <h2 id="mk-how-h">How this market works</h2>
          <button type="button" className="mk-x" onClick={onClose} aria-label="Close explainer">×</button>
        </div>
        <p className="mk-dialog-lead">Prices here are discovered by <b>sealed-bid batch auctions</b> on chain, not by an open list of bids and asks.{sc ? ` Every ${sc.epochLen} seconds: ${sc.commitEnd}s to commit, ${sc.revealEnd - sc.commitEnd}s to reveal, then the epoch clears.` : ''}</p>
        <ol className="mk-steps">
          {STEPS.map(([n, t, d]) => <li key={n}><span className="mk-stepn" aria-hidden="true">{n}</span><div><h3>{t}</h3><p>{d}</p></div></li>)}
        </ol>
        <h3 className="mk-facts-h">What this market is and is not</h3>
        <ul className="mk-facts">{FACTS.map((f, i) => <li key={i}>{f}</li>)}</ul>
        <div className="mk-dialog-f"><button type="button" className="mk-btn mk-btn-pri" onClick={onClose}>Got it</button></div>
      </div>
    </div>
  );
}
