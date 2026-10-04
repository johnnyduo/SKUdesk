import { useEffect, useRef, useState } from 'react';
import { readVault, type VaultState } from '../../lib/chain';
import { RUN, CHAIN, usdBase } from '../../lib/run';

// Live vault panel. Reads the real contract from the browser every 15 s; if the RPC is unreachable it falls back to the
// recorded end-of-run values and says so. Nothing is invented: the fallback numbers are RUN.end, the start-of-run
// deposit is the vaultFree value recorded by the run's first event.
const START_BASE = BigInt(RUN.events.find((e) => e.kind === 'policy')?.data?.vaultFree ?? 0);
const REC = {
  free: BigInt(RUN.end.free),
  totalEscrow: BigInt(RUN.end.totalEscrow),
  totalPaidOut: BigInt(RUN.end.totalPaidOut),
  totalProceeds: BigInt(RUN.end.totalProceeds),
};
const POLL_MS = 15_000;

const d = (b: bigint) => usdBase(b);

export default function LiveVault() {
  const [live, setLive] = useState<VaultState | null>(null);
  const [failed, setFailed] = useState(false);
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [grown, setGrown] = useState(false);
  const alive = useRef(true);

  const load = async () => {
    setBusy(true);
    try {
      const v = await readVault();
      if (!alive.current) return;
      setLive(v);
      setFailed(false);
    } catch {
      if (!alive.current) return;
      setFailed(true);
    } finally {
      if (alive.current) { setBusy(false); setTried(true); }
    }
  };

  useEffect(() => {
    alive.current = true;
    load();
    const poll = setInterval(load, POLL_MS);
    const tick = setInterval(() => setNow(Date.now()), 1000);
    const raf = requestAnimationFrame(() => setGrown(true));
    return () => { alive.current = false; clearInterval(poll); clearInterval(tick); cancelAnimationFrame(raf); };
  }, []);

  const useLive = !!live && !failed;
  const v = useLive ? live! : { ...REC, totalDeposited: 0n, totalWithdrawn: 0n, spentToday: BigInt(RUN.end.spentToday), paused: false, block: 0n, at: 0 };
  const total = v.free + v.totalEscrow + v.totalPaidOut || 1n;
  const pct = (x: bigint) => `${grown ? Number((x * 10000n) / total) / 100 : 0}%`;

  const lhs = v.free + v.totalEscrow + v.totalPaidOut;
  const rhs = useLive ? v.totalDeposited + v.totalProceeds - v.totalWithdrawn : START_BASE + v.totalProceeds;
  const holds = lhs === rhs;
  const ago = live ? Math.max(0, Math.round((now - live.at) / 1000)) : 0;

  let status: JSX.Element;
  if (useLive) status = <><span className="ov-dot live" aria-hidden="true" />LIVE from {CHAIN.name}, block {live!.block.toString()}, updated {ago}s ago{busy ? ' (refreshing)' : ''}</>;
  else if (failed) status = <><span className="ov-dot off" aria-hidden="true" />Showing saved values (RPC unreachable). <button className="ov-link" onClick={load}>Try again</button></>;
  else status = <><span className="ov-dot wait" aria-hidden="true" />Showing saved values while reading the chain{tried ? '' : '…'}</>;

  return (
    <section className="card" aria-labelledby="vault-h">
      <h2 id="vault-h">The vault</h2>
      <p className="ov-gl">The vault is the pot of test money the contract holds for the owner. <b>Free</b> is money nobody has committed yet, <b>in escrow</b> is money locked for one purchase, <b>paid out</b> has been released to the approved supplier.</p>
      <p className="ov-status mono" role="status" aria-live="polite">{status}</p>

      <div className="ov-bar" role="img" aria-label={`Free ${d(v.free)}, in escrow ${d(v.totalEscrow)}, paid out ${d(v.totalPaidOut)}`}>
        <i className="free" style={{ width: pct(v.free) }} />
        <i className="escrow" style={{ width: pct(v.totalEscrow) }} />
        <i className="paid" style={{ width: pct(v.totalPaidOut) }} />
      </div>
      <div className="ov-legend">
        <div><i className="free" /><small>Free</small><b className="mono">{d(v.free)}</b></div>
        <div><i className="escrow" /><small>In escrow</small><b className="mono">{d(v.totalEscrow)}</b></div>
        <div><i className="paid" /><small>Paid out</small><b className="mono">{d(v.totalPaidOut)}</b></div>
        <div><i className="proc" /><small>Sale proceeds received</small><b className="mono">{d(v.totalProceeds)}</b></div>
      </div>

      <div className={'ov-conserve ' + (holds ? 'ok' : 'bad')}>
        <span className="ov-check" aria-hidden="true">{holds ? '✓' : '✕'}</span>
        <div>
          {useLive ? (
            <p className="mono xs">free + escrow + paid out = deposited + proceeds − withdrawn<br />
              {d(v.free)} + {d(v.totalEscrow)} + {d(v.totalPaidOut)} = {d(v.totalDeposited)} + {d(v.totalProceeds)} − {d(v.totalWithdrawn)}<br />
              <b>{d(lhs)} = {d(rhs)}</b></p>
          ) : (
            <p className="mono xs">free + escrow + paid out − proceeds = the vault balance at the start of the run<br />
              {d(v.free)} + {d(v.totalEscrow)} + {d(v.totalPaidOut)} − {d(v.totalProceeds)} = <b>{d(lhs - v.totalProceeds)}</b> vs {d(START_BASE)} at the start</p>
          )}
          <p className="ov-gl">{holds ? 'No money was created or lost: every cent is in exactly one bucket.' : 'The buckets do not add up to what went in. Something outside the run has touched the vault.'}</p>
        </div>
      </div>
      {useLive && v.paused && <p className="pill bad">Agent is paused by the owner</p>}
    </section>
  );
}
