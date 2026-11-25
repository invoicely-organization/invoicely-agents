import assert from 'node:assert/strict';
import { test } from 'node:test';
import { summaryBody } from '../lib.mjs';

// INV-69: the time in the summary the runner writes after the merge is shown in hours and minutes above 60 minutes.
const summary = (minutes) => summaryBody({
  pr: 'https://github.com/invoicely-organization/invoicely/pull/112',
  report: 'Добавено е изчисляване на клетки 11 и 21 от дневника за продажби за октомври 2026.',
  reviews: [{ round: 0, verdict: 'FAIL', findings: ['- major packages/domain/src/vat/sales-cells.ts:41 - сумата не е в евроцентове'] }, { round: 1, verdict: 'PASS', findings: [] }],
  cost: { sessions: 4.25, reviews: 0.9, total: 5.15 },
  ...(minutes === undefined ? {} : { minutes }),
});

// INV-69 check 1: a task that took 85 minutes: the summary says "Време: 1 ч 25 мин."
test('check 1: 85 minutes is shown as "Време: 1 ч 25 мин."', () => {
  const body = summary(85);
  assert.ok(body.includes('Време: 1 ч 25 мин.'), `expected "Време: 1 ч 25 мин." in:\n${body}`); // check 1
  assert.ok(!body.includes('85 мин'), `minutes alone must not be shown:\n${body}`); // check 1: not only in minutes
});

// INV-69 check 2: a task that took 42 minutes: the summary says "Време: 42 мин."
test('check 2: 42 minutes is shown as "Време: 42 мин." without hours', () => {
  const body = summary(42);
  assert.ok(body.includes('Време: 42 мин.'), `expected "Време: 42 мин." in:\n${body}`); // check 2
  assert.ok(!/Време: 0 ч/.test(body), `no zero hours expected:\n${body}`); // check 2
});

// INV-69 check 3: a task that took exactly 120 minutes: the summary says "Време: 2 ч."
test('check 3: exactly 120 minutes is shown as "Време: 2 ч." without minutes', () => {
  const body = summary(120);
  assert.ok(body.includes('Време: 2 ч.'), `expected "Време: 2 ч." in:\n${body}`); // check 3
  assert.ok(!body.includes('120 мин'), `minutes alone must not be shown:\n${body}`); // check 3
  assert.ok(!body.includes('0 мин'), `no zero minutes expected:\n${body}`); // check 3
});

// INV-69 check 4: no time (the task has no start): the summary has no time line, as now.
test('check 4: without minutes the summary has no time line', () => {
  const body = summary(undefined);
  assert.ok(!body.includes('Време'), `no time line expected:\n${body}`); // check 4
  assert.match(body, /PR: https:\/\/github\.com\/invoicely-organization\/invoicely\/pull\/112/); // check 4: the rest of the summary is still there
});
