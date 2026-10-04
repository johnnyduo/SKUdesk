// JSON responses, the error envelope and request ids. Same-origin API: no CORS headers are ever emitted.
export type ErrorCode =
  | 'BAD_REQUEST' | 'UNAUTHORIZED' | 'FORBIDDEN_ORIGIN' | 'NOT_FOUND' | 'METHOD_NOT_ALLOWED'
  | 'PAYLOAD_TOO_LARGE' | 'UNSUPPORTED_MEDIA_TYPE' | 'RATE_LIMITED' | 'NOT_CONFIGURED' | 'INTERNAL'
  | 'LINK_NOT_IN_MANIFEST' | 'UNKNOWN_SKU'
  | 'MERCHANT_UNAUTHORIZED' | 'MERCHANT_NOT_REGISTERED' | 'MERCHANT_QUOTA' | 'MERCHANT_INVALID_PRODUCT'
  | 'MERCHANT_NOT_FOUND' | 'MERCHANT_UPSTREAM' | 'FEED_UPSTREAM'
  | 'SNAPSHOT_UNAVAILABLE';

export class HttpError extends Error {
  status: number;
  code: ErrorCode;
  constructor(status: number, code: ErrorCode, message: string) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
  }
}

const BASE_HEADERS: Record<string, string> = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
};

export function newRequestId(): string {
  return crypto.randomUUID();
}

export function json(data: unknown, requestId: string, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...BASE_HEADERS, 'x-request-id': requestId, ...extraHeaders },
  });
}

export function errorResponse(err: unknown, requestId: string): Response {
  if (err instanceof HttpError) {
    const extra: Record<string, string> = err.code === 'RATE_LIMITED' ? { 'retry-after': '60' } : {};
    return json({ error: { code: err.code, message: err.message, requestId } }, requestId, err.status, extra);
  }
  return json({ error: { code: 'INTERNAL', message: 'internal error', requestId } }, requestId, 500);
}
