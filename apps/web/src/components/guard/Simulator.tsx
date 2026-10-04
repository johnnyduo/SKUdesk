import { useCallback, useEffect, useRef, useState } from 'react';
import { simulateCommit, SimOutOfRange, RANGE_MESSAGE, type SimInput, type SimResult } from '../../lib/chain';
import { GUARDS, RUN, usdCents, CHAIN } from '../../lib/run';
import { pctClean } from './lib';
import './guard.css';

type Inp = { buy: number; ship: number; sell: number; units: number; age: number; claim: number | null };
const HONEST: Inp = { buy: 590, ship: 42, sell: 1099, units: 350, age: 0, claim: null };
const PRESETS: { id: string; label: string; cheat: boolean; v: Inp }[] = [
  { id: 'honest', label: 'Honest (the real trade)', cheat: false, v: HONEST },
  { id: 'inflate', label: 'Inflate the profit', cheat: true, v: { ...HONEST, claim: 390 } },
  { id: 'over', label: 'Overspend', cheat: true, v: { ...HONEST, units: 400 } },
  { id: 'stale', label: 'Stale quote', cheat: true, v: { ...HONEST, age: 780 } },
  { id: 'thin', label: 'Thin margin', cheat: true, v: { ...HONEST, sell: 900 } },
  { id: 'loss', label: 'Loss-making', cheat: true, v: { ...HONEST, sell: 800 } },
];
const same = (a: Inp, b: Inp) => (Object.keys(a) as (keyof Inp)[]).every((k) => a[k] === b[k]);

// The contract's own check order (SKUdeskCore.commitOpportunity). Errors map to the step that fires them.
const ORDER: { err: string[]; label: string; passed: string }[] = [
  { err: ['BadQuoteHash'], label: 'Quote matches its committed hash', passed: 'the agent submitted the quote it hashed' },
  { err: ['FutureObservation'], label: 'Observation is not from the future', passed: 'timestamp is not after the block time' },
  { err: ['Replay'], label: 'Opportunity not committed before', passed: 'the opportunity id is new' },
  { err: ['Stale'], label: 'Quote is fresh enough', passed: 'age, from the time the agent supplied, is within the freshness window' },
  { err: ['BadUnits', 'OutOfBounds'], label: 'Inputs within hard bounds', passed: 'units and every quote field are in range' },
  { err: ['SpendCap'], label: 'Spend within the per-trade cap', passed: 'spend derived by the contract is under the cap' },
  { err: ['DailyCap'], label: 'Commitments within daily cap', passed: 'today’s running total of commitments stays under the cap' },
  { err: ['MathMismatch'], label: 'Agent’s numbers equal the contract’s', passed: 'claimed net and margin equal the re-derivation' },
  { err: ['NonPositiveNet'], label: 'Net profit is positive', passed: 'the trade makes money' },
  { err: ['MarginTooLow'], label: 'Margin at or above the floor', passed: 'margin clears the owner’s floor' },
];

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

function Money({ id, label, hint, value, onChange, max, step = 1 }: { id: string; label: string; hint?: string; value: number; onChange: (c: number) => void; max: number; step?: number }) {
  const [text, setText] = useState((value / 100).toFixed(2));
  const focus = useRef(false);
  useEffect(() => { if (!focus.current) setText((value / 100).toFixed(2)); }, [value]);
  return (
    <div className="gd-field">
      <div className="gd-field-top"><label htmlFor={id}>{label}</label>{hint && <span className="hint">{hint}</span>}</div>
      <div className="gd-field-row">
        <input type="range" aria-label={label + ' slider'} min={0} max={max} step={step} value={clamp(value, 0, max)} onChange={(e) => onChange(Number(e.target.value))} />
        <input id={id} type="number" inputMode="decimal" min={0} step="0.01" value={text}
          onFocus={() => { focus.current = true; }}
          onBlur={() => { focus.current = false; setText((value / 100).toFixed(2)); }}
          onChange={(e) => { setText(e.target.value); const n = Number(e.target.value); if (e.target.value !== '' && Number.isFinite(n)) onChange(clamp(Math.round(n * 100), 0, 1e13)); }} />
      </div>
    </div>
  );
}
function Count({ id, label, hint, value, onChange, max, unit }: { id: string; label: string; hint?: string; value: number; onChange: (n: number) => void; max: number; unit?: string }) {
  return (
    <div className="gd-field">
      <div className="gd-field-top"><label htmlFor={id}>{label}</label>{hint && <span className="hint">{hint}</span>}</div>
      <div className="gd-field-row">
        <input type="range" aria-label={label + ' slider'} min={0} max={max} step={1} value={clamp(value, 0, max)} onChange={(e) => onChange(Number(e.target.value))} />
        <input id={id} type="number" inputMode="numeric" min={0} step={1} value={Number.isFinite(value) ? value : 0} aria-describedby={unit ? id + '-u' : undefined}
          onChange={(e) => { const n = Number(e.target.value); if (Number.isFinite(n)) onChange(clamp(Math.round(n), 0, 1e9)); }} />
      </div>
      {unit && <span id={id + '-u'} className="sr-only">{unit}</span>}
    </div>
  );
}

