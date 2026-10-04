import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { getAddress } from 'viem';
import { client } from '../../lib/chain';
import { explorer, short } from '../../lib/run';
import { useWallet } from '../../lib/wallet-app';
import { ORDERS_ABI } from '../../lib/orders-abi';
import {
  TRUST, STATUS_TEXT, buildTimeline, summarize, awaiting, mergeEvents, orderIds, eventsOfOrder, fetchEscrowEvents, attachTimes,
  fmtPrice, fmtMusdc, fmtTime, fmtDuration, type EscrowEvent, type OrderSummary, type StatusName,
} from '../../lib/orders';
import { useTx, TxButton, TxStatus } from './TxButton';
import { Addr } from './ui';
import Provenance from '../ui/Provenance';
import './orders.css';

// /app/orders: every OrderEscrow order as a timeline. Reads the saved snapshot (src/data/orders.json, baked in at build) first, then the
// live logs from the public RPC for any block after the snapshot; on an RPC error the snapshot stays on screen. Read-only except the
// buyer's own actions (cancel, withdraw an offer, release, dispute), which go through the shared wallet engine.

type Step = { label: string; caller: string; tx: string; block: number };
export type OrdersData = {
  deployed: boolean; chainId: number; escrow: string; verifier: string; token: string; book: string; market: string; sku: string; bondBps: number;
  windows: { accept: number; ship: number; verify: number; dispute: number; resolve: number }; logsFromBlock?: number; head?: number;
  proof?: {
    ranAt: string; statement: string; operator: string; wallets: Record<string, string>; shipTo: string;
    round?: { epoch: number; price: number; volume: number; orderCount: number; keeperOrders: number; clearTx: string; clearedBy: string; sells: { who: string; ask: number; units: number; filled: number }[]; bid: { price: number; units: number; filled: number } };
    setup: Step[]; roundSteps: Step[]; orders: { id: number; scenario: string; steps: Step[]; assertions: { label: string; ok: boolean; detail: string }[] }[]; assertions: { label: string; ok: boolean; detail: string }[]; skipped: string[];
  };
  events: EscrowEvent[];
};

const PILL: Record<StatusName, string> = { NONE: '', FUNDED: 'blue', OFFERED: 'blue', MATCHED: 'blue', SHIPPED: 'blue', DELIVERED: 'ok', RELEASED: 'good', CANCELLED: 'warn', REFUNDED: 'warn', DISPUTED: 'bad' };
const STEP_BLOCKS = 50_000n;
const ROLE: Record<string, string> = { buyer: 'buyer', sellerA: 'seller A', sellerB: 'seller B', bidder: 'bidder' };
const TxLink = ({ hash, label }: { hash: string; label?: ReactNode }) => { const h = explorer.tx(hash); return h ? <a href={h} target="_blank" rel="noopener noreferrer">{label ?? <span className="mono">{short(hash, 6, 4)}</span>} ↗<span className="sr-only"> (opens the block explorer in a new tab)</span></a> : <span className="mono">{short(hash, 6, 4)}</span>; };

