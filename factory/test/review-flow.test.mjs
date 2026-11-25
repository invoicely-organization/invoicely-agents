import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checksVerdict, failedChecks, findingLines, fixMessage, isReviewCheck, nextRunnable, reviewMarker, reviewOfHead, reviewText } from '../lib.mjs';

const BOT = { login: 'github-actions[bot]' };
const review = (verdict, sha, extra = {}) => ({
  id: extra.id ?? 1, user: extra.user ?? BOT, commit_id: sha,
  body: `## Ревю: ${verdict}\n\nVerdict: ${verdict}\n\nFindings\n- critical packages/x.ts:12 - грешна клетка.\n\n<sub>Цена: $0.40</sub>\n<!-- invoicely-review verdict=${verdict} sha=${sha} cost=0.4012 -->`,
});

test('the review check is left out of CI, also from the shared workflow', () => {
  assert.equal(isReviewCheck('review'), true);
  assert.equal(isReviewCheck('review / review'), true);
  assert.equal(isReviewCheck('validate and hook tests'), false);
  const checks = [{ name: 'validate and hook tests', bucket: 'pass' }, { name: 'secret scan', bucket: 'pass' }, { name: 'review / review', bucket: 'fail' }];
  assert.equal(checksVerdict(checks), 'pass', 'a red review check is the review\'s verdict, not CI\'s');
  assert.equal(checksVerdict([{ name: 'secret scan', bucket: 'pending' }]), 'pending');
  assert.equal(checksVerdict([{ name: 'review', bucket: 'pass' }]), 'pending', 'no own checks yet');
  assert.deepEqual(failedChecks([...checks, { name: 'secret scan', bucket: 'fail' }]), ['secret scan']);
});

test('the verdict comes from the review job\'s marker on the PR\'s head, never from anyone else\'s review', () => {
  assert.deepEqual(reviewMarker(review('PASS', 'abc').body), { verdict: 'PASS', sha: 'abc', costUsd: 0.4012 });
  assert.equal(reviewMarker('LGTM'), null);
  const reviews = [review('FAIL', 'old', { id: 1 }), review('LIMIT', 'abc', { id: 2 }), review('PASS', 'abc', { id: 3 }), review('PASS', 'abc', { id: 4, user: { login: 'someone' } })];
  assert.equal(reviewOfHead(reviews, 'abc').id, 3);
  assert.equal(reviewOfHead(reviews, 'new'), null, 'a new push needs a new review');
  assert.equal(reviewOfHead([review('PASS', 'abc', { user: { login: 'someone' } })], 'abc'), null);
});

test('the implementer gets the review without its marker, and Linear its finding lines', () => {
  const text = reviewText(review('FAIL', 'abc').body);
  assert.doesNotMatch(text, /invoicely-review|<sub>/);
  assert.deepEqual(findingLines(text), ['- critical packages/x.ts:12 - грешна клетка.']);
  const message = fixMessage({ round: 2, maxRounds: 3, review: text, failed: ['secret scan'] });
  assert.match(message, /Fix round 2 of 3/);
  assert.match(message, /грешна клетка/);
  assert.match(message, /secret scan/);
  assert.match(message, /RESULT: TEST_WRONG/);
  assert.match(fixMessage({ round: 1, maxRounds: 3, conflict: true }), /git merge origin\/main/);
});

test('the next step: not a task waiting for its review, not one waiting for the limit', () => {
  const now = new Date('2026-11-25T14:00:00Z');
  const queue = [
    { issue: 'INV-70', stage: 'review' },
    { issue: 'INV-71', stage: 'code', waitUntil: '2026-11-25T15:00:00Z' },
    { issue: 'INV-72', stage: 'tests' },
  ];
  assert.equal(nextRunnable(queue, now).issue, 'INV-72');
  assert.equal(nextRunnable(queue, new Date('2026-11-25T15:01:00Z')).issue, 'INV-71');
  assert.equal(nextRunnable([{ issue: 'INV-70', stage: 'review' }], now), null);
});
