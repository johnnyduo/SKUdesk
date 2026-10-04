// Every number on the deck is derived here from src/data/run.json. Nothing run-specific is hardcoded.
import runJson from '../../data/run.json';
import { deepMoney, fmtCents, proceedsFacts, BY_CONSTRUCTION } from '../../lib/money';
import snapJson from '../../data/snapshot.json';

export const run = deepMoney(runJson) as any;
for (const e of (run.events ?? []) as any[]) if (typeof e.title === 'string') e.title = e.title.replace(/\(attempt (\d+), [\w.-]+\)/g, '(attempt $1)');

export const REAL_CHAIN = 46630;
export const EXPLORER = 'https://explorer.testnet.chain.robinhood.com';
export const REPO = 'https://github.com/johnnyduo/SKUdesk';

const ni = new Intl.NumberFormat('en-US');
export const usd = fmtCents;
export const int = (n: string | number) => ni.format(Number(n));
/** 1 cent = 10,000 token base units (6 decimals) */
export const fromUnits = (u: string | number) => usd(Number(u) / 10000);
export const pct = (bps: number) => (bps / 100).toFixed(2).replace(/\.?0+$/, '') + '%';
export const short = (h: string, a = 8, b = 6) => (h.length > a + b + 1 ? `${h.slice(0, a)}…${h.slice(-b)}` : h);

const events: any[] = run.events ?? [];
const econ = events.find((e) => e.kind === 'econ')?.data ?? {};
const txEvents = events.filter((e) => e.kind === 'tx' && e.tx);

export const chainId = Number(run.meta.chainId);
export const isReal = chainId === REAL_CHAIN;
export const core: string = run.meta.core;
export const token: string = run.meta.token;
export const model: string = 'AI Agent';
export const durationMs = Number(run.meta.durationMs);
export const addrUrl = (a: string) => (isReal ? `${EXPLORER}/address/${a}` : null);
export const txUrl = (h: string) => (isReal ? `${EXPLORER}/tx/${h}` : null);

const realizedUnits = Number(run.end.totalProceeds) - Number(run.end.totalPaidOut);
const expectedCents = Number(econ.netCents) * Number(econ.units);

export const stats = {
  units: Number(run.accepted.units),
  spend: usd(Number(econ.spendCents)),
  landed: usd(Number(econ.landedCents)),
  netPerUnit: usd(Number(econ.netCents)),
  margin: pct(Number(econ.marginBps)),
  expected: usd(expectedCents),
  realized: fromUnits(realizedUnits),
  realizedMatches: realizedUnits / 10000 === expectedCents,
  proceeds: fromUnits(run.end.totalProceeds),
  paidOut: fromUnits(run.end.totalPaidOut),
  perRunCap: usd(Number(run.policy.maxExec)),
  dailyCap: usd(Number(run.policy.dailySpendCap)),
  marginFloor: pct(Number(run.policy.minMarginBps)),
  ttl: `${run.policy.quoteTTL}s`,
  seconds: (durationMs / 1000).toFixed(1) + 's',
};

export const proceeds = proceedsFacts(run, (snapJson as any).offers);
export { BY_CONSTRUCTION };
export const txs =txEvents.map((e) => ({ title: e.title as string, hash: e.tx.hash as string, status: e.tx.status as string, gas: Number(e.tx.gasUsed) }));
export const txOk = txs.filter((t) => t.status === 'success');
export const txFailed = txs.filter((t) => t.status !== 'success');
export const commitTx = txs.find((t) => /^commitOpportunity/.test(t.title));
export const attacks: { name: string; error: string; sentence: string }[] = (run.attacks ?? []).map((a: any) => ({ name: a.name, error: a.error, sentence: a.sentence }));
export const lie = attacks.find((a) => a.error === 'MathMismatch') ?? attacks[0];
