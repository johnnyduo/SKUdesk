// Vendor prices arrive as strings ("12.99", "$1,299.00") or JS numbers (12.99). Convert ONCE to integer cents
// by decimal-string parsing (never x*100 on floats). Half-up rounding on the third decimal. Pure.
export function parseMoneyToCents(value: unknown): number | null {
  let s: string;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0) return null;
    s = String(value);
    if (/e/i.test(s)) return null;
  } else if (typeof value === 'string') {
    s = value.trim().replace(/^US\s*/i, '').replace(/^\$/, '').trim();
  } else {
    return null;
  }
  // A comma is valid only as US thousands grouping ("1,299.00"); "12,99" (decimal comma) fails closed.
  const m = /^(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?$/.exec(s);
  if (!m) return null;
  const whole = m[1].replace(/,/g, '');
  if (whole.length > 9) return null;
  const frac = (m[2] ?? '').padEnd(3, '0');
  let cents = Number(whole) * 100 + Number(frac.slice(0, 2));
  if (Number(frac[2]) >= 5) cents += 1;
  return cents;
}

// "Free delivery" -> 0, "$5.99 delivery" -> 599, anything else -> null (unknown).
export function parseShippingText(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  if (/free/i.test(value)) return 0;
  // The lookahead refuses a malformed amount ("$12,99", "$12.995", "$1299999999") instead of reading a prefix of it.
  const m = /\$\s?(\d{1,6}(?:,\d{3})*(?:\.\d{1,2})?)(?![\d,.]\d)(?!\d)/.exec(value);
  return m ? parseMoneyToCents(m[1]) : null;
}
