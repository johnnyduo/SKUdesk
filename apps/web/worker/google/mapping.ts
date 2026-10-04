// Listing request validation and lot/offer -> Merchant API v1 ProductInput mapping. Pure.
// Field names: https://developers.google.com/merchant/api/reference/rest/products_v1/ProductAttributes
import type { Availability, Condition, ProductAttributes, ProductInputBody } from '../api-types.ts';
import { isValidGtin } from '../gtin.ts';
import { HttpError } from '../http.ts';
import { sha256Hex } from '../security.ts';

export type ListingRequest = {
  lotId: string;
  offerId: string;
  title: string;
  description: string | null;
  link: string;
  imageLink: string;
  priceCents: number;
  currency: 'USD';
  gtin: string | null;
  brand: string | null;
  condition: Condition;
  availability: Availability;
  dryRun: boolean;
};

export const MAX_PRICE_CENTS = 100_000_000;
const OFFER_ID = /^[A-Za-z0-9._-]{1,50}$/;
const CONDITIONS: Condition[] = ['NEW', 'USED', 'REFURBISHED'];
const AVAILABILITIES: Availability[] = ['IN_STOCK', 'OUT_OF_STOCK', 'PREORDER', 'BACKORDER', 'LIMITED_AVAILABILITY'];
const PROMO = /\b(free shipping|best price|buy now|limited time|hot deal|cheapest|sale|discount)\b/gi;

const bad = (msg: string) => new HttpError(400, 'BAD_REQUEST', msg);

export function centsToMicros(cents: number): string {
  if (!Number.isSafeInteger(cents) || cents < 0) throw bad('priceCents must be a non-negative integer');
  return (BigInt(cents) * 10000n).toString();
}

// Deterministic: strip control chars and promo phrases, de-shout ALL CAPS, cap at 150 code points on a word boundary.
export function normalizeTitle(raw: string): string {
  let t = raw.normalize('NFC').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(PROMO, ' ').replace(/!+/g, ' ').replace(/\s+/g, ' ').trim();
  const letters = t.replace(/[^A-Za-z]/g, '');
  if (letters.length >= 8 && letters === letters.toUpperCase()) {
    t = t.toLowerCase().replace(/(^|\s)([a-z])/g, (_m, sp: string, ch: string) => sp + ch.toUpperCase());
  }
  const cps = Array.from(t);
  if (cps.length > 150) {
    let cut = cps.slice(0, 150).join('');
    const space = cut.lastIndexOf(' ');
    if (space >= 100) cut = cut.slice(0, space);
    t = cut.trim();
  }
  return t;
}

function checkSiteUrl(name: string, value: unknown, siteOrigin: string): string {
  if (typeof value !== 'string' || value.length > 2000 || !/^[\x21-\x7e]+$/.test(value)) throw bad(name + ' must be an ASCII URL string (max 2000)');
  let u: URL;
  try { u = new URL(value); } catch { throw bad(name + ' is not a valid URL'); }
  if (u.protocol !== 'https:') throw bad(name + ' must use https');
  if (u.username || u.password) throw bad(name + ' must not contain credentials');
  if (u.origin !== siteOrigin.replace(/\/+$/, '')) throw bad(name + ' must be on ' + siteOrigin);
  if (u.search || u.hash || value.includes('?') || value.includes('#')) throw bad(name + ' must not contain a query string or fragment');
  return u.toString();
}

function optString(name: string, value: unknown, max: number): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw bad(name + ' must be a string');
  const v = value.trim();
  if (v.length > max) throw bad(name + ' exceeds ' + max + ' characters');
  return v || null;
}

