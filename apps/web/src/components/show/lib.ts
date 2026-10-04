// Pure helpers for "The Show". Nothing here hardcodes values from a particular run:
// every number, address and hash is read from src/data/run.json and snapshot.json.
import runJson from '../../data/run.json';
import { deepMoney, fmtCents, proceedsFacts, BY_CONSTRUCTION } from '../../lib/money';
import snapJson from '../../data/snapshot.json';
import { blockSpan, runDateText } from '../../lib/chain-proof';

export interface Tx { hash: string; block: number; gasUsed: string; status: string }
export interface Ev { id: number; at: number; kind: string; title: string; detail?: string; data?: any; tx?: Tx }
export interface Run { meta: any; policy: any; accepted: any; attacks: any[]; end: any; events: Ev[] }

export const run = deepMoney(runJson) as unknown as Run;
for (const e of ((run as any).events ?? []) as any[]) if (typeof e.title === 'string') e.title = e.title.replace(/\(attempt (\d+), [\w.-]+\)/g, '(attempt $1)');
export const snapshot = snapJson as any;

/* Network / explorer */
export const REAL_CHAIN = 46630;
const EXPLORER = 'https://explorer.testnet.chain.robinhood.com';

export function netInfo(chainId: number) {
  if (chainId === REAL_CHAIN) return { name: 'Robinhood Chain Testnet', short: 'Robinhood Chain Testnet', real: true };
  if (chainId === 31337) return { name: 'LOCAL DEV FIXTURE - NOT THE REAL RUN', short: 'LOCAL DEV FIXTURE', real: false };
  return { name: `UNKNOWN CHAIN ${chainId} - NOT THE REAL RUN`, short: `CHAIN ${chainId}`, real: false };
}
export const net = netInfo(Number(run.meta.chainId));
export const txUrl = (hash: string) => (net.real ? `${EXPLORER}/tx/${hash}` : null);
export const addrUrl = (addr: string) => (net.real ? `${EXPLORER}/address/${addr}` : null);

/* Provenance: when and where the run happened (shown on first paint) */
const runTxs = run.events.filter((e) => e.tx).map((e) => e.tx!);
const span = blockSpan(runTxs);
export const provenance = { date: runDateText(String(run.meta.startedAt)), first: span?.first ?? null, last: span?.last ?? null, txCount: runTxs.length };
export const eyebrowLine = (real: boolean, name: string, shortName: string, date: string) =>
  real ? ['ON-CHAIN RUN', name, date].filter(Boolean).join(' · ') : `${shortName} · not the public run`;
export const eyebrowText = eyebrowLine(net.real, net.name, net.short, provenance.date);
/** The one place that words the chain check. It only claims an attempt (true without JavaScript or with the RPC down) and says nothing for a run with no transactions. */
export const EXPLORER_NOTE = 'The explorer links work without that.';
export const checkClaim = (txCount: number) => {
  if (!(txCount > 0)) return { clause: '', sentence: '' };
  const clause = `tries to check its ${txCount} ${txCount === 1 ? 'transaction' : 'transactions'} against the public RPC when you open it`;
  return { clause, sentence: `It ${clause}. ${EXPLORER_NOTE}` };
};
/** The sentence after "Run on <network>, <date>." for the real run. */
export const runNote = (p: { first: number | null; last: number | null; txCount: number }) => {
  const { clause } = checkClaim(p.txCount);
  return (p.first === null || p.last === null ? '' : `Blocks ${p.first.toLocaleString('en-US')} to ${p.last.toLocaleString('en-US')}. `) +
    (clause ? `Not live: this page walks through a finished run and ${clause}. ${EXPLORER_NOTE}` : 'Not live: this page walks through a finished run.');
};

