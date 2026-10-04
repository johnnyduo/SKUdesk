// Typed Merchant API v1 fetch wrapper: auth header, timeout, retry with backoff + jitter, error mapping.
import type { Fetch } from '../env.ts';
import { HttpError } from '../http.ts';
import { log } from '../log.ts';

export type MerchantMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE';
export type MerchantRequest = { method: MerchantMethod; path: string; query?: Record<string, string>; body?: unknown };
export type MerchantResult<T> = { status: number; data: T; latencyMs: number; attempts: number };
export type MerchantClientOpts = {
  base: string;
  getToken: (forceRefresh: boolean) => Promise<string>;
  fetch: Fetch;
  sleep: (ms: number) => Promise<void>;
  random: () => number;
  nowMs: () => number;
  maxRetries?: number;
  timeoutMs?: number;
};
export type MerchantClient = { request<T>(r: MerchantRequest): Promise<MerchantResult<T>> };

const NOT_REGISTERED = /is not registered with the merchant account/i;

export function backoffMs(attempt: number, random: () => number): number {
  return Math.min(4000, 250 * 2 ** attempt) + Math.floor(random() * 250);
}

function googleMessage(body: unknown): string {
  const e = (body as { error?: { message?: unknown } } | null)?.error;
  const msg = typeof e?.message === 'string' ? e.message : '';
  return msg.replace(/\s+/g, ' ').slice(0, 200);
}

const FIELD_PATH = /^[\w.[\]]{1,80}$/;

// Google's 400 text is never echoed (it can quote request content). Only field paths from
// error.details[].fieldViolations[].field are surfaced, and only when they look like a plain path.
function violationFields(body: unknown): string[] {
  const details = (body as { error?: { details?: unknown } } | null)?.error?.details;
  if (!Array.isArray(details)) return [];
  const out: string[] = [];
  for (const d of details) {
    const fv = (d as { fieldViolations?: unknown } | null)?.fieldViolations;
    if (!Array.isArray(fv)) continue;
    for (const v of fv) {
      const f = (v as { field?: unknown } | null)?.field;
      if (typeof f === 'string' && FIELD_PATH.test(f) && !out.includes(f) && out.length < 5) out.push(f);
    }
  }
  return out;
}

// Maps a final (non-retried) Google error to our envelope with static messages (no upstream text).
export function mapGoogleError(status: number, body: unknown): HttpError {
  const msg = googleMessage(body);
  if (NOT_REGISTERED.test(msg)) return new HttpError(502, 'MERCHANT_NOT_REGISTERED', 'GCP project is not registered with the Merchant Center account; run the setup script (register step) and wait 5 minutes');
  if (status === 401 || status === 403) return new HttpError(502, 'MERCHANT_UNAUTHORIZED', 'Merchant API rejected the credentials (HTTP ' + status + '); check the service account is an Admin user on the account');
  if (status === 404) return new HttpError(404, 'MERCHANT_NOT_FOUND', 'Merchant resource not found');
  if (status === 429) return new HttpError(503, 'MERCHANT_QUOTA', 'Merchant API quota exhausted; retry later');
  if (status === 400) {
    const fields = violationFields(body);
    return new HttpError(422, 'MERCHANT_INVALID_PRODUCT', 'Merchant API rejected the request' + (fields.length ? ' (fields: ' + fields.join(', ') + ')' : ''));
  }
  return new HttpError(502, 'MERCHANT_UPSTREAM', 'Merchant API error (HTTP ' + status + ')');
}

function buildUrl(base: string, r: MerchantRequest): string {
  const url = new URL(base.replace(/\/+$/, '') + r.path);
  for (const [k, v] of Object.entries(r.query ?? {})) url.searchParams.set(k, v);
  return url.toString();
}

async function readBody(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return {};
  try { return JSON.parse(text); } catch { return {}; }
}

// A 2xx body. Only a deletion (or a 204) may legitimately carry no body; everywhere else a body that is
// not a JSON object means the answer is unusable, so it is a static upstream error, never a silent {}.
async function readSuccessBody(res: Response, method: MerchantMethod): Promise<unknown> {
  let text = '';
  let unreadable = false;
  try { text = await res.text(); } catch { unreadable = true; }
  if (res.status === 204 || method === 'DELETE') {
    // Callers of DELETE ignore the body (the 2xx is the result), so any body is tolerated there.
    try { return text ? JSON.parse(text) : {}; } catch { return {}; }
  }
  try {
    const parsed: unknown = unreadable ? null : JSON.parse(text);
    if (typeof parsed === 'object' && parsed !== null) return parsed;
  } catch {
    // fall through to the static error
  }
  throw new HttpError(502, 'MERCHANT_UPSTREAM', 'Merchant API returned an unreadable response (HTTP ' + res.status + ')');
}

export function createMerchantClient(o: MerchantClientOpts): MerchantClient {
  const maxRetries = o.maxRetries ?? 3;
  const timeoutMs = o.timeoutMs ?? 10_000;
  return {
    async request<T>(r: MerchantRequest): Promise<MerchantResult<T>> {
      const url = buildUrl(o.base, r);
      const started = o.nowMs();
      let refreshed = false;
      let force = false;
      let attempt = 0;
      for (;;) {
        // forceRefresh applies only to the first call after a 401, not to later retries.
        const token = await o.getToken(force);
        force = false;
        const headers: Record<string, string> = { authorization: 'Bearer ' + token, accept: 'application/json' };
        if (r.body !== undefined) headers['content-type'] = 'application/json';
        let res: Response | null = null;
        try {
          res = await o.fetch(url, { method: r.method, headers, body: r.body === undefined ? undefined : JSON.stringify(r.body), signal: AbortSignal.timeout(timeoutMs) });
        } catch {
          res = null;
        }
        // Upstream calls log status and latency only (never the URL, body or token).
        log({ event: 'upstream', upstream: 'merchant', method: r.method, upstreamStatus: res ? res.status : 0, latencyMs: o.nowMs() - started, attempt });
        if (res && res.ok) {
          return { status: res.status, data: (await readSuccessBody(res, r.method)) as T, latencyMs: o.nowMs() - started, attempts: attempt + 1 };
        }
        const status = res ? res.status : 0;
        const body = res ? await readBody(res) : {};
        if (status === 401 && !refreshed && !NOT_REGISTERED.test(googleMessage(body))) {
          refreshed = true;
          force = true;
          continue;
        }
        const retryable = status === 0 || status === 429 || status >= 500;
        if (retryable && attempt < maxRetries) {
          await o.sleep(backoffMs(attempt, o.random));
          attempt++;
          continue;
        }
        if (status === 0) throw new HttpError(504, 'MERCHANT_UPSTREAM', 'Merchant API unreachable or timed out');
        throw mapGoogleError(status, body);
      }
    },
  };
}
