import { test } from 'node:test';
import assert from 'node:assert/strict';
import { unescapeAttr } from '../../src/lib/html-text.ts';

test('unescapeAttr undoes one level of attribute escaping', () => {
  assert.equal(unescapeAttr('Tom &amp; Jerry say &quot;hi&quot;'), 'Tom & Jerry say "hi"');
  assert.equal(unescapeAttr('it&#39;s &#x26; &lt;b&gt;'), "it's & <b>");
});

test('unescapeAttr is single-pass and leaves plain text and unknown entities alone', () => {
  assert.equal(unescapeAttr('&amp;amp;'), '&amp;');
  assert.equal(unescapeAttr('plain text, no entities'), 'plain text, no entities');
  assert.equal(unescapeAttr('&nbsp; &#0; &#99999999;'), '&nbsp; &#0; &#99999999;');
});

test('a slot description with & and a quote is escaped once, not twice, in the share tags', () => {
  const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
  const authored = 'Tom &amp; Jerry say &quot;hi&quot;'; // what the slot renders
  const printed = escape(unescapeAttr(authored)); // what Base.astro prints in og:description
  assert.equal(printed, authored);
  assert.notEqual(escape(authored), authored); // the old behaviour doubled it
});
