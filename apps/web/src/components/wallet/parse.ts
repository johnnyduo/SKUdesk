// Pure input parsing for the Owner console. No React, no chain access, so it can be unit tested with node --test.
// Every parser returns { ok: true, ... } or { ok: false, error } with a plain sentence for the field.
import { parseUnits, isAddress, getAddress } from 'viem';

export type Parsed<T> = ({ ok: true } & T) | { ok: false; error: string };
const clean = (s: string) => s.trim().replace(/^\$/, '').replace(/,/g, '');

/** "25.50" dollars -> 2550 cents. At most two decimals, greater than zero. */
export function parseDollars(raw: string): Parsed<{ cents: number }> {
  const s = clean(raw);
  if (!s) return { ok: false, error: 'Enter an amount in dollars.' };
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return { ok: false, error: 'Use dollars with at most two decimals, for example 2500 or 2500.50.' };
  const cents = Math.round(Number(s) * 100);
  if (cents <= 0) return { ok: false, error: 'The amount must be more than $0.' };
  if (cents > 1e12) return { ok: false, error: 'That amount is too large.' };
  return { ok: true, cents };
}

/** "18" or "18.5" percent -> basis points (1800, 1850). Allowed 1% to 90%. */
export function parseMarginPct(raw: string): Parsed<{ bps: number }> {
  const s = raw.trim().replace(/%$/, '').trim();
  if (!s) return { ok: false, error: 'Enter a percentage between 1 and 90.' };
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return { ok: false, error: 'Use a percentage with at most two decimals, for example 18 or 18.5.' };
  const bps = Math.round(Number(s) * 100);
  if (bps < 100 || bps > 9000) return { ok: false, error: 'The margin floor must be between 1% and 90%.' };
  return { ok: true, bps };
}

/** Whole seconds, greater than zero. */
export function parseSeconds(raw: string): Parsed<{ seconds: number }> {
  const s = raw.trim();
  if (!s) return { ok: false, error: 'Enter a number of seconds, for example 180.' };
  if (!/^\d+$/.test(s)) return { ok: false, error: 'Use whole seconds, for example 180.' };
  const seconds = Number(s);
  if (seconds <= 0) return { ok: false, error: 'Quote freshness must be at least 1 second.' };
  if (seconds > 1e9) return { ok: false, error: 'That is too large.' };
  return { ok: true, seconds };
}

/** "1000.5" test dollars -> base units of the 6-decimal token, exact (no floating point). */
export function parseTokenAmount(raw: string): Parsed<{ base: bigint }> {
  const s = clean(raw);
  if (!s) return { ok: false, error: 'Enter an amount in dollars.' };
  if (!/^\d+(\.\d{1,6})?$/.test(s)) return { ok: false, error: 'Use dollars with at most six decimals, for example 250 or 250.75.' };
  const base = parseUnits(s, 6);
  if (base <= 0n) return { ok: false, error: 'The amount must be more than $0.' };
  return { ok: true, base };
}

export function parseAddress(raw: string): Parsed<{ address: `0x${string}` }> {
  const s = raw.trim();
  if (!s) return { ok: false, error: 'Paste a wallet address (starts with 0x).' };
  if (!isAddress(s, { strict: false })) return { ok: false, error: 'That is not a valid address. It should start with 0x and have 40 more characters.' };
  return { ok: true, address: getAddress(s.toLowerCase()) };
}

/** Base units -> plain decimal string for an input box ("5913.5"). */
export function baseToInput(b: bigint): string {
  const whole = b / 1_000_000n; const frac = (b % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : `${whole}`;
}
export const centsToInput = (c: bigint | number) => { const n = BigInt(c); const w = n / 100n; const f = Number(n % 100n); return f === 0 ? `${w}` : `${w}.${String(f).padStart(2, '0')}`; };
export const bpsToInput = (b: bigint | number) => String(Number(b) / 100);
