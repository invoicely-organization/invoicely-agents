import assert from 'node:assert/strict';
import { test } from 'node:test';
import { nightReport, nightStart, sessionBudget, spentSince } from '../lib.mjs';

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

test('a session never gets more than what is left of the night, and none when under $2 is left', () => {
  assert.equal(sessionBudget(15, 60, 21.75), 15);
  assert.equal(sessionBudget(15, 60, 50), 10);
  assert.equal(sessionBudget(15, 60, 58.5), 0);
});

test('the night report has one line per task, the CI evals apart and the total against the cap', () => {
  const report = nightReport(entries, since, 60);
  assert.match(report, /общо \$21\.75 от тавана \$60/);
  assert.match(report, /\| INV-31 \| слято \| 1 \| 40 \| 12\.50 \| 3\.25 \| https:\/\/github\.com\/o\/r\/pull\/20 \|/);
  assert.match(report, /\| INV-32 \| спрян от лимита \| 1 \| 20 \| 6\.00 \| 0\.00 \| - \|/);
  assert.doesNotMatch(report, /INV-30/);
});