function Actions({ s, escrow, account, windows, onDone }: { s: OrderSummary; escrow: `0x${string}`; account?: string; windows: OrdersData['windows']; onDone: () => void }) {
  const cancel = useTx(`cancel-${s.id}`, onDone); const withdraw = useTx(`withdraw-${s.id}`, onDone); const release = useTx(`release-${s.id}`, onDone); const dispute = useTx(`dispute-${s.id}`, onDone);
  if (!account || account.toLowerCase() !== s.buyer.toLowerCase()) return null;
  const call = (tx: ReturnType<typeof useTx>, label: string, functionName: string) => () => void tx.run(async (send) => { await send(label, { address: escrow, abi: ORDERS_ABI, functionName, args: [BigInt(s.id)] }); });
  const canDispute = !!s.releaseAfter && Date.now() / 1000 < s.releaseAfter;
  if (s.status !== 'FUNDED' && s.status !== 'OFFERED' && s.status !== 'DELIVERED') return null;
  return (
    <div>
      <p className="od-sub">You are connected as the buyer of this order.</p>
      <div className="od-actions">
        {s.status === 'FUNDED' && <div className="od-act"><TxButton tx={cancel} testid={`order-cancel-${s.id}`} variant="ghost" onClick={call(cancel, 'Cancel', 'cancel')} busyLabel="Cancelling…">Cancel and take the money back</TxButton>
          <p className="od-hint">Returns all {fmtMusdc(s.funded)} at once.{s.matchBy ? ` The order can be matched until ${fmtTime(s.matchBy)}; after that anyone can cancel it for you.` : ''}</p></div>}
        {s.status === 'OFFERED' && <div className="od-act"><TxButton tx={withdraw} testid={`order-withdraw-${s.id}`} variant="ghost" onClick={call(withdraw, 'Withdraw offer', 'refundUnaccepted')} busyLabel="Withdrawing…">Withdraw the offer</TxButton>
          <p className="od-hint">The seller has {fmtDuration(windows.accept)} to accept{s.acceptBy ? `, until ${fmtTime(s.acceptBy)}` : ''}. You can withdraw before then; after it anyone can. The seller’s bond is not touched.</p></div>}
        {s.status === 'DELIVERED' && <div className="od-act"><TxButton tx={release} testid={`order-release-${s.id}`} onClick={call(release, 'Release', 'release')} busyLabel="Releasing…">Release the payment</TxButton>
          <p className="od-hint">Pays the seller the round price and returns the rest of your cap to you. The dispute window is {fmtDuration(windows.dispute)}{s.releaseAfter ? `, until ${fmtTime(s.releaseAfter)}` : ''}; after it anyone can release.</p></div>}
        {s.status === 'DELIVERED' && <div className="od-act"><TxButton tx={dispute} testid={`order-dispute-${s.id}`} variant="danger" disabled={!canDispute} why="The dispute window has closed" onClick={call(dispute, 'Dispute', 'dispute')} busyLabel="Disputing…">Dispute delivery</TxButton>
          <p className="od-hint">Starts a {fmtDuration(windows.resolve)} resolve window for the verifier. If the verifier stays silent, the seller is paid by default.</p></div>}
      </div>
      {[cancel, withdraw, release, dispute].map((t) => <TxStatus key={t.action} tx={t} />)}
    </div>
  );
}

function OrderCard({ s, events, data, account, onDone }: { s: OrderSummary; events: EscrowEvent[]; data: OrdersData; account?: string; onDone: () => void }) {
  const steps = buildTimeline({ qty: s.qty }, events, { id: s.id, verifier: data.verifier });
  const aw = awaiting(s);
  return (
    <section className="card" aria-labelledby={`od-${s.id}-h`} data-testid={`order-${s.id}`}>
      <div className="od-head">
        <h2 id={`od-${s.id}-h`}>Order #{s.id}</h2>
        <span className={`pill ${PILL[s.status]}`} data-testid={`order-${s.id}-status`}>{s.status}</span>
        <span className="od-sub">{STATUS_TEXT[s.status]}</span>
      </div>
      <div className="od-meta">
        <div><small>Quantity and cap</small><b>{s.qty} unit{s.qty === 1 ? '' : 's'}, up to {fmtPrice(s.maxPriceCents)} each</b></div>
        <div><small>Round price</small><b>{s.priceCents ? `${fmtPrice(s.priceCents)} per unit` : 'Not matched yet'}</b></div>
        <div><small>Buyer</small><b><Addr a={s.buyer} /></b></div>
        <div><small>Seller</small><b>{s.seller ? <Addr a={s.seller} /> : 'Not chosen yet'}</b></div>
      </div>
      <ol className="od-steps" aria-label={`Timeline of order ${s.id}`}>
        {steps.map((t) => (
          <li className={`od-step ${t.provenance}`} key={t.key + t.tx}>
            <div className="od-step-h"><b>{t.label}</b><Provenance kind={t.provenance} /></div>
            <p>{t.detail}</p>
            {t.key === 'attested' && t.actor && <p className="od-who">Signed by the named verifier <Addr a={t.actor} />. This is a statement by one address, not a carrier record.</p>}
            {t.key === 'released' && t.actor && <p className="od-who">Released by <Addr a={t.actor} /> (reason code {t.reason}).</p>}
            {t.note && <p className="od-note">{t.note}</p>}
            <p className="od-m"><TxLink hash={t.tx} /> · block {t.at}{t.time ? ` · ${fmtTime(t.time)}` : ''}</p>
          </li>
        ))}
        {aw && <li className="od-step next"><div className="od-step-h"><b>Next</b></div><p>{aw.text}{aw.deadline ? `. Deadline ${fmtTime(aw.deadline)}.` : '.'}</p></li>}
      </ol>
      <Actions s={s} escrow={getAddress(data.escrow)} account={account} windows={data.windows} onDone={onDone} />
    </section>
  );
}

