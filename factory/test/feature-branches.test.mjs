import assert from 'node:assert/strict';
import { test } from 'node:test';
import { blockingDeps, checksVerdict, failedChecks, fixMessage, isFeatureBranch, nextRunnable } from '../lib.mjs';

test('only feature/ branches are feature branches', () => {
  assert.equal(isFeatureBranch('feature/INV-10'), true);
  assert.equal(isFeatureBranch('main'), false);
  assert.equal(isFeatureBranch(undefined), false);
});

test('CI is green only when every check passed or was skipped', () => {
  assert.equal(checksVerdict([]), 'pending');
  assert.equal(checksVerdict(null), 'pending');
  assert.equal(checksVerdict([{ name: 'a', bucket: 'pass' }, { name: 'b', bucket: 'skipping' }]), 'pass');
  assert.equal(checksVerdict([{ name: 'a', bucket: 'pass' }, { name: 'b', bucket: 'pending' }]), 'pending');
  assert.equal(checksVerdict([{ name: 'a', bucket: 'pending' }, { name: 'evals', bucket: 'fail' }]), 'fail');
  assert.equal(checksVerdict([{ name: 'a', bucket: 'cancel' }]), 'fail');
  assert.deepEqual(failedChecks([{ name: 'evals', bucket: 'fail' }, { name: 'x', bucket: 'pass' }, { name: 'y', bucket: 'cancel' }]), ['evals', 'y']);
});

test('a task waits until its dependencies are merged into its own base', () => {
  const a = { issue: 'INV-31', base: 'feature/INV-10' };
  const b = { issue: 'INV-34', base: 'feature/INV-10', dependsOn: ['INV-31', 'INV-32'] };
  const c = { issue: 'INV-36' };
  assert.deepEqual(blockingDeps(b, new Set(['INV-31'])), ['INV-32']);
  const merged = new Map([['feature/INV-10', new Set(['INV-31', 'INV-32'])], ['main', new Set()]]);
  assert.equal(nextRunnable([b, c], new Map([['feature/INV-10', new Set(['INV-31'])]])), c);
  assert.equal(nextRunnable([b, c], merged), b);
  assert.equal(nextRunnable([{ ...a, stage: 'ci' }, c], merged), c, 'a task waiting for CI is not run again');
  assert.equal(nextRunnable([{ issue: 'INV-35', dependsOn: ['INV-31'] }], merged), null, 'merged into another base does not count');
});

test('the fix message names the failed checks, the branch and the PR, and forbids a new PR', () => {
  const text = fixMessage({ pr: 'https://github.com/o/r/pull/12', failed: ['evals'], branch: 'inv-31-reviewer' });
  assert.match(text, /evals/);
  assert.match(text, /git push to inv-31-reviewer/);
  assert.match(text, /Do not open a new PR/);
  assert.match(text, /pull\/12$/);
});
