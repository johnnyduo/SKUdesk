// Asset switcher: a WAI-ARIA select-only combobox above the stats strip, so every catalog market is one tap away on desktop and on a
// 390 px phone without opening the Assets tab. The listbox groups the markets by category (Phones ... Accessories) and every row
// says what it is (symbol, name, subtitle, an "Accessory" tag for the phone cases) with its own last price. Focus stays on the combobox
// (aria-activedescendant). Selection goes through the existing selectMarket (URL hash, default-selection lock), so links, hashchange
// and back/forward keep working. Pure logic: lib/asset-switcher.ts.
// Test ids: asset-switcher, asset-switcher-trigger (data-selected), asset-option (data-symbol). The asset list's row id is not reused.
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useMarket, useSelectedMarket, useSelectionSettled, selectMarket, selectedIndex, marketStore } from '../../lib/market-app';
import Sk from './Sk';
import { loadFailed } from '../../lib/market-view';
import { toItems, groupItems, tagOf, moveIndex, createTypeahead, announceText, nextAnnouncement, SPARK_W, SPARK_H, type SwitcherItem } from '../../lib/asset-switcher';
import catalog from '../../data/catalog.json';
import { usd, pctStr, lc } from './mk-fmt';
import './asset-switcher.css';

const FMT = { usd, pct: pctStr };
const isChar = (e: React.KeyboardEvent) => e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey;
const OPEN_KEYS = new Set(['ArrowDown', 'ArrowUp', 'Enter', ' ']);

function Spark({ it }: { it: SwitcherItem }) {
  return (
    <svg className={`mk-spark mk-spark-${it.dir}`} width={SPARK_W} height={SPARK_H} viewBox={`0 0 ${SPARK_W} ${SPARK_H}`} aria-hidden="true" focusable="false">
      {it.spark ? <polyline points={it.spark} fill="none" strokeWidth="1.4" strokeLinejoin="round" strokeLinecap="round" /> : <line x1="2" x2={SPARK_W - 2} y1={SPARK_H / 2} y2={SPARK_H / 2} className="mk-spark-none" />}
    </svg>
  );
}

/** Price, or "no trade yet", or "..." while the history is loading (never a price before the terminal itself would show one). */
function PriceCell({ it }: { it: SwitcherItem }) {
  return (
    <span className="asw-pc">
      <span className={`asw-px${it.state === 'traded' ? '' : ' none'}`} aria-hidden={it.state === 'loading' ? 'true' : undefined}>{it.priceText}</span>
      {it.state === 'loading' && <span className="sr-only">price loading</span>}
      {it.changeText && <span className={`asw-ch ${it.dir}`}>{it.changeText}</span>}
    </span>
  );
}

/** Symbol, optional category tag, name and what it is: the same three lines in the trigger and in every option. */
function Ident({ it }: { it: SwitcherItem }) {
  const tag = tagOf(it.category);
  return (
    <span className="asw-id">
      <span className="asw-l1"><b className="asw-sym">{it.symbol}</b>{tag && <span className="asw-tag">{tag}</span>}</span>
      <span className="asw-name" title={it.name}>{it.name}</span>
      <span className="asw-sub">{it.subtitle}</span>
    </span>
  );
}

