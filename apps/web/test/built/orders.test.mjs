// Assertions on the built /app/orders page (run after `npm run build`). The page follows src/data/orders.json.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../../dist/app/orders/index.html', import.meta.url), 'utf8');
const data = JSON.parse(readFileSync(new URL('../../src/data/orders.json', import.meta.url), 'utf8'));
const text = html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

test('orders page never uses the banned words', () => { assert.doesNotMatch(text, /\b(demo|sample|mock|judge)\b/i); });
test('orders page names the verifier trust assumption', () => {
  assert.match(text, /The verifier is one address chosen at deployment; it decides whether goods arrived\./);
});
if (!data.deployed) {
  test('while OrderEscrow is not deployed the page says so instead of showing an empty view', () => {
    assert.match(html, /data-testid="orders-not-deployed"/); assert.match(text, /The order contract is not deployed yet/);
    assert.doesNotMatch(html, /data-testid="orders-live"/);
  });
} else {
  test('deployed: every proof order is rendered as a timeline with provenance chips and the proof statement', () => {
    for (const o of data.proof.orders) assert.match(html, new RegExp(`data-testid="order-${o.id}"`));
    assert.match(html, /AGENT ATTESTED/); assert.match(html, /ONCHAIN/);
    assert.match(text, /script-controlled wallets and operator-issued test units/); assert.match(text, /No physical goods moved/);
    assert.match(text, /Signed by the named verifier/);
  });
}
