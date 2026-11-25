import assert from 'node:assert/strict';
import { test } from 'node:test';
import { statusAction } from '../lib.mjs';

const queued = { issue: 'INV-34', branch: 'inv-34-orchestrator', base: 'feature/INV-10' };
const waitingForCi = { ...queued, stage: 'ci', pr: 'https://github.com/o/r/pull/20' };
const state = (name, type = 'started') => ({ name, type });

test('a task in the queue is In Progress; "Чака Йоан" left over from a gone question is replaced with a note', () => {
  assert.deepEqual(statusAction(queued, state('Чака Йоан')), { action: 'set', want: 'In Progress', note: true });
  assert.deepEqual(statusAction(queued, state('Ready', 'unstarted')), { action: 'set', want: 'In Progress', note: false });
  assert.deepEqual(statusAction(queued, state('In Progress')), { action: 'none' });
});

test('a task whose PR waits for CI is In Review', () => {
  assert.deepEqual(statusAction(waitingForCi, state('In Progress')), { action: 'set', want: 'In Review', note: false });
  assert.deepEqual(statusAction(waitingForCi, state('Чака Йоан')), { action: 'set', want: 'In Review', note: true });
  assert.deepEqual(statusAction(waitingForCi, state('In Review')), { action: 'none' });
});

test('Backlog or Canceled means Yoan stopped it: it leaves the queue', () => {
  assert.deepEqual(statusAction(queued, state('Backlog', 'backlog')), { action: 'remove' });
  assert.deepEqual(statusAction(queued, state('Canceled', 'canceled')), { action: 'remove' });
});

test('In Review on a fix round and Done are left as they are', () => {
  assert.deepEqual(statusAction(queued, state('In Review')), { action: 'none' });
  assert.deepEqual(statusAction(queued, state('Done', 'completed')), { action: 'none' });
});
