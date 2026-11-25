import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cleanupSummary, oldLogs, parseWorktrees, planCleanup, prForBranch } from '../janitor.mjs';

// The state of 25.11 in short: one merged task, two open PRs, one queued task, the runner's own copies.
const prs = [
  { number: 21, headRefName: 'inv-32-test-author', headRefOid: 'd4681cf', state: 'MERGED' },
  { number: 20, headRefName: 'inv-31-reviewer', headRefOid: 'd2b4392', state: 'OPEN' },
  { number: 19, headRefName: 'inv-30-45-linear', headRefOid: '299c916', state: 'OPEN' },
  { number: 17, headRefName: 'inv-39-ledger', headRefOid: 'beba9c2', state: 'CLOSED' },
  { number: 9, headRefName: 'inv-38-factory-runner', headRefOid: '45b1143', state: 'MERGED' },
  { number: 3, headRefName: 'inv-14-role-guard', headRefOid: '7340dd9', state: 'MERGED' },
];
const copies = [
  { path: '/p/ia-wt/inv-32-test-author', branch: 'inv-32-test-author', head: 'd4681cf', dirty: false },
  { path: '/p/ia-wt/inv-31-reviewer', branch: 'inv-31-reviewer', head: 'd2b4392', dirty: false },
  { path: '/p/ia-wt/inv-30-linear-app', branch: 'inv-30-45-linear', head: '299c916', dirty: false },
  { path: '/p/ia-wt/inv-33-backend-engineer', branch: 'inv-33-backend-engineer', head: '8042207', dirty: true },
  { path: '/p/ia-wt/plugin-runtime', branch: null, head: 'b021c34', dirty: false },
  { path: '/p/ia-wt/factory-runner', branch: null, head: '299c916', dirty: false },
];
const queue = [{ issue: 'INV-31', branch: 'inv-31-reviewer' }, { issue: 'INV-33', branch: 'inv-33-backend-engineer' }];

test('the copy of a merged task goes; queued, open and the runner\'s own copies stay', () => {
  const plan = planCleanup({ copies, prs, queue, protectedPaths: ['/p/ia-wt/plugin-runtime', '/p/ia-wt/factory-runner'] });
  assert.deepEqual(plan.removeCopies.map((c) => c.branch), ['inv-32-test-author']);
  assert.deepEqual(plan.keepCopies.map((c) => c.why), [
    'its task is in the queue', 'PR #19 is open', 'its task is in the queue', 'the runner needs it', 'the runner needs it',
  ]);
  assert.deepEqual(plan.report, []);
});

test('a copy whose PR is over but that holds unsaved work stays and is reported', () => {
  const dirty = [{ path: '/p/x', branch: 'inv-32-test-author', head: 'd4681cf', dirty: true }];
  const ahead = [{ path: '/p/y', branch: 'inv-32-test-author', head: 'ffff000', dirty: false }];
  assert.match(planCleanup({ copies: dirty, prs }).report[0].why, /uncommitted changes/);
  assert.match(planCleanup({ copies: ahead, prs }).report[0].why, /commits that are not in it/);
  assert.equal(planCleanup({ copies: ahead, prs }).removeCopies.length, 0);
});

test('a branch goes only when its PR is over and its tip is the PR head', () => {
  const plan = planCleanup({
    copies, prs, queue,
    localBranches: [
      { name: 'main', head: 'b021c34' },
      { name: 'inv-38-factory-runner', head: '45b1143' },
      { name: 'inv-14-role-guard', head: 'b7c4bf5' }, // a commit after the merge: kept
      { name: 'inv-31-reviewer', head: 'd2b4392' }, // open PR and queued
      { name: 'inv-32-test-author', head: 'd4681cf' }, // its copy goes in the same plan
      { name: 'base-for-inv-10', head: '8042207' }, // no PR: kept
    ],
    remoteBranches: [
      { name: 'inv-39-ledger', head: 'beba9c2' }, // closed PR: restorable from it
      { name: 'feature/INV-10', head: '9662644' },
      { name: 'inv-30-45-linear', head: '299c916' },
    ],
  });
  assert.deepEqual(plan.deleteLocal, ['inv-38-factory-runner', 'inv-32-test-author']);
  assert.deepEqual(plan.deleteRemote, ['inv-39-ledger']);
});

