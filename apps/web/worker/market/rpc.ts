// Minimal JSON-RPC client for the market cron: one HTTP request per call list (JSON-RPC batch), hard timeout, results matched by id.
// Errors carry a short code only; upstream bodies are never logged or echoed.
import type { Fetch } from '../env.ts';

export type RpcCall = { method: string; params: unknown[] };
/** `rpcCode` is the numeric JSON-RPC error code when upstream sent an integer one; the upstream message is never copied. */
export class RpcError extends Error {
  code: string;
  rpcCode?: number;
  constructor(code: string, rpcCode?: number) {
    super(code); this.name = 'RpcError'; this.code = code;
    if (rpcCode !== undefined) this.rpcCode = rpcCode;
  }
}
export const RPC_TIMEOUT_MS = 8000;
export const RPC_MAX_BODY_BYTES = 4_000_000;

const errorOf = (error: unknown): RpcError => {
  const c = error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined;
  return new RpcError('RPC_ERROR', typeof c === 'number' && Number.isInteger(c) ? c : undefined);
};

// A hex quantity that does not fit hexInt (32-byte eth_call words) is returned raw; the caller decodes it (parseSchedule).
// The https check on MARKET_RPC_URL lives where the URL is read, not here.
export async function rpcBatch(fetchFn: Fetch, url: string, calls: RpcCall[], timeoutMs = RPC_TIMEOUT_MS): Promise<unknown[]> {
  if (calls.length === 0) return [];
  const body = calls.map((c, i) => ({ jsonrpc: '2.0', id: i + 1, method: c.method, params: c.params }));
  let res: Response;
  try {
    res = await fetchFn(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
  } catch {
    throw new RpcError('RPC_UNREACHABLE');
  }
  const drop = () => { try { void res.body?.cancel().catch(() => {}); } catch { /* body already locked or used */ } };
  if (!res.ok) { drop(); throw new RpcError('RPC_HTTP_' + res.status); }
  if (Number(res.headers.get('content-length')) > RPC_MAX_BODY_BYTES) { drop(); throw new RpcError('RPC_TOO_BIG'); }
  let json: unknown;
  try { json = await res.json(); } catch { throw new RpcError('RPC_BAD_JSON'); }
  if (json && typeof json === 'object' && !Array.isArray(json) && (json as { error?: unknown }).error != null) throw errorOf((json as { error: unknown }).error);
  const list = Array.isArray(json) ? json : [json];
  const byId = new Map<number, Record<string, unknown>>();
  for (const r of list) {
    if (!r || typeof r !== 'object') continue;
    const id = (r as { id?: unknown }).id;
    if (typeof id !== 'number') continue;
    if (byId.has(id)) throw new RpcError('RPC_BAD_JSON');
    byId.set(id, r as Record<string, unknown>);
  }
  return calls.map((_, i) => {
    const r = byId.get(i + 1);
    if (!r) throw new RpcError('RPC_MISSING_RESULT');
    if (r.error !== undefined && r.error !== null) throw errorOf(r.error);
    if (!('result' in r)) throw new RpcError('RPC_MISSING_RESULT');
    return r.result;
  });
}

export const hexOf = (n: number) => {
  if (!Number.isSafeInteger(n) || n < 0) throw new RangeError('hexOf needs a non-negative safe integer');
  return '0x' + n.toString(16);
};
export function hexInt(v: unknown): number {
  if (typeof v !== 'string' || !/^0x[0-9a-fA-F]{1,13}$/.test(v)) return NaN;
  return parseInt(v.slice(2), 16);
}
export const blockCall = (tag: number | 'latest'): RpcCall => ({ method: 'eth_getBlockByNumber', params: [tag === 'latest' ? 'latest' : hexOf(tag), false] });
export const logsCall = (address: string, from: number, to: number, topics: string[]): RpcCall => ({ method: 'eth_getLogs', params: [{ address, fromBlock: hexOf(from), toBlock: hexOf(to), topics: [topics] }] });
/** Selectors of the BlindBook schedule getters (pinned against viem in worker/test/market-rpc.test.ts). */
export const SCHEDULE_SELECTORS = { t0: '0xc116690c', epochLen: '0xd2b3996f', commitEnd: '0x3eee4e27', revealEnd: '0xa6e66477', bond: '0x64c9ec6f' } as const;
export const scheduleCalls = (book: string): RpcCall[] => Object.values(SCHEDULE_SELECTORS).map((data) => ({ method: 'eth_call', params: [{ to: book, data }, 'latest'] }));
