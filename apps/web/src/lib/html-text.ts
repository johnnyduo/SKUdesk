// Turns the text of an HTML attribute value back into plain text. Base.astro reads the description out of an
// already-rendered head slot, so the value arrives escaped; Astro escapes it again when it prints the tag.
// Unescaping first means a "&" or a quote is escaped exactly once.
const NAMED: Record<string, string> = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>' };

export function unescapeAttr(value: string): string {
  return value.replace(/&(?:#(\d+)|#x([0-9a-f]+)|(amp|quot|apos|lt|gt));/gi, (m, dec, hex, name) => {
    if (name) return NAMED[name.toLowerCase()];
    const cp = dec !== undefined ? Number(dec) : parseInt(hex, 16);
    return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
  });
}