test('a branch that an open PR or a queued task builds on is never deleted (independent review, 25.11)', () => {
  const stack = [
    { number: 19, headRefName: 'inv-30-45-linear', headRefOid: '299c916', baseRefName: 'inv-39-ledger-v2', state: 'MERGED' },
    { number: 23, headRefName: 'inv-46-factory-order', headRefOid: '87de94d', baseRefName: 'main', state: 'OPEN' },
    { number: 24, headRefName: 'on-top', headRefOid: 'aaa', baseRefName: 'inv-30-45-linear', state: 'OPEN' },
  ];
  const plan = planCleanup({
    prs: stack, queue: [{ issue: 'INV-60', branch: 'inv-60-x', base: 'inv-39-ledger-v2' }],
    remoteBranches: [{ name: 'inv-30-45-linear', head: '299c916' }, { name: 'inv-39-ledger-v2', head: 'b1ae5ae' }],
  });
  assert.deepEqual(plan.deleteRemote, []);
});

test('the branch of a copy kept for unsaved work stays on GitHub too', () => {
  const plan = planCleanup({
    copies: [{ path: '/p/x', branch: 'inv-32-test-author', head: 'd4681cf', dirty: true }], prs,
    remoteBranches: [{ name: 'inv-32-test-author', head: 'd4681cf' }],
  });
  assert.deepEqual(plan.deleteRemote, []);
});

test('a copy with no PR is kept, and reported once it has waited a week', () => {
  const young = planCleanup({ copies: [{ path: '/p/a', branch: 'inv-70-x', head: '1', dirty: false, ageDays: 2 }] });
  const old = planCleanup({ copies: [{ path: '/p/b', branch: 'inv-71-y', head: '2', dirty: false, ageDays: 9.5 }] });
  assert.deepEqual(young.report, []);
  assert.equal(old.report[0].why, 'no PR and no task for 9 days');
  assert.equal(old.removeCopies.length, 0);
});

test('the open PR of a branch decides over an older closed one', () => {
  const both = [{ number: 12, headRefName: 'b', headRefOid: 'a1', state: 'CLOSED' }, { number: 15, headRefName: 'b', headRefOid: 'a2', state: 'OPEN' }];
  assert.equal(prForBranch(both, 'b').number, 15);
  assert.equal(prForBranch([], 'b'), null);
});

test('git worktree list --porcelain becomes path, head and branch', () => {
  const list = parseWorktrees('worktree /p/repo\nHEAD abc\nbranch refs/heads/main\n\nworktree /p/ia-wt/plugin-runtime\nHEAD def\ndetached\n');
  assert.deepEqual(list, [{ path: '/p/repo', head: 'abc', branch: 'main' }, { path: '/p/ia-wt/plugin-runtime', head: 'def', branch: null }]);
});

test('task logs older than 30 days go, the runner\'s own logs stay', () => {
  const now = new Date(2026, 11, 30);
  const files = [
    { name: 'INV-31-2026-11-24T22-20-04-689Z.log', mtimeMs: new Date(2026, 10, 24).getTime() },
    { name: 'INV-60-2026-12-20T22-00-00-000Z.log', mtimeMs: new Date(2026, 11, 20).getTime() },
    { name: 'runner.log', mtimeMs: new Date(2026, 9, 1).getTime() },
  ];
  assert.deepEqual(oldLogs(files, now), ['INV-31-2026-11-24T22-20-04-689Z.log']);
});

test('the summary line says what went and what stays', () => {
  const plan = planCleanup({ copies, prs, queue, protectedPaths: ['/p/ia-wt/plugin-runtime', '/p/ia-wt/factory-runner'] });
  assert.equal(cleanupSummary(plan, { copies: 1, local: 2, remote: 1, logs: 0 }),
    'Чистене: махнати 1 копия, 2 локални и 1 отдалечени клона, 0 стари лога; на диска остават 5 копия.');
});
