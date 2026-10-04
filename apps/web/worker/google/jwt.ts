// Service-account JWT (RS256) built and signed with WebCrypto. Pure apart from crypto.subtle.
// Spec: https://developers.google.com/identity/protocols/oauth2/service-account (HTTP/REST section).
import { HttpError } from '../http.ts';

export type ServiceAccount = { client_email: string; private_key: string };
export type JwtClaims = { iss: string; scope: string; aud: string; iat: number; exp: number };

export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const MERCHANT_SCOPE = 'https://www.googleapis.com/auth/content';

export function parseServiceAccount(raw: string | undefined): ServiceAccount {
  if (!raw) throw new HttpError(503, 'NOT_CONFIGURED', 'GOOGLE_SA_JSON is not set');
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new HttpError(503, 'NOT_CONFIGURED', 'GOOGLE_SA_JSON is not valid JSON'); }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new HttpError(503, 'NOT_CONFIGURED', 'GOOGLE_SA_JSON must be a JSON object');
  const o = parsed as Record<string, unknown>;
  if (typeof o.client_email !== 'string' || typeof o.private_key !== 'string') {
    throw new HttpError(503, 'NOT_CONFIGURED', 'GOOGLE_SA_JSON lacks client_email/private_key');
  }
  // Keys pasted through shells sometimes keep literal "\n" sequences; normalize them to newlines.
  return { client_email: o.client_email, private_key: o.private_key.replace(/\\n/g, '\n') };
}

export function buildJwtClaims(sa: ServiceAccount, scope: string, nowSec: number): JwtClaims {
  return { iss: sa.client_email, scope, aud: GOOGLE_TOKEN_URL, iat: nowSec, exp: nowSec + 3600 };
}

export function base64url(input: Uint8Array | string): string {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const NOT_PKCS8 = 'service account private_key is not a valid PKCS#8 PEM key';

export function pemToPkcs8(pem: string): ArrayBuffer {
  const b64 = pem.replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s+/g, '');
  if (!b64) throw new HttpError(503, 'NOT_CONFIGURED', 'service account private_key is empty');
  // PKCS#1 ("BEGIN RSA PRIVATE KEY") or any other framing leaves '-' / spaces behind and is refused here.
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) throw new HttpError(503, 'NOT_CONFIGURED', NOT_PKCS8);
  let bin: string;
  try { bin = atob(b64); } catch { throw new HttpError(503, 'NOT_CONFIGURED', NOT_PKCS8); }
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

// Failures here are configuration errors: messages are static and never carry key material.
export async function signJwtRS256(claims: JwtClaims, privateKeyPem: string): Promise<string> {
  const der = pemToPkcs8(privateKeyPem);
  let key: CryptoKey;
  try {
    key = await crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  } catch {
    throw new HttpError(503, 'NOT_CONFIGURED', NOT_PKCS8);
  }
  const unsigned = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' })) + '.' + base64url(JSON.stringify(claims));
  let sig: ArrayBuffer;
  try {
    sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(unsigned));
  } catch {
    throw new HttpError(503, 'NOT_CONFIGURED', NOT_PKCS8);
  }
  return unsigned + '.' + base64url(new Uint8Array(sig));
}
