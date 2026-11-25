import assert from 'node:assert/strict';
import { test } from 'node:test';
import { featurePrBody, featureReady } from '../lib.mjs';

const done = (identifier, title, type = 'completed') => ({ identifier, title, state: { type } });

test('a feature is ready for its PR to main when every subtask is done or canceled and none is queued (INV-54)', () => {
  const children = [done('INV-31', 'reviewer'), done('INV-32', 'test-author'), done('INV-35', 'old idea', 'canceled')];
  assert.equal(featureReady(children, [], 'feature/INV-10'), true);
  assert.equal(featureReady([...children, done('INV-34', 'orchestrator', 'started')], [], 'feature/INV-10'), false);
  assert.equal(featureReady(children, [{ issue: 'INV-31', base: 'feature/INV-10', stage: 'ci' }], 'feature/INV-10'), false);
  assert.equal(featureReady([], [], 'feature/INV-10'), false);
});

test('the feature PR lists the subtasks with their PRs and says what to test', () => {
  const body = featurePrBody({
    feature: { identifier: 'INV-10', title: 'Минимален екип' },
    children: [done('INV-31', 'reviewer'), done('INV-32', 'test-author'), done('INV-35', 'old idea', 'canceled')],
    merged: [{ number: 20, title: 'INV-31: reviewer agent' }, { number: 21, title: 'INV-32: test-author agent' }],
    repo: 'invoicely-agents',
  });
  assert.match(body, /## Какво се променя/);
  assert.match(body, /- INV-31: reviewer \(#20\)/);
  assert.match(body, /- INV-32: test-author \(#21\)/);
  assert.match(body, /- INV-35: old idea \(отменена\)/);
  assert.match(body, /## Рискове/);
  assert.match(body, /Отчетът на evals в CI/);
  assert.match(body, /Linear: INV-10\n$/);
});

test('for the product the test is the PR\'s staging environment', () => {
  const body = featurePrBody({ feature: { identifier: 'INV-60', title: 'Вход' }, children: [done('INV-61', 'login')], merged: [], repo: 'invoicely' });
  assert.match(body, /staging \(INV-19\)/);
});
