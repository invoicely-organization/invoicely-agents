import assert from 'node:assert/strict';
import { test } from 'node:test';
import { answerAfter, branchName, openBlockers, planFromReady, taskText } from '../linear-sync.mjs';

const done = { type: 'completed' };
const open = { type: 'unstarted' };
const issue = (id, extra = {}) => ({
  identifier: id, title: `Задача ${id}`, gitBranchName: `yoan/${id.toLowerCase()}-x`,
  description: '## Какво\n\nx\n\n## Как проверявам\n\ny, виж <issue id="1" label="INV-42" href="h" />\n\n>>> Agent notes\n\n* \\*\\*z\\*\\*\n\n>>>',
  labels: { nodes: [] }, inverseRelations: { nodes: [] }, ...extra,
});

test('branch names drop the Linear user prefix', () => {
  assert.equal(branchName({ identifier: 'INV-45', gitBranchName: 'yoansvdimitrov/inv-45-runner-t-vzima' }), 'inv-45-runner-t-vzima');
  assert.equal(branchName({ identifier: 'INV-7' }), 'inv-7');
});

test('the task for the agents is its title and description, with Linear markup turned back into text', () => {
  const text = taskText(issue('INV-70'));
  assert.match(text, /^# INV-70: Задача INV-70/);
  assert.match(text, /## Как проверявам/);
  assert.match(text, /виж INV-42/);
  assert.match(text, /\*\*z\*\*/);
  assert.doesNotMatch(text, />>>/);
});

test('every task in Ready is queued: the product repo by default, invoicely-agents and UI by label', () => {
  const { add, wait } = planFromReady([
    issue('INV-70'),
    issue('INV-71', { labels: { nodes: [{ name: 'invoicely-agents' }] } }),
    issue('INV-72', { labels: { nodes: [{ name: 'UI' }] } }),
  ], new Set());
  assert.deepEqual(wait, []);
  assert.deepEqual(add.map((t) => [t.issue, t.repo, t.ui, t.branch]), [
    ['INV-70', 'invoicely', false, 'inv-70-x'], ['INV-71', 'invoicely-agents', false, 'inv-71-x'], ['INV-72', 'invoicely', true, 'inv-72-x'],
  ]);
});

test('a task blocked by an open one stays in Ready until it is free; known tasks are left alone', () => {
  const blocked = issue('INV-71', { inverseRelations: { nodes: [{ type: 'blocks', issue: { identifier: 'INV-70', state: open } }] } });
  const free = issue('INV-72', { inverseRelations: { nodes: [{ type: 'blocks', issue: { identifier: 'INV-69', state: done } }] } });
  const { add, wait } = planFromReady([blocked, free, issue('INV-73')], new Set(['INV-73']));
  assert.deepEqual(add.map((t) => t.issue), ['INV-72']);
  assert.deepEqual(wait, [{ issue: 'INV-71', why: 'blocked by INV-70' }]);
  assert.deepEqual(openBlockers(blocked), ['INV-70']);
});

test("Yoan's answer is his comments after the question, without the runner's own", () => {
  const since = '2026-11-25T01:00:00Z';
  const comments = [
    { user: { id: 'y' }, createdAt: '2026-11-25T00:30:00Z', body: 'old' },
    { user: { id: 'y' }, createdAt: '2026-11-25T01:05:00Z', body: '**Чака:** въпрос' },
    { user: { id: 'y' }, createdAt: '2026-11-25T01:06:00Z', body: '[@yoan](u) **Чака:** въпрос' },
    { user: { id: 'app' }, createdAt: '2026-11-25T01:07:00Z', body: 'from the app' },
    { user: { id: 'y' }, createdAt: '2026-11-25T07:10:00Z', body: 'Да, приеми предложението.' },
  ];
  assert.equal(answerAfter(comments, 'y', since), 'Да, приеми предложението.');
  assert.equal(answerAfter(comments.slice(0, 3), 'y', since), null);
});
