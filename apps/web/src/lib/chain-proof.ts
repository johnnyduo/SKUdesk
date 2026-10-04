// Live check of the agent run against the public chain: ONE JSON-RPC batch with eth_blockNumber, one
// eth_getTransactionReceipt per run transaction and (optionally) four eth_calls that read the vault's mandate.
// Read-only: no wallet, no key, no gas. No dependencies, so it runs in the browser and in Node tests alike.
// Never throws. Every outcome is an explicit state, and 'unknown' (RPC unreachable, timeout, malformed answer) means
// "could not check right now": it is never presented as a failure of the run.

export type RunTx = { id: number; hash: string; block: number; gasUsed: string; status: string };
export type MandateField = 'maxExec' | 'dailySpendCap' | 'minMarginBps' | 'quoteTTL';
export type ProofInput = {
  rpc: string;
  txs: RunTx[];
  /** Expected sender and contract of every run transaction (the agent and the vault). Omit one to skip that comparison. */
  from?: string;
  to?: string;
  /** Read the mandate from the vault now and compare it with the policy the run used. */
  mandate?: { core: string; policy: Record<MandateField, string> };
};
/** confirmed: succeeded on chain as in the run. reverted: failed on chain exactly as the run says (an expected revert, a match). */
export type TxState = 'confirmed' | 'reverted' | 'mismatch' | 'not-found' | 'unknown';
export type ProofDiff = { field: 'status' | 'block' | 'gasUsed' | 'from' | 'to'; run: string; chain: string };
export type TxProof = { id: number; hash: string; state: TxState; block: number | null; gasUsed: string | null; confirmations: number | null; diffs: ProofDiff[]; reason?: string };
export type MandateProof = { state: 'same' | 'changed' | 'unknown'; fields: { field: MandateField; run: string; chain: string | null }[] };
export type ProofCounts = { total: number; confirmed: number; reverted: number; mismatch: number; notFound: number; unknown: number };
export type ProofReport = { reachable: boolean; head: number | null; checkedAt: number; txs: TxProof[]; counts: ProofCounts; mandate: MandateProof | null; reason?: string };
export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;
export type VerifyOptions = { fetch?: FetchLike; timeoutMs?: number; now?: () => number };

export const PROOF_TIMEOUT_MS = 8000;
export const MANDATE_FIELDS: readonly MandateField[] = ['maxExec', 'dailySpendCap', 'minMarginBps', 'quoteTTL'];
/** 4-byte selectors of the vault's mandate getters (keccak256 of "name()"), pinned against viem in test/site/chain-proof.test.ts. */
export const MANDATE_SELECTORS: Record<MandateField, string> = { maxExec: '0x20d00217', dailySpendCap: '0x492bf73b', minMarginBps: '0xf3985785', quoteTTL: '0xf0593b43' };

const QTY = /^0x[0-9a-fA-F]{1,64}$/;
const WORD = /^0x[0-9a-fA-F]{64}$/;
const HASH = /^0x[0-9a-fA-F]{64}$/;
const ADDR = /^0x[0-9a-fA-F]{40}$/;
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

/** Strict hex quantity ("0x" + 1..64 hex digits) to bigint; anything else to null. */
export function hexQty(v: unknown): bigint | null { return typeof v === 'string' && QTY.test(v) ? BigInt(v) : null; }
const safeNum = (b: bigint | null): number | null => (b !== null && b <= MAX_SAFE ? Number(b) : null);
const dec = (s: string): bigint | null => (/^\d+$/.test(s) ? BigInt(s) : null);

type RpcCall = { jsonrpc: '2.0'; id: number; method: string; params: unknown[] };
type RpcAnswer = { id: number; result?: unknown; error?: unknown };

/** The batch, in a fixed id layout: 1 = head, 2..n+1 = receipts in input order, n+2..n+5 = mandate reads. */
export function buildBatch(input: ProofInput): RpcCall[] {
  const calls: RpcCall[] = [{ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] }];
  input.txs.forEach((t, i) => calls.push({ jsonrpc: '2.0', id: 2 + i, method: 'eth_getTransactionReceipt', params: [t.hash] }));
  const m = input.mandate;
  if (m) MANDATE_FIELDS.forEach((f, k) => calls.push({ jsonrpc: '2.0', id: 2 + input.txs.length + k, method: 'eth_call', params: [{ to: m.core, data: MANDATE_SELECTORS[f] }, 'latest'] }));
  return calls;
}