export function validateListingRequest(input: unknown, siteOrigin: string): ListingRequest {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) throw bad('body must be a JSON object');
  const o = input as Record<string, unknown>;
  if (typeof o.lotId !== 'string' || !OFFER_ID.test(o.lotId)) throw bad('lotId must match [A-Za-z0-9._-]{1,50}');
  const offerId = o.offerId === undefined ? o.lotId : o.offerId;
  if (typeof offerId !== 'string' || !OFFER_ID.test(offerId)) throw bad('offerId must match [A-Za-z0-9._-]{1,50}');
  if (typeof o.title !== 'string' || o.title.length > 500) throw bad('title must be a string (max 500 before normalization)');
  const title = normalizeTitle(o.title);
  if (!title) throw bad('title is empty after normalization');
  if (typeof o.priceCents !== 'number' || !Number.isSafeInteger(o.priceCents) || o.priceCents < 1 || o.priceCents > MAX_PRICE_CENTS) {
    throw bad('priceCents must be an integer between 1 and ' + MAX_PRICE_CENTS);
  }
  if (o.currency !== undefined && o.currency !== 'USD') throw bad('currency must be USD');
  const gtin = optString('gtin', o.gtin, 14);
  if (gtin !== null && !isValidGtin(gtin)) throw bad('gtin fails the GTIN checksum');
  const condition = o.condition === undefined ? 'NEW' : o.condition;
  if (!CONDITIONS.includes(condition as Condition)) throw bad('condition must be one of ' + CONDITIONS.join(', '));
  const availability = o.availability === undefined ? 'IN_STOCK' : o.availability;
  if (!AVAILABILITIES.includes(availability as Availability)) throw bad('availability must be one of ' + AVAILABILITIES.join(', '));
  if (o.dryRun !== undefined && typeof o.dryRun !== 'boolean') throw bad('dryRun must be a boolean');
  return {
    lotId: o.lotId,
    offerId,
    title,
    description: optString('description', o.description, 5000),
    link: checkSiteUrl('link', o.link, siteOrigin),
    imageLink: checkSiteUrl('imageLink', o.imageLink, siteOrigin),
    priceCents: o.priceCents,
    currency: 'USD',
    gtin,
    brand: optString('brand', o.brand, 70),
    condition: condition as Condition,
    availability: availability as Availability,
    dryRun: o.dryRun !== false,
  };
}

export function toProductInput(req: ListingRequest, cfg: { language: string; feedLabel: string }): ProductInputBody {
  const attrs: ProductAttributes = {
    title: req.title,
    link: req.link,
    imageLink: req.imageLink,
    price: { amountMicros: centsToMicros(req.priceCents), currencyCode: 'USD' },
    availability: req.availability,
    condition: req.condition,
  };
  if (req.description) attrs.description = req.description;
  if (req.brand) attrs.brand = req.brand;
  if (req.gtin) attrs.gtins = [req.gtin];
  else attrs.identifierExists = false;
  return { offerId: req.offerId, contentLanguage: cfg.language, feedLabel: cfg.feedLabel, productAttributes: attrs };
}

// Unpadded base64url of "contentLanguage~feedLabel~offerId" (Google-recommended encoded id form).
export function encodeProductId(language: string, feedLabel: string, offerId: string): string {
  const bytes = new TextEncoder().encode(language + '~' + feedLabel + '~' + offerId);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function insertPath(accountId: string): string {
  return '/products/v1/accounts/' + accountId + '/productInputs:insert';
}
export function productInputPath(accountId: string, language: string, feedLabel: string, offerId: string): string {
  return '/products/v1/accounts/' + accountId + '/productInputs/' + encodeProductId(language, feedLabel, offerId);
}
export function productPath(accountId: string, language: string, feedLabel: string, offerId: string): string {
  return '/products/v1/accounts/' + accountId + '/products/' + encodeProductId(language, feedLabel, offerId);
}

// Idempotency hash over the target data source and the payload: publishing the same body to a different data source is a new write.
export async function payloadHash(body: ProductInputBody, dataSource = ''): Promise<string> {
  return sha256Hex(JSON.stringify({ dataSource, body }));
}
