import { useEffect, useState } from 'react';
import { RUN, usdCents, CHAIN } from '../../lib/run';
import { readPolicy, readVault, type PolicyState } from '../../lib/chain';
import { pctClean } from './lib';
import './guard.css';

const recorded: PolicyState = { dailySpendCap: BigInt(RUN.policy.dailySpendCap), maxExec: BigInt(RUN.policy.maxExec), minMarginBps: BigInt(RUN.policy.minMarginBps), quoteTTL: BigInt(RUN.policy.quoteTTL) };
type Src = { kind: 'checking' } | { kind: 'live'; block: bigint; paused: boolean; same: boolean } | { kind: 'fallback' };

export default function Mandate() {
  const [p, setP] = useState<PolicyState>(recorded);
  const [src, setSrc] = useState<Src>({ kind: 'checking' });
  const [flash, setFlash] = useState(0);

  useEffect(() => {
    let dead = false;
    (async () => {
      try {
        const [pol, v] = await Promise.all([readPolicy(), readVault()]);
        if (dead) return;
        const same = (Object.keys(recorded) as (keyof PolicyState)[]).every((k) => recorded[k] === pol[k]);
        setP(pol); setSrc({ kind: 'live', block: v.block, paused: v.paused, same }); setFlash(1);
      } catch {
        if (!dead) setSrc({ kind: 'fallback' });
      }
    })();
    return () => { dead = true; };
  }, []);

  const cls = flash ? 'gd-big is-flash' : 'gd-big';
  return (
    <section className="card" aria-labelledby="mandate-h">
      <h2 id="mandate-h">The owner’s mandate</h2>
      <div className="gd-mandate">
        <div className={cls}><small>Per-trade cap</small><b>{usdCents(p.maxExec)}</b><span>The most the agent may spend on one purchase.</span></div>
        <div className={cls}><small>Per UTC day</small><b>{usdCents(p.dailySpendCap)}</b><span>The most new buying it may commit to between 00:00 and 24:00 UTC. Commitments do not expire, so they can be funded later: this limits commitments, not daily cash-out.</span></div>
        <div className={cls}><small>Margin floor</small><b>{pctClean(p.minMarginBps.toString())}</b><span>Net profit as a share of the sell price must be at least this.</span></div>
        <div className={cls}><small>Quote freshness</small><b>{p.quoteTTL.toString()}s</b><span>A price the agent dates as older than this is refused. The agent supplies the date.</span></div>
      </div>
      <div className="gd-src" role="status" aria-live="polite">
        {src.kind === 'checking' && <><span className="dot pulse" aria-hidden="true"></span>Showing the values saved from the run. Reading the contract on {CHAIN.name} now…</>}
        {src.kind === 'live' && <><span className="dot" aria-hidden="true"></span>Read live from the contract on {CHAIN.name} at block {src.block.toString()}. {src.same ? 'These match the values used during the run.' : 'These differ from the values used during the run: the owner changed the mandate since.'} Kill switch: {src.paused ? 'ON, the agent is paused' : 'off, the agent may act'}.</>}
        {src.kind === 'fallback' && <><span className="dot off" aria-hidden="true"></span>RPC unreachable, so these are the values saved from the run, not a live read.</>}
      </div>
    </section>
  );
}