export default function OrdersView({ data }: { data: OrdersData }) {
  const w = useWallet(); const account = w.status === 'connected' ? w.account : undefined;
  const [events, setEvents] = useState<EscrowEvent[]>(data.events ?? []);
  const [live, setLive] = useState<{ state: 'snapshot' | 'live' | 'error'; block?: number; at?: string; error?: string }>({ state: 'snapshot' });
  const cursor = useRef<bigint | null>(data.head ? BigInt(data.head) + 1n : data.logsFromBlock ? BigInt(data.logsFromBlock) : null);
  const busy = useRef(false);

  const refresh = useCallback(async () => {
    if (busy.current) return; busy.current = true;
    try {
      const c = client(); const head = await c.getBlockNumber(); const from = cursor.current;
      if (from === null) throw new Error('the snapshot has no block to continue from');
      if ((head - from) / STEP_BLOCKS > 60n) throw new Error('too many blocks since the snapshot to read from the browser');
      const fresh: EscrowEvent[] = [];
      for (let a = from; a <= head; a += STEP_BLOCKS) fresh.push(...await fetchEscrowEvents(c as any, { address: data.escrow, abi: ORDERS_ABI, from: a, to: a + STEP_BLOCKS - 1n > head ? head : a + STEP_BLOCKS - 1n }));
      const withTime = new Set(fresh.map((e) => e.block)).size <= 40 ? await attachTimes(c as any, fresh).catch(() => fresh) : fresh;
      cursor.current = head + 1n;
      if (withTime.length) setEvents((old) => mergeEvents(old, withTime));
      setLive({ state: 'live', block: Number(head), at: new Date().toISOString().slice(11, 19) + ' UTC' });
    } catch (e: any) { setLive((o) => ({ ...o, state: 'error', error: String(e?.shortMessage ?? e?.message ?? e).slice(0, 140) })); }
    finally { busy.current = false; }
  }, [data.escrow]);
  useEffect(() => { void refresh(); const t = setInterval(() => void refresh(), 20_000); return () => clearInterval(t); }, [refresh]);

  const ids = useMemo(() => orderIds(events), [events]);
  const summaries = useMemo(() => ids.map((id) => summarize(id, events)).filter((x): x is OrderSummary => !!x), [ids, events]);
  const p = data.proof; const verifier = data.verifier;

  return (
    <div className="od-stack">
      <div className="od-status" role="status" aria-live="polite" data-testid="orders-live">
        <span><i className={`od-dot ${live.state === 'live' ? 'live' : live.state === 'error' ? 'off' : ''}`} aria-hidden="true" />
          {live.state === 'live' ? `Read from the chain up to block ${live.block} at ${live.at}.` : live.state === 'error' ? `Could not reach the chain (${live.error}). Showing the saved snapshot${data.head ? ` from block ${data.head}` : ''}.` : `Saved snapshot${data.head ? ` from block ${data.head}` : ''}. Checking the chain for newer orders…`}</span>
        <button type="button" className="btn ghost" onClick={() => void refresh()}>Refresh</button>
        <span>Contract <Addr a={data.escrow} /> · verifier <Addr a={verifier} /> · token mUSDG</span>
      </div>

      {summaries.length === 0 && <section className="card"><p className="od-empty">No orders on this contract yet.</p></section>}
      {summaries.map((s) => <OrderCard key={s.id} s={s} events={eventsOfOrder(events, s.id)} data={data} account={account} onDone={() => void refresh()} />)}

      {p && (
        <section className="card" aria-labelledby="od-proof-h">
          <h2 id="od-proof-h" className="od-head">How these orders were produced</h2>
          <div className="od-trust">
            <p>{TRUST.proof}</p>
            <p><b>One operator address plays three roles:</b> it is the escrow verifier, the BlindBook owner that issued the sellers’ test units, and the owner of the mUSDG token that was minted to the wallets. <Addr a={p.operator} /></p>
            <p>{TRUST.token} The ship-to of every order is only a hash of a random salt and a fixed text; no address was entered.</p>
          </div>
          <ul className="od-list" aria-label="Wallets used by the script">
            {Object.entries(p.wallets).map(([k, a]) => <li key={k}><b>{ROLE[k] ?? k}</b> <Addr a={a} /></li>)}
          </ul>
          {p.round && (
            <div className="od-trust">
              <p><b>The price evidence.</b> In BlindBook round {p.round.epoch}, seller A asked {fmtPrice(p.round.sells[0].ask)} and seller B asked {fmtPrice(p.round.sells[1].ask)} per unit, and a bidder offered {fmtPrice(p.round.bid.price)} for {p.round.bid.units} units. The round cleared at one price, {fmtPrice(p.round.price)}, for {p.round.volume} units, and that price is what each order records. There were {p.round.orderCount} sealed orders in the round{p.round.keeperOrders > 0 ? `, ${p.round.keeperOrders} of them from the market’s bot traders` : ''}. Cleared by {p.round.clearedBy}: <TxLink hash={p.round.clearTx} /></p>
            </div>
          )}
          {p.orders.map((o) => (
            <div key={o.id}>
              <h3 className="od-sub"><b>Order #{o.id}</b>: {o.scenario}</h3>
              <ul className="od-list">{o.assertions.map((a) => <li key={a.label}><span className={a.ok ? 'ok' : ''}>{a.ok ? 'Checked' : 'FAILED'}</span> {a.label}: {a.detail}</li>)}</ul>
            </div>
          ))}
          {p.assertions.length > 0 && <div><h3 className="od-sub"><b>Whole run</b></h3><ul className="od-list">{p.assertions.map((a) => <li key={a.label}><span className={a.ok ? 'ok' : ''}>{a.ok ? 'Checked' : 'FAILED'}</span> {a.label}: {a.detail}</li>)}</ul></div>}
          {p.skipped.length > 0 && <p className="od-sub">Not run: {p.skipped.join('; ')}.</p>}
          <details className="od-fold">
            <summary>Every setup and round transaction ({p.setup.length + p.roundSteps.length})</summary>
            <ul className="od-list">{[...p.setup, ...p.roundSteps].sort((a, b) => a.block - b.block).map((t) => <li key={t.tx}><span>{t.label}</span> <TxLink hash={t.tx} /> <span className="muted">block {t.block}</span></li>)}</ul>
          </details>
        </section>
      )}

      <section className="card" aria-labelledby="od-trust-h">
        <h2 id="od-trust-h" className="od-head">What is not trustless</h2>
        <div className="od-trust">
          <p><b>The verifier.</b> {TRUST.verifier} If it goes silent after a shipment, the buyer is refunded and the seller gets only its bond back. If it goes silent after a dispute, the seller is paid.</p>
          <p><b>The verifier’s reach.</b> {TRUST.verifierAddress}</p>
          <p><b>The shipment.</b> {TRUST.shipment}</p>
          <p><b>The ship-to.</b> {TRUST.shipTo}</p>
          <p><b>What matching proves, and what it does not.</b> {TRUST.concept}</p>
          <p>Timeouts, in this deployment: the seller has {fmtDuration(data.windows.accept)} to accept, {fmtDuration(data.windows.ship)} to ship after accepting, the verifier has {fmtDuration(data.windows.verify)} to attest after a shipment and {fmtDuration(data.windows.resolve)} to rule on a dispute, and the buyer can dispute for {fmtDuration(data.windows.dispute)} after a delivery attestation. The seller bond is {data.bondBps / 100}% of the price.</p>
        </div>
      </section>
    </div>
  );
}

