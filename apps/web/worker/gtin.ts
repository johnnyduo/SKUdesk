// GTIN (EAN-8, UPC-A, EAN-13, GTIN-14) checksum validation and GTIN-14 normalization. Pure.
export function isValidGtin(raw: string): boolean {
  if (!/^(\d{8}|\d{12}|\d{13}|\d{14})$/.test(raw)) return false;
  if (/^0+$/.test(raw)) return false;
  const digits = Array.from(raw, Number);
  const check = digits[digits.length - 1];
  let sum = 0;
  let weight = 3;
  for (let i = digits.length - 2; i >= 0; i--) {
    sum += digits[i] * weight;
    weight = weight === 3 ? 1 : 3;
  }
  return (10 - (sum % 10)) % 10 === check;
}

// UPC-A "036000291452" and EAN-13 "0036000291452" are the same item: compare as zero-padded GTIN-14.
export function normalizeGtin(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const digits = raw.replace(/\D/g, '');
  if (!isValidGtin(digits)) return null;
  return digits.padStart(14, '0');
}

export function sameGtin(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = normalizeGtin(a);
  return x !== null && x === normalizeGtin(b);
}
