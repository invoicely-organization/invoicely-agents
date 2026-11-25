import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sumCents } from './money.ts';

// INV-21 criterion 1: Given amounts in euro cents, When they are summed, Then the sum is exact.
test('criterion 1: sums 12550 and 7450 cents to 20000', () => {
  assert.equal(sumCents([12550, 7450]), 20000); // criterion 1
});

// INV-21 criterion 2: Given an amount that is not whole cents, When it is summed, Then it is refused.
test('criterion 2: refuses 100.5 cents', () => {
  assert.throws(() => sumCents([100.5]), /not integer cents/); // criterion 2
});