const blank = (t: RunTx): TxProof => ({ id: t.id, hash: t.hash, state: 'unknown', block: null, gasUsed: null, confirmations: null, diffs: [] });
const unknownTx = (t: RunTx, reason: string): TxProof => ({ ...blank(t), reason });

/** Compares one receipt with the run's own record of that transaction. */
export function judgeReceipt(tx: RunTx, receipt: unknown, head: number | null, expect: { from?: string; to?: string } = {}): TxProof {
  // A node whose head is below the transaction's block has simply not seen it yet (lagging or load-balanced RPC): that is not 'no receipt'.
  if (receipt === null) return head !== null && head < tx.block ? unknownTx(tx, 'rpc behind') : { ...blank(tx), state: 'not-found' };
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) return unknownTx(tx, 'bad receipt');
  const r = receipt as Record<string, unknown>;
  const status = hexQty(r.status);
  const block = safeNum(hexQty(r.blockNumber));
  const gas = hexQty(r.gasUsed);
  const hash = typeof r.transactionHash === 'string' && HASH.test(r.transactionHash) ? r.transactionHash.toLowerCase() : null;
  if ((status !== 0n && status !== 1n) || block === null || gas === null || hash === null) return unknownTx(tx, 'bad receipt');
  if (hash !== tx.hash.toLowerCase()) return unknownTx(tx, 'receipt for another hash');
  const diffs: ProofDiff[] = [];
  // The run must say exactly 'success' or 'reverted'; any other value is a record we do not understand, so it never matches.
  const runStatus = tx.status === 'success' || tx.status === 'reverted' ? tx.status : 'unrecognised';
  const chainOk = status === 1n;
  const chainStatus = chainOk ? 'success' : 'reverted';
  if (runStatus !== chainStatus) diffs.push({ field: 'status', run: runStatus, chain: chainStatus });
  if (block !== tx.block) diffs.push({ field: 'block', run: String(tx.block), chain: String(block) });
  if (dec(tx.gasUsed) !== gas) diffs.push({ field: 'gasUsed', run: tx.gasUsed, chain: gas.toString() });
  for (const field of ['from', 'to'] as const) {
    const want = expect[field]?.toLowerCase();
    if (!want) continue;
    const v = r[field];
    const got = typeof v === 'string' && ADDR.test(v) ? v.toLowerCase() : 'none';
    if (got !== want) diffs.push({ field, run: want, chain: got });
  }
  const confirmations = head !== null && head >= block ? head - block + 1 : null;
  const out = { id: tx.id, hash: tx.hash, block, gasUsed: gas.toString(), confirmations, diffs };
  if (diffs.length) return { ...out, state: 'mismatch' };
  return { ...out, state: chainOk ? 'confirmed' : 'reverted' };
}

/** The mandate now versus the run's policy. Any unreadable field makes the whole comparison unknown. */
export function judgeMandate(policy: Record<MandateField, string>, answers: (RpcAnswer | undefined)[]): MandateProof {
  const fields = MANDATE_FIELDS.map((field, k) => {
    const a = answers[k];
    const chain = a && a.error === undefined && typeof a.result === 'string' && WORD.test(a.result) ? BigInt(a.result).toString() : null;
    return { field, run: String(dec(policy[field]) ?? policy[field]), chain };
  });
  const state = fields.some((f) => f.chain === null) ? 'unknown' : fields.every((f) => f.chain === f.run) ? 'same' : 'changed';
  return { state, fields };
}

export function countTxs(txs: TxProof[]): ProofCounts {
  const c: ProofCounts = { total: txs.length, confirmed: 0, reverted: 0, mismatch: 0, notFound: 0, unknown: 0 };
  for (const t of txs) {
    if (t.state === 'not-found') c.notFound++;
    else c[t.state]++;
  }
  return c;
}

/** Stands in for an id that the reply answered more than once: such an answer cannot be trusted. */
const DUPLICATE: RpcAnswer = { id: -1, error: 'duplicate answer' };

