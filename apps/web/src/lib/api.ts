// Browser client for this site's same-origin /api (Cloudflare Worker). Never stores credentials:
// the operator token is passed per call from component memory.
import type { CompareResult, DeleteResponse, DryRunResponse, ListingStatusResponse, MerchantStatus, PublishResponse, SourcesResponse, V4PoolResponse } from '../../worker/api-types.ts';

export type { CompareResult, DeleteResponse, DryRunResponse, ListingStatusResponse, MerchantStatus, PublishResponse, SourcesResponse, V4PoolResponse };
export type ApiError = { code: string; message: string; requestId: string | null };
export type ApiResult<T> = { ok: true; status: number; data: T } | { ok: false; status: number; offline: boolean; error: ApiError };
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
export type ListingBody = {
  lotId: string; title: string; link: string; imageLink: string; priceCents: number;
  brand?: string; gtin?: string; description?: string; dryRun: boolean;
};

export async function apiCall<T>(path: string, init: RequestInit = {}, fetchImpl: FetchLike = (i, o) => fetch(i, o), timeoutMs = 15_000): Promise<ApiResult<T>> {
  // Only the path portion (before '?' or '#') is checked: a query value such as q=a..b is legitimate data.
  const pathOnly = path.split(/[?#]/, 1)[0];
  if (!path.startsWith('/api/') || pathOnly.includes('..') || /%2e/i.test(pathOnly)) {
    return { ok: false, status: 0, offline: false, error: { code: 'BAD_REQUEST', message: 'only same-origin /api/ paths are allowed', requestId: null } };
  }
  let res: Response;
  try {
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = init.signal ? (typeof AbortSignal.any === 'function' ? AbortSignal.any([init.signal, timeout]) : init.signal) : timeout;
    res = await fetchImpl(path, { ...init, signal, credentials: 'same-origin' });
  } catch {
    return { ok: false, status: 0, offline: true, error: { code: 'OFFLINE', message: 'API unreachable', requestId: null } };
  }
  const type = res.headers.get('content-type') ?? '';
  if (!type.includes('application/json')) {
    return { ok: false, status: res.status, offline: true, error: { code: 'OFFLINE', message: 'API not deployed here (HTTP ' + res.status + ')', requestId: null } };
  }
  const body = (await res.json().catch(() => null)) as unknown;
  if (res.ok) {
    if (body === null || body === undefined) return { ok: false, status: res.status, offline: false, error: { code: 'BAD_RESPONSE', message: 'API returned an unreadable response', requestId: null } };
    return { ok: true, status: res.status, data: body as T };
  }
  const e = (body as { error?: { code?: unknown; message?: unknown; requestId?: unknown } } | null)?.error;
  return {
    ok: false, status: res.status, offline: false,
    error: { code: typeof e?.code === 'string' ? e.code : 'HTTP_' + res.status, message: typeof e?.message === 'string' ? e.message : 'request failed', requestId: typeof e?.requestId === 'string' ? e.requestId : null },
  };
}

const withToken = (token: string | undefined): Record<string, string> => (token ? { 'x-admin-token': token } : {});

export function createApi(fetchImpl?: FetchLike) {
  return {
    merchantStatus: () => apiCall<MerchantStatus>('/api/merchant/status', {}, fetchImpl),
    publishListing: (body: ListingBody, token?: string) =>
      apiCall<DryRunResponse | PublishResponse>('/api/merchant/listing', { method: 'POST', headers: { 'content-type': 'application/json', ...withToken(token) }, body: JSON.stringify(body) }, fetchImpl),
    listingStatus: (offerId: string) => apiCall<ListingStatusResponse>('/api/merchant/listing/' + encodeURIComponent(offerId), {}, fetchImpl),
    deleteListing: (offerId: string, token: string) =>
      apiCall<DeleteResponse>('/api/merchant/listing/' + encodeURIComponent(offerId), { method: 'DELETE', headers: withToken(token) }, fetchImpl),
    v4Pool: () => apiCall<V4PoolResponse>('/api/v4/pool', {}, fetchImpl),
    priceSources: () => apiCall<SourcesResponse>('/api/prices/sources', {}, fetchImpl),
    compare: (p: { sku?: string; gtin?: string; q?: string }) => {
      const qs = new URLSearchParams();
      if (p.sku) qs.set('sku', p.sku);
      if (p.gtin) qs.set('gtin', p.gtin);
      if (p.q) qs.set('q', p.q);
      return apiCall<CompareResult>('/api/prices/compare?' + qs.toString(), {}, fetchImpl);
    },
  };
}

export const api = createApi();
