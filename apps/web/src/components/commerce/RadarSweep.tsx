import { Fragment, useEffect, useRef, useState } from 'react';
import type { Row } from './market';
import { useRevealOnce } from '../motion/useRevealOnce';

// Every verdict below was computed at build time by packages/matching (matchOffer) against the canonical SKU, and the list
// renders them complete (also without JavaScript). If the list starts below the fold, a one-time sweep reveals those stored
// results gate by gate when it scrolls into view. The sweep never recomputes anything, never runs twice, is skipped for
// reduced motion, and can be skipped with one click. Screen readers always get the final verdicts.
const usd = (c: number) => '$' + (c / 100).toFixed(2);
const STEP_MS = 85;
const PER_ROW = 9; // 6 gate reveals + verdict + 2 beats of rest
const ALL = Number.MAX_SAFE_INTEGER;

function Thumb({ r }: { r: Row }) {
  const s = { width: 48, height: 48 } as const;
  return r.image
    ? <span className="thumb" style={s}><img src={r.image} alt="" width={48} height={48} loading="lazy" decoding="async" /></span>
    : <span className="mk-thumb-tile" style={s} aria-hidden="true">{r.device.replace('iPhone ', '').replace('Galaxy ', '')}</span>;
}

export default function RadarSweep({ rows, groups }: { rows: Row[]; groups?: boolean }) {
  // t = ALL is the final state: server render, no JavaScript, reduced motion, list on screen at load, and after the sweep.
  const [t, setT] = useState<number>(ALL);
  const [running, setRunning] = useState(false);
  const list = useRef<HTMLUListElement>(null);
  const skipBtn = useRef<HTMLButtonElement>(null);
  const timer = useRef<number | null>(null);
  const settled = useRef(false); // once the sweep has finished or been skipped it never arms or plays again
  const total = rows.length * PER_ROW;
  const reveal = useRevealOnce(list, total * STEP_MS + 1000);

  const stop = () => { if (timer.current != null) { window.clearInterval(timer.current); timer.current = null; } };
  // The control disappears when the sweep ends. If it had focus, hand focus to the list instead of dropping it to the page.
  const finish = () => {
    settled.current = true;
    if (document.activeElement === skipBtn.current) list.current?.focus({ preventScroll: true }); // the list is always mounted
    stop(); setRunning(false); setT(ALL);
  };
  const play = () => {
    stop();
    setRunning(true);
    setT(0);
    timer.current = window.setInterval(() => {
      setT((v) => (v >= total ? v : v + 1));
    }, STEP_MS);
  };

  useEffect(() => {
    if (settled.current) return;
    if (reveal === 'armed') setT(0); // the rows wait until the list is on screen
    if (reveal === 'run' && timer.current == null) play();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reveal]);
  useEffect(() => { if (running && t >= total) finish(); }, [running, t]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => stop, []);

  const sweeping = t !== ALL;
  const cur = running && sweeping ? Math.min(rows.length - 1, Math.floor(t / PER_ROW)) : -1;
  const status = `All ${rows.length} verdicts shown. They were computed by matchOffer when this page was built.`;

  const lead = (i: number) => (groups && (i === 0 || rows[i - 1].side !== rows[i].side)
    ? <li className="mk-grp">{rows[i].side === 'supply' ? 'Listings that charge shipping (supply the agent could buy from)' : 'Free-shipping retail listings (demand the agent could sell into)'}</li>
    : null);

  return (
    <div className="stack">
      <div className="mk-sweep-bar">
        {/* Empty while the sweep runs, then the sentence once: one polite announcement. Never changes when there is no sweep. Sighted visitors see the note meanwhile. */}
        <p className="status" id="mk-sweep-status" role="status" aria-live="polite">{sweeping ? '' : status}</p>
        {sweeping && <p className="status" aria-hidden="true">Revealing the stored verdicts, gate by gate.</p>}
        {sweeping && <button type="button" className="btn ghost" ref={skipBtn} onClick={finish}>Show all results now</button>}
      </div>
      <ul className="mk-rows" ref={list} tabIndex={-1} aria-label="Identity-gate verdicts">
        {rows.map((r, i) => {
          const base = i * PER_ROW;
          const shownGates = t === ALL ? r.gates.length : Math.max(0, Math.min(r.gates.length, t - base));
          const done = t === ALL || t >= base + r.gates.length;
          const active = running && i === cur && !done;
          const pending = t !== ALL && t < base;
          const verdict = r.locked ? 'LOCKED' : 'REJECTED';
          const evidence = r.failing.length ? <><b>Fails {r.failing.map((g) => g.label).join(', ')}.</b> {r.evidence}</> : r.evidence;
          return <Fragment key={r.id}>{lead(i)}
            <li className={`mk-row ${done ? (r.locked ? 'locked' : 'rejected') : ''} ${active ? 'scan' : ''} ${pending ? 'pending' : ''} ${r.role ? 'chosen' : ''}`} aria-label={`${r.id}: ${r.locked ? 'locked, same product' : 'rejected'}`}>
              <Thumb r={r} />
              <div className="mk-ttl">
                <b>{r.title}</b>
                <span className="mono">{r.id} · {r.seller} · stock {r.stock.toLocaleString('en-US')}{r.role && <span className={`mk-chip ${r.role.toLowerCase()}`}>{r.role === 'BUY' ? 'CHOSEN BUY' : 'CHOSEN SELL'}</span>}</span>
              </div>
              <div className="mk-pr"><b>{usd(r.priceCents)}</b><small>{r.shipCents ? `+ ${usd(r.shipCents)} ship` : 'free ship'}</small></div>
              <div className="mk-gt" role="list" aria-label="Gate results">
                {r.gates.map((g, k) => {
                  const shown = k < shownGates;
                  const cls = !shown ? 'wait' : g.pass ? (g.hard ? 'ok' : 'soft') : 'bad';
                  return <span role="listitem" key={g.gate} className={`mk-gate ${cls}`} title={`${g.label}: expected ${g.expected}, observed ${g.observed}${g.hard ? '' : ' (informational)'}`}>
                    <span aria-hidden="true">{!shown ? '·' : g.pass ? (g.hard ? '✓' : '–') : '✕'}</span>{g.label}
                    <span className="sr-only">{g.pass ? ' pass' : ' fail'}</span>
                  </span>;
                })}
              </div>
              <div className="mk-verdict">
                {done
                  ? <span key={'v' + (running ? 1 : 0)} className={`mk-chip ${r.locked ? 'locked' : 'rejected'} ${running ? 'mk-stampin' : ''}`}>{verdict}</span>
                  : <><span className="mk-wait-v" aria-hidden="true">{active ? 'checking…' : 'queued'}</span><span className="sr-only">{verdict}</span></>}
              </div>
              <p className="mk-ev">{done ? evidence : <span className="sr-only">{evidence}</span>}</p>
            </li></Fragment>;
        })}
      </ul>
    </div>
  );
}
