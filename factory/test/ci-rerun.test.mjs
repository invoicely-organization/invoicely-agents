import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixMessage, fixPrecheck, shouldRerunEvals } from '../lib.mjs';

test('a queued fix round looks at its PR again: no session when it no longer fails, evals alone are rerun first (INV-60)', () => {
  assert.equal(fixPrecheck({ verdict: 'pending' }, {}), 'ci');
  assert.equal(fixPrecheck({ verdict: 'merged' }, {}), 'ci');
  assert.equal(fixPrecheck({ verdict: 'fail', failed: ['evals'] }, {}), 'rerun-evals');
  assert.equal(fixPrecheck({ verdict: 'fail', failed: ['evals'] }, { evalReruns: 1 }), 'run');
  assert.equal(fixPrecheck({ verdict: 'fail', failed: ['merge conflict with feature/INV-10'] }, {}), 'run');
  assert.equal(fixPrecheck({ verdict: 'fail', failed: ['evals', 'review'] }, {}), 'run');
});

test('when only the evals failed, CI runs them once more before an agent is woken up (INV-53)', () => {
  assert.equal(shouldRerunEvals(['evals'], {}), true);
  assert.equal(shouldRerunEvals(['evals'], { evalReruns: 1 }), false);
  assert.equal(shouldRerunEvals(['evals', 'secret scan'], {}), false);
  assert.equal(shouldRerunEvals(['merge conflict with feature/INV-10'], {}), false);
  assert.equal(shouldRerunEvals([], {}), false);
});

test('a fix round tells the agent to fix only what its task changed', () => {
  const message = fixMessage({ pr: 'https://github.com/o/r/pull/20', failed: ['evals'], branch: 'inv-31-reviewer', base: 'feature/INV-10' });
  assert.match(message, /Fix only what this task changed/);
  assert.match(message, /do not change that agent or its cases/);
});
