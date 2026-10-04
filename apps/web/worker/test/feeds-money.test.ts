import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMoneyToCents, parseShippingText } from '../feeds/money.ts';
import { intVar } from '../feeds/types.ts';

test('parseMoneyToCents: strings and numbers to exact integer cents', () => {
  const cases: Array<[unknown, number | null]> = [
    ['12.99', 1299], ['$1,299.00', 129900], ['US $9.99', 999], ['12', 1200], ['0.5', 50], ['1.005', 101], ['1.004', 100],
    [10.99, 1099], [19.99, 1999], [0.1 + 0.2, 30], [144.99, 14499], [7, 700],
    ['', null], ['abc', null], ['-1.00', null], [-1, null], [Number.NaN, null], [1e21, null], [null, null], [{}, null], ['12.99 USD', null],
  ];
  for (const [input, want] of cases) assert.equal(parseMoneyToCents(input), want, String(input));
});

test('parseMoneyToCents: comma only as US thousands grouping, zero stays valid', () => {
  const cases: Array<[unknown, number | null]> = [
    ['12,99', null], ['1,23', null], ['1,2345.00', null], [',5', null], ['1,234.56', 123456], ['$1,299.00', 129900], ['0.00', 0], ['1,234', 123400],
  ];
  for (const [input, want] of cases) assert.equal(parseMoneyToCents(input), want, String(input));
  assert.equal(parseShippingText('$1,299.00 delivery'), 129900);
});

test('parseShippingText: free, dollar amounts, unknown', () => {
  assert.equal(parseShippingText('Free delivery'), 0);
  assert.equal(parseShippingText('Get it by Wed (Free)'), 0);
  assert.equal(parseShippingText('$5.99 delivery'), 599);
  assert.equal(parseShippingText('Delivery by Fri'), null);
  assert.equal(parseShippingText('$1,299.00'), 129900);
  assert.equal(parseShippingText('Free shipping'), 0);
  assert.equal(parseShippingText('$5.99, arrives Fri'), 599);
  assert.equal(parseShippingText('$5.99.'), 599);
  for (const bad of ['$12,99 delivery', '$12.995 delivery', '$1234567 delivery', '$1,2345 delivery']) assert.equal(parseShippingText(bad), null, bad);
  assert.equal(parseShippingText(undefined), null);
});

test('intVar parses non-negative integers with fallback', () => {
  assert.equal(intVar('8', 1), 8);
  assert.equal(intVar(undefined, 3), 3);
  assert.equal(intVar('-2', 3), 3);
  assert.equal(intVar('x', 3), 3);
});
