import assert from 'node:assert/strict';
import { test } from 'node:test';
import { entryCosts, nightReport, nightStart, sessionBudget, spendingPeriod, spentSince, taskSpent } from '../lib.mjs';

test('a moment belongs to the night that began at the last 22:00', () => {
  assert.deepEqual(nightStart(new Date(2026, 10, 25, 3, 0), 22), new Date(2026, 10, 24, 22, 0));
  assert.deepEqual(nightStart(new Date(2026, 10, 24, 23, 30), 22), new Date(2026, 10, 24, 22, 0));
  assert.deepEqual(nightStart(new Date(2026, 10, 25, 10, 0), 22), new Date(2026, 10, 24, 22, 0));
});

const since = new Date(2026, 10, 24, 22, 0);
const at = (h, m = 0) => new Date(2026, 10, h < 12 ? 25 : 24, h, m).toISOString();
const entries = [
  { issue: 'INV-30', ended: new Date(2026, 10, 24, 21, 0).toISOString(), status: 'done', costUsd: 99 },
  { issue: 'INV-31', ended: at(23), status: 'done', minutes: 40, costUsd: 12.5, pr: 'https://github.com/o/r/pull/20' },
  { issue: 'INV-31', ended: at(23, 50), status: 'ci-evals', costUsd: 3.25 },
  { issue: 'INV-31', ended: at(23, 55), status: 'merged', pr: 'https://github.com/o/r/pull/20' },
  { issue: 'INV-32', ended: at(1), status: 'limit', minutes: 20, costUsd: 6 },
];

test('the night spend counts sessions and CI evals since the night began, not before', () => {
  assert.equal(spentSince(entries, since), 21.75);
});

test('a session never gets more than what is left of the period, and none when under $2 is left', () => {
  assert.deepEqual(sessionBudget({ taskCap: 15, periodCap: 60, periodSpent: 21.75 }), { budget: 15, stoppedBy: null });
  assert.deepEqual(sessionBudget({ taskCap: 15, periodCap: 60, periodSpent: 50 }), { budget: 10, stoppedBy: null });
  assert.deepEqual(sessionBudget({ taskCap: 15, periodCap: 60, periodSpent: 58.5 }), { budget: 0, stoppedBy: 'period' });
});

test('a task never gets more than what is left of its own cap over all its sessions (INV-47)', () => {
  assert.deepEqual(sessionBudget({ taskCap: 15, taskSpent: 9.7, periodCap: 60, periodSpent: 10 }), { budget: 5.3, stoppedBy: null });
  assert.deepEqual(sessionBudget({ taskCap: 15, taskSpent: 14, periodCap: 60, periodSpent: 10 }), { budget: 0, stoppedBy: 'task' });
});

// A resumed session reports the total of the whole session: 5.07, then 7.25 after the next run, then 8.38.
const resumed = [
  { issue: 'INV-31', session: 's31', ended: at(22, 30), status: 'needs_answer', minutes: 10, costUsd: 5.07 },
  { issue: 'INV-31', session: 's31', ended: at(22, 41), status: 'needs_answer', minutes: 10, costUsd: 7.25 },
  { issue: 'INV-31', session: 's31', ended: at(22, 50), status: 'done', minutes: 7, costUsd: 8.38 },
  { issue: 'INV-31', ended: at(23, 5), status: 'ci-evals', costUsd: 5.61 },
  { issue: 'INV-32', session: 's32', ended: at(23, 5), status: 'done', minutes: 14, costUsd: 6.22, sessionCostUsd: 6.22 },
  { issue: 'INV-32', session: 's32', ended: at(23, 18), status: 'done', minutes: 4, costUsd: 0.28, sessionCostUsd: 6.5 },
];

test('a resumed session is counted once: each run costs its total minus the previous total (INV-47)', () => {
  const costs = entryCosts(resumed).map((c) => Math.round(c * 100) / 100);
  assert.deepEqual(costs, [5.07, 2.18, 1.13, 5.61, 6.22, 0.28]);
  assert.equal(Math.round(spentSince(resumed, since) * 100) / 100, 20.49);
  assert.equal(Math.round(taskSpent(resumed, 'INV-31') * 100) / 100, 8.38);
});

test('the ledger of 24 to 25.11 counts $27.41 for the night, not the $69.50 that stopped the runner (INV-47)', () => {
  const night = [
    ['INV-31', 'a', 5.0658316], ['INV-31', 'a', 7.250577], ['INV-31', 'a', 8.380969], ['INV-31', 'a', 8.6793968],
    ['INV-32', 'b', 6.2205274], ['INV-31', null, 5.61, 'ci-evals'], ['INV-31', 'a', 9.7032442], ['INV-32', 'b', 6.4963648],
    ['INV-32', 'b', 7.2730928], ['INV-32', null, 4.82, 'ci-evals'],
  ].map(([issue, session, costUsd, status = 'done'], i) => ({ issue, session, costUsd, status, ended: at(22 + Math.floor(i / 6), (i * 9) % 60) }));
  const naive = night.reduce((sum, e) => sum + e.costUsd, 0);
  assert.equal(naive.toFixed(2), '69.50');
  assert.equal(spentSince(night, since).toFixed(2), '27.41');
});

test('a run by day belongs to the day period with its own cap; a run at night to the night', () => {
  const config = { windowStart: 22, windowEnd: 8, nightBudgetUsd: 60, dayBudgetUsd: 20 };
  assert.deepEqual(spendingPeriod(new Date(2026, 10, 25, 3, 0), config), { kind: 'night', start: new Date(2026, 10, 24, 22, 0), cap: 60 });
  assert.deepEqual(spendingPeriod(new Date(2026, 10, 25, 14, 0), config), { kind: 'day', start: new Date(2026, 10, 25, 8, 0), cap: 20 });
  assert.deepEqual(spendingPeriod(new Date(2026, 10, 25, 21, 59), config), { kind: 'day', start: new Date(2026, 10, 25, 8, 0), cap: 20 });
});

test('the night report has one line per task, the CI evals apart and the total against the cap', () => {
  const report = nightReport(entries, since, 60);
  assert.match(report, /общо \$21\.75 от тавана \$60/);
  assert.match(report, /\| INV-31 \| слято \| 1 \| 40 \| 12\.50 \| 3\.25 \| https:\/\/github\.com\/o\/r\/pull\/20 \|/);
  assert.match(report, /\| INV-32 \| спрян от лимита \| 1 \| 20 \| 6\.00 \| 0\.00 \| - \|/);
  assert.doesNotMatch(report, /INV-30/);
});
