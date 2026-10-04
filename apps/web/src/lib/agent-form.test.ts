// Run: node --test apps/web/src/lib/agent-form.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateForm, DEFAULT_FORM, agentURI, readAgentURI, registrationFile, type AgentForm } from './agent-form.ts';

const D = { supplier: '0x935A27083d49495a2F6E13E2e8Db5e97D94a04A4', payer: '0x6129C88CE91ACdf5c1E42188B1aF88C2166a5501', owner: '0x1111111111111111111111111111111111111111' };
const KEY = '0x2222222222222222222222222222222222222222';
const form = (o: Partial<AgentForm> = {}): AgentForm => ({ ...DEFAULT_FORM, agentAddress: KEY, ...o });

test('a valid form becomes exact contract parameters in cents, basis points and seconds', () => {
  const r = validateForm(form(), D); assert.ok(r.ok); if (!r.ok) return;
  assert.equal(r.params.dailyCap, 500_000n); assert.equal(r.params.maxPerTrade, 250_000n); assert.equal(r.params.minMarginBps, 1800n); assert.equal(r.params.quoteTTL, 180n);
  assert.deepEqual(r.params.payees, [D.supplier]); assert.deepEqual(r.params.payers, [D.payer]); assert.equal(r.params.agentKey, KEY);
});
test('decimals are exact, not floating point', () => {
  const r = validateForm(form({ daily: '1234.56', perTrade: '0.07', margin: '18.5' }), D); assert.ok(r.ok); if (!r.ok) return;
  assert.equal(r.params.dailyCap, 123_456n); assert.equal(r.params.maxPerTrade, 7n); assert.equal(r.params.minMarginBps, 1850n);
});
test('every bad field gets its own plain sentence', () => {
  const r = validateForm(form({ name: ' ', daily: 'abc', perTrade: '-1', margin: '0.5', ttl: '1.5', agentAddress: '0x123' }), D); assert.ok(!r.ok); if (r.ok) return;
  for (const k of ['name', 'daily', 'perTrade', 'margin', 'ttl', 'agentAddress'] as const) assert.ok(r.errors[k] && r.errors[k]!.length > 10, k);
});
test('margin outside 1% to 90% is refused before the wallet is asked', () => {
  assert.ok(!validateForm(form({ margin: '0.99' }), D).ok); assert.ok(!validateForm(form({ margin: '90.01' }), D).ok); assert.ok(validateForm(form({ margin: '90' }), D).ok); assert.ok(validateForm(form({ margin: '1' }), D).ok);
});
test('one trade cannot exceed the daily budget', () => {
  const r = validateForm(form({ daily: '100', perTrade: '100.01' }), D); assert.ok(!r.ok); if (!r.ok) assert.match(r.errors.perTrade!, /daily budget/);
  assert.ok(validateForm(form({ daily: '100', perTrade: '100' }), D).ok);
});
test('the agent address must not be the owner wallet', () => {
  const r = validateForm(form({ agentAddress: D.owner.toLowerCase() }), D); assert.ok(!r.ok); if (!r.ok) assert.match(r.errors.agentAddress!, /different address/);
});
test('allowlists follow the checkboxes', () => {
  const r = validateForm(form({ allowSupplier: false, allowPayer: false }), D); assert.ok(r.ok); if (r.ok) { assert.deepEqual(r.params.payees, []); assert.deepEqual(r.params.payers, []); }
});
test('the registration file round-trips through a data URI, including non-ASCII text', () => {
  const uri = agentURI('Ágent “ä”', 'ทดสอบ'); assert.ok(uri.startsWith('data:application/json;base64,'));
  const back = readAgentURI(uri)!; assert.equal(back.name, 'Ágent “ä”'); assert.equal(back.description, 'ทดสอบ'); assert.equal(back.active, true);
  assert.equal((back as any).type, registrationFile('x', 'y').type);
});
test('readAgentURI tolerates the utf8 form used by the proof script and rejects junk', () => {
  assert.equal(readAgentURI('data:application/json;utf8,' + encodeURIComponent('{"name":"n"}'))!.name, 'n');
  assert.equal(readAgentURI('https://example.com/a.json'), null); assert.equal(readAgentURI('data:application/json;base64,@@@'), null);
});
