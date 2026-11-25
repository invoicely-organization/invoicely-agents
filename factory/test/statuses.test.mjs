import assert from 'node:assert/strict';
import { test } from 'node:test';
import { statusAction } from '../lib.mjs';

const working = { issue: 'INV-70', branch: 'inv-70-x', stage: 'code' };
const inReview = { ...working, stage: 'review', pr: 'https://github.com/o/r/pull/30' };
const state = (name, type = 'started') => ({ name, type });

test('a task in the queue is In Progress; "Чака Йоан" left over from a gone question is replaced with a note', () => {
  assert.deepEqual(statusAction(working, state('Чака Йоан')), { action: 'set', want: 'In Progress', note: true });
  assert.deepEqual(statusAction(working, state('Ready', 'unstarted')), { action: 'set', want: 'In Progress', note: false });
  assert.deepEqual(statusAction(working, state('In Progress')), { action: 'none' });
  assert.deepEqual(statusAction({ ...working, stage: 'fix' }, state('In Review')), { action: 'set', want: 'In Progress', note: false });
});

test('a task whose PR is with the reviewer is In Review', () => {
  assert.deepEqual(statusAction(inReview, state('In Progress')), { action: 'set', want: 'In Review', note: false });
  assert.deepEqual(statusAction(inReview, state('Чака Йоан')), { action: 'set', want: 'In Review', note: true });
  assert.deepEqual(statusAction(inReview, state('In Review')), { action: 'none' });
});

test('Backlog or Canceled means Yoan stopped it: it leaves the queue; Done is left as it is', () => {
  assert.deepEqual(statusAction(working, state('Backlog', 'backlog')), { action: 'remove' });
  assert.deepEqual(statusAction(working, state('Canceled', 'canceled')), { action: 'remove' });
  assert.deepEqual(statusAction(working, state('Done', 'completed')), { action: 'none' });
});
