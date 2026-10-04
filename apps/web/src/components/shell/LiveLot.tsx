import { useEffect, useState } from 'react';
import { readLot } from '../../lib/chain';
import { RUN, LOT_STEPS, usdBase } from '../../lib/run';

// The lot's on-chain status via readLot(id). Falls back to the recorded final state of the run.
const REC = { status: LOT_STEPS[LOT_STEPS.length - 1]?.state ?? 'UNKNOWN', escrow: 0n, paidOut: BigInt(RUN.end.totalPaidOut) };

export default function LiveLot({ id, compact = false }: { id: number; compact?: boolean }) {
  const [live, setLive] = useState<{ status: string; escrow: bigint; paidOut: bigint } | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let ok = true;
    readLot(id).then((l) => ok && setLive(l)).catch(() => ok && setFailed(true));
    return () => { ok = false; };
  }, [id]);
  const l = live ?? REC;
  const pill = <span className={'pill ' + (l.status === 'SETTLED' ? 'good' : 'blue')}>{l.status}</span>;
  if (compact) return <span className="row" title={live ? 'Read live from the contract' : 'Saved state'}>{pill}{live && <span className="xs muted">live</span>}</span>;
  return (
    <section className="card" aria-labelledby="livelot-h">
      <h2 id="livelot-h">On-chain status now</h2>
      <p className="ov-status mono" role="status">
        {live ? <><span className="ov-dot live" aria-hidden="true" />Read live from the contract (readLot)</> : failed ? <><span className="ov-dot off" aria-hidden="true" />Saved values (RPC unreachable)</> : <><span className="ov-dot wait" aria-hidden="true" />Saved values while reading the chain</>}
      </p>
      <dl className="ov-kv">
        <div><dt>State<small>Where the lot is in its fixed life cycle.</small></dt><dd>{pill}</dd></div>
        <div><dt>Escrow remaining<small>Money still locked for this lot.</small></dt><dd className="mono">{usdBase(l.escrow)}</dd></div>
        <div><dt>Paid out<small>Released from escrow to the approved supplier.</small></dt><dd className="mono">{usdBase(l.paidOut)}</dd></div>
      </dl>
    </section>
  );
}