/* Formatting */
const ni = new Intl.NumberFormat('en-US');
export const usd = fmtCents;
export const proceeds = proceedsFacts(run, (snapJson as any).offers);
export { BY_CONSTRUCTION };
/** token base units (6 decimals, 1 cent = 10,000 units) -> dollars */
export const fromUnits = (u: string | number) => usd(Number(u) / 10000);
export const pct = (bps: number) => (bps / 100).toFixed(2).replace(/\.?0+$/, '') + '%';
export const int = (n: string | number) => ni.format(Number(n));
export const short = (h: string, a = 10, b = 8) => (h.length > a + b + 1 ? `${h.slice(0, a)}…${h.slice(-b)}` : h);
export const humanize = (s: string) => s.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, (c) => c.toUpperCase());

/* Static glossary (plain-language, not run data) */
export const ATTESTED = ['markReceived', 'markListed', 'markSold'];
export const FN_GLOSS: Record<string, string> = {
  markReceived: 'Agent says the goods arrived',
  markListed: 'Agent says the goods are listed for sale',
  markSold: 'Agent says the goods sold',
};
export const ERR_GLOSS: Record<string, string> = {
  MathMismatch: 'The contract re-ran the agent’s arithmetic from the quote. The numbers did not match, so the transaction was refused.',
  SpendCap: 'The contract works out the spend itself and compares it with the owner’s cap. Over the cap means no money moves.',
  Replay: 'The opportunity id is derived on-chain from the product, quote and snapshot hashes, so sending the same one again is refused. The agent supplies the snapshot hash, so the caps, not the id, limit how often the same quote can be committed.',
  Stale: 'A quote the agent dates as older than the owner’s freshness window is refused. The agent supplies that date, so this limits the age of its own claim, not the real age of the source data.',
  BadQuoteHash: 'The agent committed to a quote by its fingerprint (hash). Submitting a different quote breaks the fingerprint.',
  PayeeNotAllowed: 'Escrow can only be paid to addresses the owner approved. The agent cannot route money to itself.',
};

/* Script: events -> ordered playback steps */
export const STAGES = [
  { long: 'Mandate', short: 'Mandate' },
  { long: 'Agent thinks', short: 'Thinks' },
  { long: 'Gates verify', short: 'Gates' },
  { long: 'Contract commits', short: 'Commits' },
  { long: 'Refusals', short: 'Refusals' },
  { long: 'Settlement', short: 'Settle' },
];

export interface Step {
  i: number;
  stage: number;
  kind: string; // policy | snapshot | agent | reason | gate | econ | tx | revert | state
  ev: Ev;
  dwell: number; // ms at 1x, shown after the step becomes current
  fn?: string; // contract function name for tx steps
  isProposal?: boolean;
  isAttack?: boolean; // revert event OR failed tx
  isFailedTx?: boolean;
  isBig?: boolean; // the "agent lies" moment
}

const isReverted = (e: Ev) => e.kind === 'tx' && e.tx?.status === 'reverted';
const isAttackEv = (e: Ev) => e.kind === 'revert' || isReverted(e);
export const fnOf = (e: Ev) => (e.kind === 'tx' && !isReverted(e) ? e.title.match(/^[A-Za-z]\w*/)?.[0] : undefined);

