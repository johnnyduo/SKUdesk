import { useEffect, useState } from 'react';
import { readPolicy } from '../../lib/chain';
import { RUN, usdCents, pct } from '../../lib/run';

type P = { dailySpendCap: string; maxExec: string; minMarginBps: string; quoteTTL: string };

export default function LiveMandate() {
  const [live, setLive] = useState<P | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let ok = true;
    readPolicy().then((p) => { if (ok) setLive({ dailySpendCap: p.dailySpendCap.toString(), maxExec: p.maxExec.toString(), minMarginBps: p.minMarginBps.toString(), quoteTTL: p.quoteTTL.toString() }); }).catch(() => ok && setFailed(true));
    return () => { ok = false; };
  }, []);
  const p = live ?? RUN.policy;
  const rows: [string, string, string][] = [
    ['Per-trade cap', usdCents(p.maxExec), 'The most the agent may spend on one purchase.'],
    ['Per day', usdCents(p.dailySpendCap), 'The most new buying it may commit to in one UTC day. Commitments do not expire, so this limits commitments, not daily cash-out.'],
    ['Margin floor', pct(p.minMarginBps), 'Net profit must be at least this share of the sale price.'],
    ['Freshness', `${p.quoteTTL}s`, 'A price the agent dates as older than this is refused. The agent supplies the date.'],
  ];
  return (
    <section className="card" aria-labelledby="mandate-h">
      <h2 id="mandate-h">The mandate</h2>
      <p className="ov-gl">The owner wrote these limits into the contract. The agent cannot change them.</p>
      <p className="ov-status mono" role="status">
        {live ? <><span className="ov-dot live" aria-hidden="true" />Read live from the contract</> : failed ? <><span className="ov-dot off" aria-hidden="true" />Saved values (RPC unreachable)</> : <><span className="ov-dot wait" aria-hidden="true" />Saved values while reading the chain</>}
      </p>
      <dl className="ov-kv">
        {rows.map(([k, v, g]) => (
          <div key={k}><dt>{k}<small>{g}</small></dt><dd className="mono">{v}</dd></div>
        ))}
      </dl>
    </section>
  );
}