export default function AssetSwitcher() {
  const s = useMarket(); const sel = useSelectedMarket(); const settled = useSelectionSettled();   // false: the trigger shows no market until the default pick has settled
  const loaded = s.ready && !loadFailed(s);   // the terminal's own rule: until then no price and no "no trade yet"
  const items = useMemo(() => toItems(catalog.markets, s.markets, (id) => (s.clears[lc(id)] ?? []).filter((c) => c.volume > 0).length, FMT, loaded), [s.markets, s.clears, loaded]);
  const groups = useMemo(() => groupItems(items), [items]);
  const pos = Math.max(0, items.findIndex((it) => it.index === sel.index)); const cur = items[pos];
  const [open, setOpen] = useState(false); const [active, setActive] = useState(pos); const [say, setSay] = useState('');
  const uid = useId(); const labelId = `${uid}-label`; const listId = `${uid}-list`; const optId = (p: number) => `${uid}-opt-${p}`; const grpId = (g: number) => `${uid}-grp-${g}`;
  const root = useRef<HTMLDivElement>(null); const trigger = useRef<HTMLDivElement>(null); const ta = useRef(createTypeahead());

  /** Says "Selected X, last price ..." for market i using the store as it is at this moment (prices change every epoch, a render-time copy goes stale). */
  const announce = (i: number) => { const st = marketStore.getState(); const m = st.markets[i]; if (m) setSay((prev) => nextAnnouncement(prev, announceText(m, st.ready && !loadFailed(st), FMT))); };
  const close = () => { setOpen(false); ta.current.reset(); };
  const openAt = (p: number) => { setActive(Math.max(0, Math.min(items.length - 1, p))); setOpen(true); };
  const commit = (p: number) => {
    const it = items[p]; close(); trigger.current?.focus(); if (!it) return;
    if (it.index !== sel.index) selectMarket(it.index);
    announce(it.index);   // always: choosing the market that is already selected is still answered, with the price as of now
  };

  // a pointer press anywhere else closes the list (focus is left where the user put it)
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => { if (!root.current?.contains(e.target as Node)) close(); };
    document.addEventListener('pointerdown', onDown, true); return () => document.removeEventListener('pointerdown', onDown, true);
  }, [open]);
  // keep the active option in view while the list scrolls (18 rows in a max-height box, on a phone about five show at once)
  useEffect(() => { if (open) document.getElementById(optId(active))?.scrollIntoView({ block: 'nearest' }); }, [open, active]); // eslint-disable-line react-hooks/exhaustive-deps
  // a link, a typed hash or back/forward also switch the market: say so once (market-app's own listener has already updated the selection)
  useEffect(() => {
    const onHash = () => announce(selectedIndex());
    window.addEventListener('hashchange', onHash); return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const onKeyDown = (e: React.KeyboardEvent) => {
    const k = e.key; const n = items.length; if (!n || e.altKey || e.ctrlKey || e.metaKey) return;
    if (!open) {
      if (OPEN_KEYS.has(k)) { e.preventDefault(); openAt(pos); }
      else if (k === 'Home' || k === 'End' || k === 'PageUp' || k === 'PageDown') { e.preventDefault(); openAt(moveIndex(pos, k, n) ?? pos); }
      else if (isChar(e)) { e.preventDefault(); openAt(ta.current.key(k, items, pos) ?? pos); }
      return;
    }
    if (k === 'Escape') { e.preventDefault(); close(); trigger.current?.focus(); return; }
    if (k === 'Tab') { close(); return; } // focus moves on as usual; the selection does not change
    if (k === 'Enter' || (k === ' ' && !ta.current.typing())) { e.preventDefault(); commit(active); return; }
    const j = moveIndex(active, k, n); if (j !== null) { e.preventDefault(); setActive(j); return; }
    if (isChar(e)) { e.preventDefault(); const t = ta.current.key(k, items, active); if (t !== null) setActive(t); }
  };

  if (!cur) return null;
  return (
    <div ref={root} className="asw" data-testid="asset-switcher">
      <span className="asw-k" id={labelId}>Market</span>
      <div className="asw-box">
        <div ref={trigger} role="combobox" tabIndex={0} aria-labelledby={labelId} aria-haspopup="listbox" aria-expanded={open} aria-controls={listId}
          aria-activedescendant={open ? optId(active) : undefined} className="asw-trigger" data-testid="asset-switcher-trigger" data-selected={settled ? cur.symbol : ''} data-category={settled ? cur.category : ''} aria-busy={!settled}
          style={settled ? { ['--ac' as any]: cur.accent } : undefined} onClick={() => (open ? close() : openAt(pos))} onKeyDown={onKeyDown} onBlur={() => { if (open) close(); }}>
          <i className="mk-sw" aria-hidden="true" />
          {settled ? <Ident it={cur} /> : <span className="asw-id"><span className="asw-l1"><b className="asw-sym"><Sk n={7} /></b></span><span className="asw-name"><Sk n={20} /></span><span className="asw-sub"><Sk n={14} /></span></span>}
          {settled ? <PriceCell it={cur} /> : <span className="asw-pc"><span className="asw-px"><Sk n={8} /></span></span>}
          <svg className="asw-chev" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"><path d="M4 6l4 4 4-4" /></svg>
        </div>
        <div id={listId} role="listbox" aria-labelledby={labelId} className="asw-list" hidden={!open} onMouseDown={(e) => e.preventDefault()}>
          {groups.map((g, gi) => (
            <div key={g.category} role="group" aria-labelledby={grpId(gi)} data-category={g.category}>
              <div id={grpId(gi)} className="asw-gl">{g.category}</div>
              {g.items.map((it, k) => {
                const p = g.start + k;
                return (
                  <div key={it.symbol} id={optId(p)} role="option" aria-selected={p === active} data-testid="asset-option" data-symbol={it.symbol} data-category={it.category}
                    data-market-id={lc(it.marketId)} data-last={it.last} data-points={it.points} data-state={it.state} data-current={it.index === sel.index ? 'true' : 'false'}
                    className={`asw-opt${p === active ? ' act' : ''}${it.index === sel.index ? ' cur' : ''}`} style={{ ['--ac' as any]: it.accent }}
                    onPointerMove={() => { if (p !== active) setActive(p); }} onClick={() => commit(p)}>
                    <i className="mk-sw" aria-hidden="true" />
                    <Ident it={it} />
                    <Spark it={it} />
                    <PriceCell it={it} />
                    <svg className="asw-chk" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">{it.index === sel.index && <path d="M3 8.5 6.5 12 13 4.5" />}</svg>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </div>
      <span className="asw-n" aria-hidden="true">{items.length} markets</span>
      <p className="sr-only" aria-live="polite" aria-atomic="true">{say}</p>
    </div>
  );
}
