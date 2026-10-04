// The ONE dollar formatter for the /market page: integer cents to "$1,296.43" (thousands separators, exactly 2 decimals, en-US whatever the
// viewer's locale). Pure and import-free so the market island can use it without pulling any other module into its bundle.
const nf = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** What a price that cannot be shown is rendered as. */
export const NO_PRICE = '—';

/** Cents (fractions such as an axis midpoint are rounded to the cent) -> "$1,296.43", "-$0.01"; NaN/Infinity -> "—". */
export function fmtUsdCents(cents: number): string {
  if (typeof cents !== 'number' || !Number.isFinite(cents)) return NO_PRICE;
  const c = Math.round(Math.abs(cents));
  return (cents < 0 && c > 0 ? '-$' : '$') + nf.format(c / 100);
}
