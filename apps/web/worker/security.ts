// Security helpers: admin token check, same-origin policy for writes, rate limiting, safe body parsing.
import { HttpError } from './http.ts';
import { log } from './log.ts';

export const MIN_ADMIN_TOKEN_LENGTH = 32;
export const MAX_BODY_BYTES = 16 * 1024;

const enc = new TextEncoder();

async function sha256Bytes(s: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(s)));
}

export async function sha256Hex(s: string): Promise<string> {
  return Array.from(await sha256Bytes(s), (b) => b.toString(16).padStart(2, '0')).join('');
}

// Constant-time string compare: hash both sides to fixed-length digests, then XOR-accumulate every byte.
export async function timingSafeEqualStr(a: string, b: string): Promise<boolean> {
  const [x, y] = await Promise.all([sha256Bytes(a), sha256Bytes(b)]);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

// True only when ADMIN_TOKEN is configured with >= 32 chars and the X-Admin-Token header matches it.
export async function isAdmin(req: Request, adminToken: string | undefined): Promise<boolean> {
  if (!adminToken || adminToken.length < MIN_ADMIN_TOKEN_LENGTH) return false;
  const presented = req.headers.get('x-admin-token');
  if (!presented) return false;
  return timingSafeEqualStr(presented, adminToken);
}

// State-changing requests must come from our own pages (or from a non-browser client such as curl).
export function checkOrigin(req: Request, siteOrigin: string): boolean {
  const method = req.method.toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return true;
  const allowed = new Set([siteOrigin.replace(/\/+$/, ''), new URL(req.url).origin]);
  const origin = req.headers.get('origin');
  if (origin !== null) return allowed.has(origin);
  const site = req.headers.get('sec-fetch-site');
  return site === null || site === 'same-origin' || site === 'none';
}

export function assertOrigin(req: Request, siteOrigin: string): void {
  if (!checkOrigin(req, siteOrigin)) throw new HttpError(403, 'FORBIDDEN_ORIGIN', 'cross-origin request rejected');
}

export type Limiter = { limit(opts: { key: string }): Promise<{ success: boolean }> };

// Rate-limit key: route + (admin token hash | client IP). The binding is a cost brake, not the security boundary.
export async function rateKey(req: Request, route: string, admin: boolean): Promise<string> {
  if (admin) return route + ':adm:' + (await sha256Hex(req.headers.get('x-admin-token') ?? '')).slice(0, 16);
  return route + ':ip:' + (req.headers.get('cf-connecting-ip') ?? 'unknown');
}

let warnedMissingLimiter = false;
export function resetLimiterWarning(): void { warnedMissingLimiter = false; }

// A missing binding fails open (the limiter is a cost brake, not the security boundary) but is logged once per isolate.
export async function enforceRateLimit(limiter: Limiter | undefined, key: string): Promise<void> {
  if (!limiter) {
    if (!warnedMissingLimiter) {
      warnedMissingLimiter = true;
      log({ event: 'rate_limiter_missing', level: 'warn' });
    }
    return;
  }
  const { success } = await limiter.limit({ key });
  if (!success) throw new HttpError(429, 'RATE_LIMITED', 'too many requests');
}

// JSON-only, <= 16 KB, parsed once. Never echoes the body back in errors.
// The body is read through a byte counter so an unbounded (chunked) upload is cancelled at the cap, never buffered.
export async function readJsonBody(req: Request, maxBytes: number = MAX_BODY_BYTES): Promise<unknown> {
  const type = (req.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
  if (type !== 'application/json') throw new HttpError(415, 'UNSUPPORTED_MEDIA_TYPE', 'content-type must be application/json');
  const lengthHeader = req.headers.get('content-length');
  if (lengthHeader !== null) {
    if (!/^\d+$/.test(lengthHeader)) throw new HttpError(400, 'BAD_REQUEST', 'invalid content-length');
    if (Number(lengthHeader) > maxBytes) throw new HttpError(413, 'PAYLOAD_TOO_LARGE', 'body exceeds ' + maxBytes + ' bytes');
  }
  const tooLarge = () => new HttpError(413, 'PAYLOAD_TOO_LARGE', 'body exceeds ' + maxBytes + ' bytes');
  const chunks: Uint8Array[] = [];
  let total = 0;
  if (req.body) {
    const reader = req.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw tooLarge();
      }
      chunks.push(value);
    }
  }
  const buf = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { buf.set(c, off); off += c.byteLength; }
  try {
    return JSON.parse(new TextDecoder().decode(buf));
  } catch {
    throw new HttpError(400, 'BAD_REQUEST', 'body is not valid JSON');
  }
}
