import assert from 'node:assert/strict';
import { test } from 'node:test';
import { entryCosts, summaryBody, taskCost } from '../lib.mjs';

const at = (h, m = 0) => new Date(2026, 10, 25, h, m).toISOString();

test('a resumed session is counted once: each run costs its total minus the previous total (INV-47)', () => {
  const entries = [
    { issue: 'INV-70', session: 'a', sessionCostUsd: 2.5, ended: at(10) },
    { issue: 'INV-70', session: 'a', sessionCostUsd: 3.75, ended: at(11) },
    { issue: 'INV-70', session: 'b', sessionCostUsd: 4, ended: at(12) },
    { issue: 'INV-70', status: 'review', costUsd: 0.4, ended: at(13) },
  ];
  assert.deepEqual(entryCosts(entries), [2.5, 1.25, 4, 0.4]);
});

test('a task costs its sessions and its reviews since it was taken from Ready, not an older run of the same id', () => {
  const entries = [
    { issue: 'INV-70', session: 'old', costUsd: 9, ended: at(8) },
    { issue: 'INV-70', session: 'a', sessionCostUsd: 2.5, ended: at(10) },
    { issue: 'INV-71', session: 'c', sessionCostUsd: 7, ended: at(10) },
    { issue: 'INV-70', status: 'review', costUsd: 0.4, ended: at(11) },
  ];
  assert.deepEqual(taskCost(entries, 'INV-70', at(9)), { sessions: 2.5, reviews: 0.4, total: 2.9 });
});

test('the summary says what was done, the PR, what the review caught and the cost', () => {
  const body = summaryBody({
    pr: 'https://github.com/o/r/pull/30', report: 'Добавен е endpoint POST /x.',
    reviews: [{ round: 0, verdict: 'FAIL', findings: ['- critical a.ts:3 - пари извън packages/domain/money'] }, { round: 1, verdict: 'PASS', findings: [] }],
    cost: { sessions: 2.5, reviews: 0.8, total: 3.3 }, minutes: 42,
  });
  assert.match(body, /PR: https:\/\/github\.com\/o\/r\/pull\/30/);
  assert.match(body, /Добавен е endpoint/);
  assert.match(body, /Кръг 0: FAIL\n {2}- critical a\.ts:3/);
  assert.match(body, /\$3\.30 \(сесии \$2\.50, ревю \$0\.80\)/);
  assert.match(summaryBody({ pr: 'p', report: '', reviews: [{ round: 0, verdict: 'PASS', findings: [] }], cost: { sessions: 0, reviews: 0, total: 0 } }), /мина от първия път/);
});
