import assert from 'node:assert/strict';
import { test } from 'node:test';
import { budgetAnswer } from '../lib.mjs';

test('Yoan\'s answer to a task over its cap: stop, go on, or go on with his words for the agent', () => {
  assert.equal(budgetAnswer('продължи'), 'continue');
  assert.equal(budgetAnswer('  Продължи! '), 'continue');
  assert.equal(budgetAnswer('спри'), 'stop');
  assert.equal(budgetAnswer('Спри я, ще я поема'), 'stop');
});

test('Cyrillic words are not cut short (independent review, 25.11)', () => {
  assert.equal(budgetAnswer('продължи, но поправи само теста'), 'continue-with-note');
  assert.equal(budgetAnswer('продължи до края на спринта'), 'continue-with-note');
  assert.equal(budgetAnswer('продължи само с eval-ите'), 'continue-with-note');
});