export function buildScript(r: Run): Step[] {
  const evs = r.events;
  const attackEvs = evs.filter(isAttackEv);
  const rest = evs.filter((e) => !isAttackEv(e));
  const hasAtk = attackEvs.length > 0;
  const firstAtk = evs.findIndex(isAttackEv);
  const insertAt = hasAtk ? evs.slice(0, firstAtk).length : rest.length;

  // Crescendo: lesser attacks first, the inflated-profit claim (MathMismatch) last among reverts,
  // then the real failed transaction that belongs to it.
  const big = (e: Ev) => e.kind === 'revert' && e.data?.error === 'MathMismatch';
  const orderedAtk = [
    ...attackEvs.filter((e) => e.kind === 'revert' && !big(e)),
    ...attackEvs.filter(big),
    ...attackEvs.filter(isReverted),
  ];
  let seq: Ev[] = [...rest.slice(0, insertAt), ...orderedAtk, ...rest.slice(insertAt)];

  // Show the agent's reasoning first, then the proposal card that summarises it.
  const pIdx = seq.findIndex((e) => e.kind === 'agent' && e.data?.proposal);
  if (pIdx >= 0) {
    const [p] = seq.splice(pIdx, 1);
    let lastReason = -1;
    seq.forEach((e, i) => { if (e.kind === 'reason') lastReason = i; });
    seq.splice(lastReason >= 0 ? lastReason + 1 : pIdx, 0, p);
  }

  const firstAtkSeq = seq.findIndex(isAttackEv);
  return seq.map((ev, i) => {
    const isAttack = isAttackEv(ev);
    let stage = 0;
    let dwell = 3000;
    switch (ev.kind) {
      case 'policy': stage = 0; dwell = 4600; break;
      case 'snapshot': stage = 0; dwell = 4000; break;
      case 'agent': stage = 1; dwell = ev.data?.proposal ? 4200 : 2200; break;
      case 'reason': stage = 1; dwell = ev.title.length * 14 + 1000; break;
      case 'gate': stage = 2; dwell = 4000; break;
      case 'econ': stage = 2; dwell = 900 + (ev.data?.proof?.length ?? 4) * 750 + 2200; break;
      case 'revert': stage = 4; dwell = big(ev) ? 10000 : 4200; break;
      case 'state': stage = 5; dwell = 8000; break;
      case 'tx':
        if (isReverted(ev)) { stage = 4; dwell = 5200; }
        else {
          dwell = 3000;
          if (firstAtkSeq >= 0) stage = i < firstAtkSeq ? 3 : 5;
          else stage = /^(commit|mint|fund)/i.test(ev.title) ? 3 : 5;
        }
        break;
      default: stage = 1;
    }
    return {
      i, stage, kind: ev.kind, ev, dwell,
      fn: fnOf(ev),
      isProposal: ev.kind === 'agent' && !!ev.data?.proposal,
      isAttack,
      isFailedTx: isReverted(ev),
      isBig: big(ev),
    };
  });
}

/* Money */
export function deriveMoney(r: Run) {
  const pol = r.events.find((e) => e.kind === 'policy');
  const econ = r.events.find((e) => e.kind === 'econ');
  const start = Number(pol?.data?.vaultFree ?? 0);
  const spend = econ?.data?.spendCents != null ? Number(econ.data.spendCents) * 10000 : Number(r.end.totalPaidOut);
  const proceeds = Number(r.end.totalProceeds);
  const end = { free: Number(r.end.free), escrow: Number(r.end.totalEscrow), paid: Number(r.end.totalPaidOut) };
  return { start, spend, proceeds, end, total: Math.max(end.free + end.escrow + end.paid, start, 1) };
}

export interface Vault { free: number; escrow: number; paid: number; proceeds: number }

/** Applies the visible steps to the vault. The closing state event snaps to the end values stored with the run. */
export function vaultAt(steps: Step[], cur: number, m: ReturnType<typeof deriveMoney>): Vault {
  let v: Vault = { free: m.start, escrow: 0, paid: 0, proceeds: 0 };
  for (let i = 0; i <= cur && i < steps.length; i++) {
    const s = steps[i];
    const f = (s.fn ?? '').toLowerCase();
    if (s.kind === 'tx' && !s.isFailedTx) {
      if (f === 'fundlot') { v.free -= m.spend; v.escrow += m.spend; }
      else if (f === 'markpurchased') { v.escrow -= m.spend; v.paid += m.spend; }
      else if (f === 'settle') { v.proceeds = m.proceeds; v.free += m.proceeds; }
    } else if (s.kind === 'state' && s.ev.data) {
      const d = s.ev.data;
      v = { free: Number(d.free), escrow: Number(d.totalEscrow), paid: Number(d.totalPaidOut), proceeds: Number(d.totalProceeds) };
    }
  }
  return v;
}
