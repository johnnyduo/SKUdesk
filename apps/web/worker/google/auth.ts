// Google access token for the service account: JWT-bearer exchange, cached in KV.
import type { Fetch } from '../env.ts';
import { HttpError } from '../http.ts';
import { sha256Hex } from '../security.ts';
import { GOOGLE_TOKEN_URL, MERCHANT_SCOPE, buildJwtClaims, parseServiceAccount, signJwtRS256 } from './jwt.ts';

export type TokenKV = {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
};
export type GoogleTokenOpts = { saJson: string | undefined; kv: TokenKV; fetch: Fetch; nowMs: number; forceRefresh?: boolean };

export async function tokenCacheKey(clientEmail: string): Promise<string> {
  return 'gtoken:v1:' + (await sha256Hex(clientEmail)).slice(0, 24);
}

// KV rejects expirationTtl < 60, so short-lived tokens are cached for 60 s minimum and refreshed early otherwise.
export function tokenTtlSeconds(expiresIn: number): number {
  return Math.max(60, Math.floor(expiresIn) - 300);
}

export async function getGoogleAccessToken(o: GoogleTokenOpts): Promise<string> {
  const sa = parseServiceAccount(o.saJson);
  const key = await tokenCacheKey(sa.client_email);
  if (!o.forceRefresh) {
    const cached = await o.kv.get(key);
    if (cached) return cached;
  }
  const assertion = await signJwtRS256(buildJwtClaims(sa, MERCHANT_SCOPE, Math.floor(o.nowMs / 1000)), sa.private_key);
  let res: Response;
  try {
    res = await o.fetch(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }).toString(),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new HttpError(502, 'MERCHANT_UPSTREAM', 'Google token endpoint unreachable or timed out');
  }
  if (!res.ok) throw new HttpError(502, 'MERCHANT_UNAUTHORIZED', 'Google token exchange failed (HTTP ' + res.status + ')');
  let body: { access_token?: unknown; expires_in?: unknown } | null;
  try {
    body = (await res.json()) as { access_token?: unknown; expires_in?: unknown } | null;
  } catch {
    throw new HttpError(502, 'MERCHANT_UPSTREAM', 'Google token response was not JSON');
  }
  if (typeof body?.access_token !== 'string' || typeof body.expires_in !== 'number') {
    throw new HttpError(502, 'MERCHANT_UNAUTHORIZED', 'Google token response malformed');
  }
  // A failed cache write must not fail a request whose token exchange already succeeded.
  try {
    await o.kv.put(key, body.access_token, { expirationTtl: tokenTtlSeconds(body.expires_in) });
  } catch {
    // ignore: the next request simply re-exchanges
  }
  return body.access_token;
}

export async function dropGoogleToken(kv: TokenKV, saJson: string | undefined): Promise<void> {
  const sa = parseServiceAccount(saJson);
  await kv.delete(await tokenCacheKey(sa.client_email));
}
