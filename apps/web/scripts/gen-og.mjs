// Generates the share image (public/og.png, 1200x630), the iOS icon (public/apple-touch-icon.png, 180x180)
// and the favicon (public/favicon.svg) from inline SVG. Run: node scripts/gen-og.mjs
// Colours are the global.css tokens (--bg, --surface, --neon, --txt, --mut). The text is rendered by sharp/librsvg with the
// system's Helvetica/Arial, so the committed PNG is the reference artifact; re-run only when the wording changes.
import { writeFileSync } from 'node:fs';
import sharp from 'sharp';

const pub = new URL('../public/', import.meta.url);
const C = { bg: '#080908', surface: '#0E100F', line: '#2A2D29', neon: '#CCFF00', txt: '#F5F6F2', mut: '#A6ABA3' };
const FONT = "'Helvetica Neue', Helvetica, Arial, sans-serif";
const MARK = 'M8 22 16 8l8 14';

// The monogram: the same chevron the site uses as its logo, on a rounded dark tile.
const favicon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="${C.bg}"/><path d="${MARK}" stroke="${C.neon}" stroke-width="2.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>\n`;

// Square tile for iOS (iOS rounds the corners itself, so the tile is full-bleed).
const touch = `<svg xmlns="http://www.w3.org/2000/svg" width="180" height="180" viewBox="0 0 32 32"><rect width="32" height="32" fill="${C.bg}"/><path d="${MARK}" stroke="${C.neon}" stroke-width="2.6" fill="none" stroke-linecap="round" stroke-linejoin="round" transform="translate(16 16) scale(1.15) translate(-16 -15)"/></svg>`;

const og = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
<defs>
<radialGradient id="glow" cx="0.82" cy="0.18" r="0.7"><stop offset="0" stop-color="${C.neon}" stop-opacity="0.16"/><stop offset="1" stop-color="${C.neon}" stop-opacity="0"/></radialGradient>
</defs>
<rect width="1200" height="630" fill="${C.bg}"/>
<rect width="1200" height="630" fill="url(#glow)"/>
<rect x="40" y="40" width="1120" height="550" rx="24" fill="none" stroke="${C.line}" stroke-width="2"/>
<rect x="96" y="96" width="72" height="72" rx="16" fill="${C.surface}" stroke="${C.line}" stroke-width="2"/>
<path d="${MARK}" stroke="${C.neon}" stroke-width="2.6" fill="none" stroke-linecap="round" stroke-linejoin="round" transform="translate(96 96) scale(2.25)"/>
<text x="192" y="146" font-family="${FONT}" font-size="48" font-weight="700" letter-spacing="2" fill="${C.txt}">SKUdesk</text>
<text x="96" y="318" font-family="${FONT}" font-size="76" font-weight="700" fill="${C.txt}">Agents compete on</text>
<text x="96" y="410" font-family="${FONT}" font-size="76" font-weight="700" fill="${C.txt}">the same product</text>
<text x="96" y="502" font-family="${FONT}" font-size="76" font-weight="700" fill="${C.neon}">in sealed rounds.</text>
<line x1="96" y1="536" x2="1104" y2="536" stroke="${C.line}" stroke-width="2"/>
<text x="96" y="570" font-family="${FONT}" font-size="26" fill="${C.mut}">Robinhood Chain Testnet · test token, no value</text>
</svg>`;

writeFileSync(new URL('favicon.svg', pub), favicon);
await sharp(Buffer.from(touch)).resize(180, 180).png().toFile(new URL('apple-touch-icon.png', pub).pathname);
await sharp(Buffer.from(og)).png().toFile(new URL('og.png', pub).pathname);
for (const f of ['og.png', 'apple-touch-icon.png']) { const m = await sharp(new URL(f, pub).pathname).metadata(); console.log(f, m.width + 'x' + m.height); }
console.log('favicon.svg written');
