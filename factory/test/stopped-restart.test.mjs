import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { newQueueEntry, stoppedTaskPlan } from '../lib.mjs';

// INV-73: a task Yoan stopped (Backlog, Canceled) and put back in Ready goes on where it stopped only when its copy is
// still on disk and its PR, if it has one, is open. Otherwise the runner starts it over as a new task.
//
// Contract (test-author, INV-73 Agent notes: "a pure function in factory/lib.mjs; takeReady only calls it with what it
// saw on disk and in GitHub"):
//   stoppedTaskPlan({ stopped, copyExists, prState }) -> 'resume' | 'restart'
//     stopped:    the task as the ledger kept it when Yoan stopped it (last.task)
//     copyExists: fs.existsSync(copyPath(stopped))
//     prState:    the state gh gives for stopped.pr ('OPEN', 'CLOSED', 'MERGED'), or null when the task has no PR
//   newQueueEntry(task, { branch, brief, since }) -> the queue entry of a new task (stage tests, no sessions)
//     task: the task as planFromReady gives it from Linear (without its text)

// A task stopped at review, like INV-65 (Agent notes: stopped at review, copy removed, PR #6 closed).
const stoppedAtReview = {
  issue: 'INV-65', repo: 'invoicely', title: 'Скелет на продукта: repo, CI и CLAUDE.md', ui: false,
  branch: 'inv-65-skelet-na-produkta', brief: '/Users/yoan/.invoicely/briefs/INV-65.md', stage: 'review',
  since: '2026-11-20T09:12:00.000Z', sessions: { 'test-author': 'a1f0c2d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d', implementer: 'b2e1d3c5-6f70-4b8c-9dae-1f2a3b4c5d6e' },
  pr: 'https://github.com/invoicely-organization/invoicely/pull/6', testsCommit: '9c3e5a7b1d2f4e6a8b0c1d3e5f7a9b2c4d6e8f0a',
  testFiles: ['packages/domain/src/invoice/totals.test.ts'],
};
// A task stopped while the implementer worked: no PR yet.
const stoppedAtCode = {
  issue: 'INV-66', repo: 'invoicely', title: 'Фактура: номер от 10 цифри', ui: false,
  branch: 'inv-66-faktura-nomer', brief: '/Users/yoan/.invoicely/briefs/INV-66.md', stage: 'code',
  since: '2026-11-21T10:00:00.000Z', sessions: { 'test-author': 'c3f2e4d6-7081-4c9d-8ebf-2a3b4c5d6e7f' },
  testsCommit: '1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b', testFiles: ['packages/domain/src/invoice/number.test.ts'],
};

// INV-73 check 1: a stopped task whose copy was removed, put back in Ready, starts over.
test('check 1: a stopped task whose copy was removed starts over', () => {
  assert.equal(stoppedTaskPlan({ stopped: stoppedAtReview, copyExists: false, prState: 'CLOSED' }), 'restart'); // check 1 (the INV-65 case)
  assert.equal(stoppedTaskPlan({ stopped: stoppedAtReview, copyExists: false, prState: 'OPEN' }), 'restart'); // Какво: resume only if the copy is on disk
  assert.equal(stoppedTaskPlan({ stopped: stoppedAtCode, copyExists: false, prState: null }), 'restart'); // Какво: no copy, no PR
});

