// One money format for every visible dollar amount: "$2,636.00" (thousands separators, 2 decimals).
// run.json is hash-bound and holds some amounts as plain text ("$2636.00"); this rewrites them at display time only.
const MONEY = /\$(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?/g;
const nf = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export const moneyText = (s: string): string =>
  s.replace(MONEY, (m, whole: string, frac?: string) => {
    const n = Number(whole.replace(/,/g, '') + (frac ? '.' + frac : ''));
    return Number.isFinite(n) ? '$' + nf.format(n) : m;
  });

/** Cents (number, bigint or numeric string) -> "$2,636.00". The one dollar formatter for the site. */
export const fmtCents = (c: number | bigint | string): string => {
  const v = Number(c) / 100;
  return (v < 0 ? '-$' : '$') + nf.format(Math.abs(v));
};

/**
 * What the sale proceeds in the run really are, read from the run data (never typed in):
 * proceeds / units is the per-unit amount received, and the listed sell price less that amount is the
 * selling-side cost (marketplace fee, fulfilment, return reserve, chain cost).
 */
export function proceedsFacts(run: any, offers: any[]) {
  const units = Number(run?.accepted?.units ?? 0);
  const proceedsCents = Number(run?.end?.totalProceeds ?? 0) / 1e4;
  const sell = (offers ?? []).find((o) => o.id === run?.accepted?.sellOfferId);
  const listCents = Number(sell?.priceCents ?? 0);
  const perUnit = units > 0 ? proceedsCents / units : 0;
  const ok = units > 0 && Number.isInteger(perUnit) && listCents > perUnit && perUnit > 0;
  const costCents = ok ? listCents - perUnit : 0;
  const sentence = ok
    ? `Sale proceeds were ${fmtCents(proceedsCents)}: ${units} units × ${fmtCents(perUnit)}. That is the ${fmtCents(listCents)} sell price less ${fmtCents(costCents)} per unit of selling-side costs (marketplace fee, fulfilment, return reserve, chain cost), not ${units} × ${fmtCents(listCents)}.`
    : '';
  return { ok, units, proceedsCents, perUnit, listCents, costCents, sentence };
}

export const BY_CONSTRUCTION =
  'The two amounts match by construction in this run: the script set the sale proceeds and paid them from the owner’s test wallet. What the contract guarantees is that profit is counted only on tokens it actually received.';

/** Returns a deep copy of parsed JSON with every string passed through moneyText. */
export function deepMoney<T>(v: T): T {
  if (typeof v === 'string') return moneyText(v) as unknown as T;
  if (Array.isArray(v)) return v.map(deepMoney) as unknown as T;
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v as object).map(([k, x]) => [k, deepMoney(x)])) as T;
  return v;
}