type St = { phase: 'busy' | 'done' | 'rpc' | 'range'; res: SimResult | null; at?: Inp };

export default function Simulator() {
  const [inp, setInp] = useState<Inp>(HONEST);
  const [st, setSt] = useState<St>({ phase: 'busy', res: null });
  const [bump, setBump] = useState(0);
  const req = useRef(0);
  const verdictRef = useRef<HTMLElement>(null);
  const jump = useRef(false);
  const set = (p: Partial<Inp>) => setInp((o) => ({ ...o, ...p }));

  const run = useCallback((i: Inp) => {
    const id = ++req.current;
    setSt((s) => ({ phase: 'busy', res: s.res, at: s.at }));
    const q: SimInput = { buyCents: i.buy, shipCents: i.ship, sellCents: i.sell, units: i.units, ageSeconds: i.age, lieNetCents: i.claim ?? undefined };
    simulateCommit(q).then(
      (res) => {
        if (id !== req.current) return;
        setSt({ phase: 'done', res, at: i });
        if (jump.current) {
          jump.current = false;
          if (window.matchMedia('(max-width:1100px)').matches) {
            const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
            setTimeout(() => verdictRef.current?.scrollIntoView({ block: 'start', behavior: reduce ? 'auto' : 'smooth' }), 50);
          }
        }
      },
      // A range refusal is the page declining to compute, never a network failure: it must not be reported as 'RPC unreachable'.
      (err) => { if (id === req.current) setSt({ phase: err instanceof SimOutOfRange || err instanceof RangeError ? 'range' : 'rpc', res: null }); },
    );
  }, []);

  useEffect(() => {
    const t = setTimeout(() => run(inp), 350);
    return () => clearTimeout(t);
  }, [inp, bump, run]);

  const active = PRESETS.find((p) => same(p.v, inp))?.id;
  const res = st.res;
  const busy = st.phase === 'busy';
  const bad = res && !res.accepted ? res : null;
  const fired = bad ? ORDER.findIndex((o) => o.err.includes(bad.error)) : -1;
  const guard = bad ? GUARDS.find((g) => g.error === bad.error) : undefined;
  const d = res?.derived;
  const at = st.at ?? inp;
  const spend = res ? (res.accepted ? res.spendCents : res.derived?.spendCents ?? 0) : 0;
  const isErr = (...n: string[]) => !!bad && n.includes(bad.error);
  const maxExec = Number(RUN.policy.maxExec), floor = Number(RUN.policy.minMarginBps), ttl = Number(RUN.policy.quoteTTL);

  return (
    <div className="gd-sim">
      <form className="card gd-sim-in" onSubmit={(e) => { e.preventDefault(); setBump((b) => b + 1); }} aria-label="Trade the agent proposes">
        <h3>Your trade</h3>
        <div role="group" aria-label="Presets" className="gd-presets">
          {PRESETS.map((p) => (
            <button type="button" key={p.id} className={'gd-preset' + (p.cheat ? ' cheat' : '')} aria-pressed={active === p.id} onClick={() => { jump.current = true; setInp(p.v); }}>{p.label}</button>
          ))}
        </div>
        <div className="gd-fields">
          <Money id="s-buy" label="Buy price per unit" value={inp.buy} onChange={(c) => set({ buy: c })} max={2000} />
          <Money id="s-ship" label="Shipping per unit" value={inp.ship} onChange={(c) => set({ ship: c })} max={500} />
          <Money id="s-sell" label="Sell price per unit" value={inp.sell} onChange={(c) => set({ sell: c })} max={3000} />
          <Count id="s-units" label="Units" hint="the contract allows a bounded range" value={inp.units} onChange={(n) => set({ units: n })} max={1000} />
          <Count id="s-age" label="Quote age (seconds)" hint={`owner’s window is ${ttl}s`} value={inp.age} onChange={(n) => set({ age: n })} max={1200} />
          <div className="gd-claim">
            <label className="gd-check"><input type="checkbox" checked={inp.claim !== null} onChange={(e) => set({ claim: e.target.checked ? 390 : null })} />Make the agent lie about its profit</label>
            {inp.claim !== null
              ? <Money id="s-claim" label="Net profit per unit the agent claims" hint="the contract will recompute it" value={inp.claim} onChange={(c) => set({ claim: c })} max={1000} />
              : <span className="hint muted sm">Off: the agent reports the figure its own library computes.</span>}
          </div>
        </div>
        <p className="gd-fixed">Held fixed so the quote is complete: duty $0.12, tax $0.08, procurement fee $0.05, payment fee $0.02, marketplace fee 8%, fulfilment $0.65, return reserve 2%, chain cost $0.04 per unit.</p>
        <button className="btn" type="submit" disabled={busy}>{busy ? <><span className="gd-spin" aria-hidden="true"></span>Asking the contract…</> : 'Run it through the contract'}</button>
        <p className="gd-truth">Runs your inputs through the real contract on {CHAIN.name} via a read-only call. Nothing is sent: no wallet, no gas, no change to the vault.</p>
      </form>

      <div className="gd-sim-out">
        <section ref={verdictRef} style={{ scrollMarginTop: 72 }} aria-label="Contract verdict" aria-live="polite" className={'gd-verdict ' + (st.phase === 'rpc' || st.phase === 'range' ? 'rpc' : !res ? 'wait' : res.accepted ? 'ok' : 'bad')}>
          {st.phase === 'range' ? (
            <>
              <span className="gd-stamp">OUT OF RANGE</span>
              <div className="gd-verdict-txt"><p>{RANGE_MESSAGE}</p></div>
            </>
          ) : st.phase === 'rpc' ? (
            <>
              <span className="gd-stamp">NO ANSWER</span>
              <div className="gd-verdict-txt"><p>RPC unreachable, try again. No result is shown because none was received.</p><button type="button" className="btn ghost gd-retry" onClick={() => setBump((b) => b + 1)}>Try again</button></div>
            </>
          ) : !res ? (
            <>
              <span className="gd-stamp"><span className="gd-spin" aria-hidden="true"></span>ASKING</span>
              <div className="gd-verdict-txt"><p>Sending the call to the deployed contract…</p></div>
            </>
          ) : res.accepted ? (
            <>
              <span className="gd-stamp" key={'a' + at.units + at.sell}>ACCEPTED</span>
              <div className="gd-verdict-txt"><p>The contract would accept this commit: net {usdCents(res.net)} per unit, margin {pctClean(res.marginBps)}, spend {usdCents(res.spendCents)}.</p><span className="mono">eth_call as the agent address: returned normally{busy ? ' (updating…)' : ''}</span></div>
            </>
          ) : (
            <>
              <span className="gd-stamp" key={res.error + at.units + at.sell + at.age + String(at.claim)}>REVERTED</span>
              <div className="gd-verdict-txt"><p>{res.sentence}</p><span className="mono">{res.error}({res.args.map(String).join(', ')}){busy ? ' (updating…)' : ''}</span></div>
            </>
          )}
        </section>

        {res && d && (
          <div className={busy ? 'gd-busy' : undefined}>
            <div className="gd-compare">
              <div className="panel">
                <h4>Derived by the TypeScript library</h4>
                <table className="kv"><tbody>
                  <tr><td>Landed cost per unit</td><td>{usdCents(d.landed)}</td></tr>
                  <tr><td>Net profit per unit</td><td>{usdCents(d.net)}</td></tr>
                  <tr><td>Net margin</td><td>{pctClean(d.marginBps)}</td></tr>
                  <tr><td>Spend (landed × {at.units})</td><td>{usdCents(spend)}</td></tr>
                </tbody></table>
              </div>
              <div className="panel">
                <h4>What the contract compared</h4>
                <table className="kv"><tbody>
                  <tr><td>Agent’s claimed net</td><td className={isErr('MathMismatch') ? 'hit' : ''}>{usdCents(at.claim ?? d.net)} vs {usdCents(d.net)}</td></tr>
                  <tr><td>Spend vs cap</td><td className={isErr('SpendCap') ? 'hit' : ''}>{usdCents(spend)} / {usdCents(maxExec)}</td></tr>
                  <tr><td>Margin vs floor</td><td className={isErr('MarginTooLow', 'NonPositiveNet') ? 'hit' : ''}>{pctClean(d.marginBps)} / {pctClean(floor)}</td></tr>
                  <tr><td>Quote age vs window</td><td className={isErr('Stale') ? 'hit' : ''}>{at.age}s / {ttl}s</td></tr>
                </tbody></table>
              </div>
            </div>
          </div>
        )}

        {res && (
          <div className={'panel' + (busy ? ' gd-busy' : '')}>
            <h4>The contract’s checks, in the order it runs them</h4>
            <ol className="gd-order">
              {ORDER.map((o, i) => {
                const state = bad ? (fired === -1 ? 'idle' : i < fired ? 'pass' : i === fired ? 'hit' : 'idle') : 'pass';
                return <li key={o.label} className={state}><span className="m" aria-hidden="true">{state === 'pass' ? '✓' : state === 'hit' ? '✕' : '–'}</span><span>{o.label}<small>{state === 'pass' ? 'passed: ' + o.passed : state === 'hit' ? 'stopped here' : 'not reached'}</small></span></li>;
              })}
            </ol>
            <span className="sr-only">Check results are listed in order; the first failing check ends the call.</span>
          </div>
        )}

        {res && (
          bad ? (
            <p className="gd-why">
              <b>{guard ? guard.rule : bad.error}.</b> {guard ? guard.plain : 'The contract refused this call.'}
              {guard && <> The named Foundry test that proves it: <span className="mono">{guard.test}</span>.</>}
            </p>
          ) : (
            <p className="gd-why ok">Every guard passed: the agent’s figures equal the contract’s own re-derivation, the spend is under both caps, the margin clears the floor and the quote is fresh. Nothing was sent, so the vault did not change.</p>
          )
        )}
      </div>
    </div>
  );
}
