import assert from 'node:assert/strict';
import { test } from 'node:test';
import { answerAfter, branchName, extractBrief, openBlockers, planFromReady } from '../linear-sync.mjs';

const brief = (role = 'prompt-engineer') => `## Цел\n\nx\n\n>>> Agent notes\n\n<brief>\n<task role="${role}">\nDo it, see <issue id="1" label="INV-42" href="h" />.\n</task>\n<scope>\n<in>evals/orchestrator/\\*\\*</in>\n</scope>\n  </brief>\n\n>>>`;
const done = { type: 'completed' };
const open = { type: 'unstarted' };

test('the brief is the <brief> block with Linear markup turned back into text', () => {
  const text = extractBrief(brief());
  assert.match(text, /^<brief>/);
  assert.match(text, /<\/brief>$/);
  assert.match(text, /see INV-42\./);
  assert.match(text, /evals\/orchestrator\/\*\*/);
  assert.equal(extractBrief('## Цел\nno notes'), null);
});

test('branch names drop the Linear user prefix', () => {
  assert.equal(branchName({ identifier: 'INV-45', gitBranchName: 'yoansvdimitrov/inv-45-runner-t-vzima' }), 'inv-45-runner-t-vzima');
  assert.equal(branchName({ identifier: 'INV-7' }), 'inv-7');
});

test('a feature in Ready queues its open subtasks on its feature branch, with blockers among them as dependencies', () => {
  const feature = {
    identifier: 'INV-10', description: '',
    children: { nodes: [
      { identifier: 'INV-31', gitBranchName: 'y/inv-31-reviewer', description: brief(), state: open },
      { identifier: 'INV-34', gitBranchName: 'y/inv-34-orch', description: brief(), state: open,
        inverseRelations: { nodes: [
          { type: 'blocks', issue: { identifier: 'INV-31', state: open } },
          { type: 'blocks', issue: { identifier: 'INV-24', state: done } },
          { type: 'related', issue: { identifier: 'INV-43', state: open } },
        ] } },
      { identifier: 'INV-9', description: brief(), state: done },
    ] },
  };
  const { add, skip } = planFromReady([feature], new Set(), (id) => `/b/${id}.md`);
  assert.deepEqual(skip, []);
  assert.deepEqual(add.map((t) => [t.issue, t.base, t.branch, t.dependsOn ?? []]), [
    ['INV-31', 'feature/INV-10', 'inv-31-reviewer', []],
    ['INV-34', 'feature/INV-10', 'inv-34-orch', ['INV-31']],
  ]);
  assert.equal(add[0].brief, '/b/INV-31.md');
});

test('a single task goes to its parent feature branch or to main; known tasks are left alone', () => {
  const lone = { identifier: 'INV-45', description: brief(), children: { nodes: [] } };
  const child = { identifier: 'INV-40', description: brief(), parent: { identifier: 'INV-10' }, children: { nodes: [] } };
  const { add } = planFromReady([lone, child, { identifier: 'INV-33', description: brief() }], new Set(['INV-33']), (id) => id);
  assert.deepEqual(add.map((t) => [t.issue, t.base]), [['INV-45', 'main'], ['INV-40', 'feature/INV-10']]);
});

test('a task without a brief, or for a role the runner does not run yet, stays in Ready for Claude', () => {
  const { add, skip } = planFromReady([
    { identifier: 'INV-6', description: 'Йоан решава' },
    { identifier: 'INV-12', description: brief('devops') },
  ], new Set(), (id) => id);
  assert.deepEqual(add, []);
  assert.deepEqual(skip.map((a) => a.issue), ['INV-6', 'INV-12']);
  assert.match(skip[1].why, /devops/);
});

test('blockers are only the open issues that block this one', () => {
  assert.deepEqual(openBlockers({ inverseRelations: { nodes: [{ type: 'blocks', issue: { identifier: 'A', state: open } }, { type: 'blocks', issue: { identifier: 'B', state: done } }] } }), ['A']);
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