function report(input: ProofInput, answers: Map<number, RpcAnswer> | null, checkedAt: number, reason?: string): ProofReport {
  const headAns = answers?.get(1);
  const head = headAns && headAns.error === undefined ? safeNum(hexQty(headAns.result)) : null;
  const txs = input.txs.map((t, i) => {
    if (!answers) return unknownTx(t, reason ?? 'no answer');
    const a = answers.get(2 + i);
    if (!a) return unknownTx(t, 'no answer');
    if (a === DUPLICATE) return unknownTx(t, 'duplicate answer');
    if (a.error !== undefined || !('result' in a)) return unknownTx(t, 'rpc error');
    return judgeReceipt(t, a.result, head, { from: input.from, to: input.to });
  });
  const mandate = input.mandate ? judgeMandate(input.mandate.policy, MANDATE_FIELDS.map((_, k) => answers?.get(2 + input.txs.length + k))) : null;
  return { reachable: answers !== null, head, checkedAt, txs, counts: countTxs(txs), mandate, ...(reason ? { reason } : {}) };
}

/** Checks the run against the chain. Resolves within timeoutMs (default 8 s) whatever the RPC does, and never rejects. */
export async function verifyRun(input: ProofInput, opts: VerifyOptions = {}): Promise<ProofReport> {
  const now = opts.now ?? Date.now;
  const fetchFn: FetchLike | undefined = opts.fetch ?? (typeof fetch === 'function' ? (fetch.bind(globalThis) as unknown as FetchLike) : undefined);
  if (!input.rpc || !fetchFn) return report(input, null, now(), 'no rpc');
  const ctrl = typeof AbortController === 'function' ? new AbortController() : undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<{ reason: string }>((resolve) => {
    timer = setTimeout(() => { ctrl?.abort(); resolve({ reason: 'timeout' }); }, opts.timeoutMs ?? PROOF_TIMEOUT_MS);
  });
  const call = (async (): Promise<{ reason: string } | { body: unknown }> => {
    const res = await fetchFn(input.rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(buildBatch(input)), signal: ctrl?.signal });
    if (!res.ok) return { reason: Number.isInteger(res.status) && res.status >= 100 && res.status <= 599 ? 'http ' + res.status : 'http error' };
    try { return { body: await res.json() }; } catch { return { reason: 'bad json' }; }
  })().catch(() => ({ reason: 'network' }));
  try {
    const out = await Promise.race([call, timeout]);
    if ('reason' in out) return report(input, null, now(), out.reason);
    if (!Array.isArray(out.body)) return report(input, null, now(), 'not a batch answer');
    const answers = new Map<number, RpcAnswer>();
    for (const a of out.body) {
      if (!a || typeof a !== 'object' || !Number.isInteger((a as RpcAnswer).id)) continue;
      const id = (a as RpcAnswer).id;
      answers.set(id, answers.has(id) ? DUPLICATE : (a as RpcAnswer));
    }
    return report(input, answers, now());
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Runs `job` on demand and applies only the newest result; after stop() nothing is applied and nothing new starts.
 * A job that throws or rejects is skipped: nothing is applied for it, the previous result stays, and check() never throws.
 */
export function latestOnly<T>(job: () => Promise<T>, apply: (v: T) => void): { check(): void; stop(): void } {
  let seq = 0; let stopped = false;
  return {
    check() {
      if (stopped) return;
      const mine = ++seq;
      let started: Promise<T>;
      try { started = job(); } catch { return; }
      started.then((v) => { if (!stopped && mine === seq) apply(v); }, () => {});
    },
    stop() { stopped = true; },
  };
}

/* provenance helpers (when and where the run happened) */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const two = (n: number) => String(n).padStart(2, '0');
/** "2 Oct 2026, 15:17 UTC": a fixed format, independent of the viewer's locale; '' for an invalid date. */
export function runDateText(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${two(d.getUTCHours())}:${two(d.getUTCMinutes())} UTC`;
}
/** First and last block of the run's transactions; null when there are none. */
export function blockSpan(txs: Pick<RunTx, 'block'>[]): { first: number; last: number } | null {
  if (!txs.length) return null;
  const b = txs.map((t) => t.block);
  return { first: Math.min(...b), last: Math.max(...b) };
}
/** "14:54:36 UTC" for a timestamp in ms. */
export function clockText(ms: number): string {
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? '' : `${two(d.getUTCHours())}:${two(d.getUTCMinutes())}:${two(d.getUTCSeconds())} UTC`;
}
export const proofFor = (r: ProofReport | null, hash: string): TxProof | undefined => r?.txs.find((t) => t.hash.toLowerCase() === hash.toLowerCase());
