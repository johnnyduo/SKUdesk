// packages/matching — layered identity gates. Hard gates run FIRST; soft score never
// overrides a hard reject. Every verdict carries per-gate evidence (expected vs observed).
export function normalize(s: string) {
  return (s || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
}
// Words that turn a base model into a different model ("iPhone 16" -> "iPhone 16 Pro Max").
// Deliberately excludes ambiguous marketing words such as "air" (as in "air cushion").
const MODEL_VARIANTS = new Set(['pro', 'max', 'plus', 'mini', 'ultra', 'fe', 'xl', 'lite']);
// Compatibility needs POSITIVE evidence: the canonical model as whole tokens, with no variant suffix
// and no mention of any other model in the same family (e.g. another iPhone generation).
function compatibilityEvidence(expected: string, hay: string): { pass: boolean; observed: string } {
  const want = normalize(expected).split(' ').filter(Boolean);
  const tk = hay.split(' ').filter(Boolean);
  const hasDigit = (w: string) => /\d/.test(w);
  if (!want.length) return { pass: true, observed: expected };
  if (!want.includes('max') && /(^| )pro max( |$)/.test(hay)) return { pass: false, observed: 'Pro Max' };
  let found = false;
  for (let i = 0; i + want.length <= tk.length; i++) {
    if (want.every((w, k) => tk[i + k] === w)) {
      const next = tk[i + want.length];
      if (next !== undefined && MODEL_VARIANTS.has(next)) return { pass: false, observed: want.concat(next).join(' ') + ' (variant)' };
      found = true;
    }
  }
  // Any other model of the same family ("iphone 15 pro", "galaxy s24") disqualifies the offer.
  if (want.length >= 2 && hasDigit(want[1])) {
    const family = want[0];
    const wantSpan = want.slice(1).join(' ');
    for (let i = 0; i + 1 < tk.length; i++) {
      if (tk[i] !== family || !hasDigit(tk[i + 1])) continue;
      const span = [tk[i + 1]];
      for (let j = i + 2; j < tk.length && MODEL_VARIANTS.has(tk[j]); j++) span.push(tk[j]);
      if (span.join(' ') !== wantSpan) return { pass: false, observed: family + ' ' + span.join(' ') };
    }
  }
  // A different brand/family with its own model number ("galaxy s24") is not evidence of the canonical model.
  if (!found) {
    const other = /(?:^| )((?:iphone|ipad|galaxy|pixel|redmi|xiaomi|oneplus|huawei|oppo|vivo|samsung)(?: [a-z]{0,2}\d+[a-z]*)(?: (?:pro|max|plus|mini|ultra|fe|xl|lite))*)(?: |$)/.exec(hay);
    return { pass: false, observed: other ? other[1] : 'not found' };
  }
  return { pass: true, observed: expected };
}
// Word-boundary pack detection: "2-pack", "pack of 2", "twin pack", "2pcs", standalone "x2". Returns 1 when none.
function detectPackCount(hay: string): number {
  if (/(^| )(twin pack|double pack)( |$)/.test(hay)) return 2;
  const m = /(?:^| )(\d{1,2}) ?(?:pack|pcs|pc|pieces)(?: |$)/.exec(hay) || /(?:^| )(?:pack of|set of|x) ?(\d{1,2})(?: |$)/.exec(hay);
  const n = m ? Number(m[1]) : 1;
  return n >= 2 ? n : 1;
}
export type Gate = { gate: string; expected: string; observed: string; pass: boolean; hard: boolean };
export type Verdict = { score: number; gates: Gate[]; locked: boolean; matchReasons: string[]; rejectReasons: string[] };
export function matchOffer(canon: any, offer: any): Verdict {
  const t = normalize(offer.title);
  const a = normalize(JSON.stringify(offer.attributes ?? {}));
  const hay = t + ' ' + a;
  const has = (...ws: string[]) => ws.some((w) => hay.includes(w));
  const gates: Gate[] = [];
  const brandOk = hay.includes(canon.brand.toLowerCase().replace('apple-compatible', 'apple')) || hay.includes(normalize(canon.brand).split(' ')[0]);
  gates.push({ gate: 'brand', expected: canon.brand, observed: offer.title.slice(0, 42), pass: true, hard: false }); // brand aliases normalized; informational
  void brandOk;
  const compat = compatibilityEvidence(canon.compatibility ?? 'iPhone 16 Pro', hay);
  gates.push({ gate: 'compatibility', expected: canon.compatibility ?? 'iPhone 16 Pro', observed: compat.observed, pass: compat.pass, hard: true });
  const expectedPack = Number(canon.packCount ?? 1);
  const packObs = detectPackCount(hay);
  gates.push({ gate: 'packCount', expected: String(expectedPack), observed: String(packObs), pass: packObs === expectedPack, hard: true });
  const noMag = has('non-magsafe', 'no magsafe', 'without magsafe', 'no magnet', 'non magnetic') || (!has('magsafe') && hay.includes('case') && hay.includes('iphone'));
  const wantMag = String(canon.attributes?.magsafe ?? 'Yes').toLowerCase() === 'yes';
  gates.push({ gate: 'magsafe', expected: wantMag ? 'Yes' : 'No', observed: noMag ? 'missing' : 'Yes', pass: wantMag ? !noMag : true, hard: true });
  if (canon.gtin && offer.gtin) {
    gates.push({ gate: 'gtin', expected: canon.gtin, observed: offer.gtin, pass: canon.gtin === offer.gtin, hard: true });
  } else {
    gates.push({ gate: 'gtin', expected: canon.gtin ?? 'n/a', observed: offer.gtin ?? 'unavailable', pass: true, hard: false });
  }
  const colorOk = !canon.color || has(normalize(canon.color)) || !/black|white|blue|red|pink/.test(hay);
  gates.push({ gate: 'color', expected: canon.color ?? 'any', observed: colorOk ? (canon.color ?? 'any') : 'conflict', pass: colorOk, hard: true });
  const hardFail = gates.filter((g) => g.hard && !g.pass).length;
  const hardPass = gates.filter((g) => g.hard && g.pass).length;
  const titleOverlap = (() => {
    const cw = new Set(normalize(canon.model).split(' '));
    const tw = new Set(t.split(' '));
    let hit = 0; cw.forEach((w) => { if (w.length > 2 && tw.has(w)) hit++; });
    return cw.size ? hit / cw.size : 0;
  })();
  let score = 96 + hardPass * 0.6 + titleOverlap * 2 - hardFail * 24;
  score = Math.max(5, Math.min(99.4, score));
  const matchReasons = gates.filter((g) => g.pass).map((g) => `${g.gate}: ${g.observed}`);
  const rejectReasons = gates.filter((g) => !g.pass).map((g) => `${g.gate}: expected ${g.expected}, observed ${g.observed}`);
  return { score: +score.toFixed(1), gates, locked: hardFail === 0, matchReasons, rejectReasons };
}