// INV-73 check 1: it enters the queue at stage tests with a new brief, without the old sessions, without pr and testsCommit.
test('check 1: the task that starts over enters the queue at tests with the new brief, no old sessions, no pr, no testsCommit', () => {
  // The task as planFromReady gives it from Linear when Yoan puts INV-65 back in Ready.
  const fromLinear = { issue: 'INV-65', repo: 'invoicely', title: 'Скелет на продукта: repo, CI и CLAUDE.md', ui: false };
  const entry = newQueueEntry(fromLinear, {
    branch: 'inv-65-skelet-na-produkta-2', brief: '/Users/yoan/.invoicely/briefs/INV-65.md', since: '2026-11-26T08:30:00.000Z',
  });
  assert.equal(entry.stage, 'tests'); // check 1: stage tests
  assert.equal(entry.brief, '/Users/yoan/.invoicely/briefs/INV-65.md'); // check 1: the new brief
  assert.deepEqual(entry.sessions, {}); // check 1: without the old sessions
  assert.equal('pr' in entry, false); // check 1: without pr
  assert.equal('testsCommit' in entry, false); // check 1: without testsCommit
  assert.equal('testFiles' in entry, false); // Какво: as a new task, nothing of the old tests
  assert.equal('message' in entry, false); // Какво: as a new task, no "continue where you stopped"
  assert.equal(entry.issue, 'INV-65');
  assert.equal(entry.repo, 'invoicely');
  assert.equal(entry.branch, 'inv-65-skelet-na-produkta-2');
  assert.equal(entry.since, '2026-11-26T08:30:00.000Z');
});

// INV-73 check 2: a stopped task whose copy is on disk but whose PR is closed also starts over.
test('check 2: a stopped task whose copy is on disk but whose PR is closed starts over', () => {
  assert.equal(stoppedTaskPlan({ stopped: stoppedAtReview, copyExists: true, prState: 'CLOSED' }), 'restart'); // check 2
  // Какво: it goes on only if the PR "is open"; a merged PR is not open either.
  assert.equal(stoppedTaskPlan({ stopped: stoppedAtReview, copyExists: true, prState: 'MERGED' }), 'restart'); // Какво
});

// INV-73 check 3: a stopped task whose copy is on disk and whose PR is open (or that has no PR yet) goes on from its stage.
test('check 3: a stopped task with its copy on disk and an open PR, or no PR yet, goes on from its stage', () => {
  assert.equal(stoppedTaskPlan({ stopped: stoppedAtReview, copyExists: true, prState: 'OPEN' }), 'resume'); // check 3: open PR
  assert.equal(stoppedTaskPlan({ stopped: stoppedAtCode, copyExists: true, prState: null }), 'resume'); // check 3: no PR yet
});

test('check 3: the decision is pure: it does not change the stopped task', () => {
  const before = structuredClone(stoppedAtReview);
  stoppedTaskPlan({ stopped: stoppedAtReview, copyExists: false, prState: 'CLOSED' });
  stoppedTaskPlan({ stopped: stoppedAtReview, copyExists: true, prState: 'OPEN' });
  assert.deepEqual(stoppedAtReview, before); // Agent notes: a pure function
});

// INV-73 check 4: the task that starts over goes through the "Как проверявам" check (sessionGate, INV-71) and gets its
// documents like every new task. takeReady talks to Linear and GitHub, so this reads its source: the decision is
// asked in takeReady, before the gate, and a new task's entry comes from newQueueEntry after the gate, so a restart
// reaches the same path as a new task.
const FACTORY = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), 'factory.mjs');
function takeReadySource() {
  const src = fs.readFileSync(FACTORY, 'utf8');
  const start = src.indexOf('async function takeReady(');
  assert.notEqual(start, -1, 'takeReady is in factory.mjs');
  const end = src.indexOf('\n}\n', start);
  return src.slice(start, end);
}

test('check 4: in takeReady the restart decision comes before the "Как проверявам" gate, and a restarted task is queued as a new one', () => {
  const body = takeReadySource();
  const decide = body.indexOf('stoppedTaskPlan(');
  const gate = body.indexOf('sessionGate(');
  const entry = body.indexOf('newQueueEntry(');
  assert.notEqual(decide, -1, 'takeReady asks stoppedTaskPlan'); // Agent notes: takeReady only calls it
  assert.notEqual(gate, -1, 'takeReady runs the INV-71 gate'); // check 4
  assert.notEqual(entry, -1, 'takeReady queues new tasks with newQueueEntry'); // check 1 and 4
  assert.ok(decide < gate, 'the decision for a stopped task is made before the gate, so a restart goes through it'); // check 4
  assert.ok(gate < entry, 'the new entry is made after the gate'); // check 4
  assert.ok(body.includes('copyPath('), 'takeReady looks for the copy with copyPath'); // Agent notes: the copy is copyPath(task)
});
