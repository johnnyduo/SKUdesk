// Generates EconLib reference vectors from an INDEPENDENT BigInt implementation of the EconLib formulas
// (docs/proofs/economics.md, section 1). Consumed by:
//   - packages/contracts/test/ProofsEconomics.t.sol  (EconLib.quote must equal every vector, on-chain arithmetic)
//   - packages/economics/test/proofs.econ.test.ts    (the TypeScript mirror must equal every vector flagged tsSafe=1,
//                                                     and must DIFFER on the documented counterexample, finding F-E1)
// Deterministic (seeded). Regenerate with: node packages/contracts/test/vectors/gen-econ-vectors.mjs
// All numbers are written as decimal STRINGS so values above 2^53 survive JSON.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

export const MAX_FIELD = 10n ** 12n; // SKUdeskCore.MAX_FIELD (cents)
export const MAX_BPS = 10_000n;      // SKUdeskCore.MAX_BPS
export const TS_SAFE_SELL = 9n * 10n ** 11n; // theorem E7: the Number mirror is exact for sellCents <= 9e11
export const FIELDS = ['purchaseCents', 'shipCents', 'dutyCents', 'taxCents', 'procFeeCents', 'payFeeCents', 'sellCents', 'mktFeeBps', 'fulfillCents', 'retBps', 'chainCents'];

const ceilDiv = (a, b) => (a + b - 1n) / b; // a >= 0, b > 0 (BigInt division truncates = floors for non-negatives)

/** Reference EconLib.quote over BigInt (exact integers, no overflow, no float). */
export function refQuote(q) {
  const landed = q.purchaseCents + q.shipCents + q.dutyCents + q.taxCents + q.procFeeCents + q.payFeeCents;
  const mktFee = ceilDiv(q.sellCents * q.mktFeeBps, 10_000n);
  const ret = ceilDiv(q.sellCents * q.retBps, 10_000n);
  const net = q.sellCents - mktFee - q.fulfillCents - ret - landed - q.chainCents;
  const marginBps = q.sellCents === 0n || net < 0n ? 0n : (net * 10_000n) / q.sellCents;
  const breakeven = landed + mktFee + q.fulfillCents + ret + q.chainCents;
  const other = landed - q.purchaseCents;
  const maxBuy = breakeven > other ? breakeven - other : 0n;
  return { landed, mktFee, ret, net, marginBps, breakeven, maxBuy };
}

function rng(seed) { let a = seed >>> 0; return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

export function buildVectors() {
  const r = rng(46631);
  const big = (lim) => { // uniform-ish in [0, lim] using 48 random bits
    const hi = BigInt(Math.floor(r() * 2 ** 24)), lo = BigInt(Math.floor(r() * 2 ** 24));
    return ((hi << 24n) | lo) % (lim + 1n);
  };
  const logu = (lim) => { const d = Math.floor(r() * 13); const cap = 10n ** BigInt(d); return big(cap < lim ? cap : lim); };
  const bps = () => { const k = r(); return k < 0.1 ? 0n : k < 0.2 ? MAX_BPS : k < 0.3 ? MAX_BPS - 1n : BigInt(Math.floor(r() * 10_001)); };
  const hero = { purchaseCents: 590n, shipCents: 42n, dutyCents: 12n, taxCents: 8n, procFeeCents: 5n, payFeeCents: 2n, sellCents: 1099n, mktFeeBps: 800n, fulfillCents: 65n, retBps: 200n, chainCents: 4n };
  const zero = Object.fromEntries(FIELDS.map((f) => [f, 0n]));
  const maxq = Object.fromEntries(FIELDS.map((f) => [f, f.endsWith('Bps') ? MAX_BPS : MAX_FIELD]));
  const out = [];
  // 1. one-field sweeps from three baselines over the edge values of the domain
  for (const base of [hero, zero, maxq]) for (const f of FIELDS) {
    const lim = f.endsWith('Bps') ? MAX_BPS : MAX_FIELD;
    for (const v of [0n, 1n, 2n, 9_999n, 10_000n, 10_001n, lim - 1n, lim]) if (v <= lim) out.push({ ...base, [f]: v });
  }
  // 2. ceil boundaries: sell*bps == 0, 1, 9999 (mod 10000)
  for (const s of [1n, 3n, 7n, 9_999n, 10_000n, 10_001n, 123_457n, MAX_FIELD]) for (const b of [1n, 3n, 9_999n, 10_000n]) out.push({ ...hero, sellCents: s, mktFeeBps: b, retBps: MAX_BPS - b });
  // 3. random, full accepted domain (log-uniform magnitudes)
  for (let i = 0; i < 700; i++) { const q = {}; for (const f of FIELDS) q[f] = f.endsWith('Bps') ? bps() : logu(MAX_FIELD); out.push(q); }
  // 4. random, realistic: around the hero, mostly profitable
  for (let i = 0; i < 700; i++) {
    const s = 100n + big(200_000n); const q = { ...hero, sellCents: s };
    for (const f of ['purchaseCents', 'shipCents', 'dutyCents', 'taxCents', 'procFeeCents', 'payFeeCents', 'fulfillCents', 'chainCents']) q[f] = big(s / 14n);
    q.mktFeeBps = BigInt(Math.floor(r() * 2_000)); q.retBps = BigInt(Math.floor(r() * 1_000)); out.push(q);
  }
  // 5. outside the TypeScript-safe region (sellCents > 9e11): includes the documented counterexample (finding F-E1)
  out.push({ ...zero, sellCents: MAX_FIELD, mktFeeBps: 9_999n });
  for (let i = 0; i < 100; i++) out.push({ ...hero, sellCents: TS_SAFE_SELL + 1n + big(MAX_FIELD - TS_SAFE_SELL - 1n), mktFeeBps: bps(), retBps: bps(), purchaseCents: big(MAX_FIELD / 2n) });
  return out;
}

export function toColumns(qs) {
  const cols = { tsSafe: [] }; for (const f of FIELDS) cols[f] = [];
  for (const k of ['landed', 'mktFee', 'ret', 'net', 'marginBps', 'breakeven', 'maxBuy']) cols['exp_' + k] = [];
  for (const q of qs) {
    const e = refQuote(q);
    for (const f of FIELDS) cols[f].push(q[f].toString());
    for (const k of Object.keys(e)) cols['exp_' + k].push(e[k].toString());
    cols.tsSafe.push(q.sellCents <= TS_SAFE_SELL ? '1' : '0');
  }
  return cols;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  const qs = buildVectors(); const cols = toColumns(qs);
  fs.writeFileSync(new URL('./econ-vectors.json', import.meta.url), JSON.stringify(cols));
  console.log('econ vectors:', qs.length, 'tsSafe:', cols.tsSafe.filter((x) => x === '1').length, 'profitable:', cols.exp_net.filter((x) => BigInt(x) > 0n).length);
}
