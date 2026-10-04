// Keeps the landing page short, plain and backed by code.
const BANNED = ['sample', 'demo', 'recorded', 'fixture', 'simulat', 'mock', 'judge', 'autonomous', 'deterministic', 'uniswap', 'erc-1155', 'hook', 'lot-1842', 'op-20', 'so-9918', '0x9f', 'zero trust', 'trustless'];
const REQUIRED = ['identical'];
const MAX_HEADING_WORDS = 10;
const MAX_WORDS = 250;
// Kept on purpose: the page must keep saying the settlement is in test tokens on the testnet.
const DISCLOSURES = ['test token', 'robinhood chain testnet'];
const FOOTER = 'prices shown are a fixed snapshot until live feeds are connected';

const decode = (s) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'").replace(/&nbsp;/g, ' ');
const strip = (html) => decode(html.replace(/<(script|style|svg)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

export function lintCopy(html) {
  const problems = [];
  // The meta description shows in search results and link previews, so it is held to the same banned list.
  const metas = [...html.matchAll(/<meta\b[^>]*\bname=["']description["'][^>]*>/gi)].map((m) => (m[0].match(/\bcontent=(?:"([^"]*)"|'([^']*)')/i) ?? []).slice(1).find((x) => x !== undefined) ?? '');
  const all = (strip(html) + ' ' + decode(metas.join(' '))).toLowerCase();
  // The word budget is for the page's story: product captions and the footer (links, boilerplate) are left out of it. Banned words and disclosures are still checked everywhere.
  const copy = strip(html.replace(/<article\b[^>]*class="[^"]*\bsc-card\b[^"]*"[\s\S]*?<\/article>/gi, ' ').replace(/<footer\b[\s\S]*?<\/footer>/gi, ' '));
  const words = copy ? copy.split(' ').length : 0;

  for (const b of BANNED) if (all.includes(b)) problems.push(`banned text: "${b}"`);
  // The settlement token is named mUSDG (a test token). Bare "USDG" would pass it off as the real stablecoin.
  if (all.replace(/musdg|test usdg/g, '').includes('usdg')) problems.push('"USDG" is only allowed as mUSDG or "test USDG"');
  if (!all.includes(FOOTER)) problems.push('missing the footer disclosure: "' + FOOTER + '"');
  for (const d of DISCLOSURES) if (!all.includes(d)) problems.push(`missing the testnet disclosure: "${d}"`);
  const copyLc = copy.toLowerCase();
  for (const r of REQUIRED) if (!copyLc.includes(r)) problems.push(`missing required text outside the product cards: "${r}"`);
  for (const m of html.matchAll(/<h[1-3]\b[^>]*>([\s\S]*?)<\/h[1-3]>/gi)) { const h = strip(m[1]); if (h && h.split(' ').length > MAX_HEADING_WORDS) problems.push(`heading too long (${h.split(' ').length} words): "${h}"`); }
  if (words > MAX_WORDS) problems.push(`${words} words (max ${MAX_WORDS}, product captions and footer excluded)`);
  return { ok: problems.length === 0, words, problems };
}
