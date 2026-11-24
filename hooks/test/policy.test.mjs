import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bareAgentName, decideWrite, globToRegExp, parsePolicy } from '../lib/policy.mjs';

test('globs: ** spans folders, * stays in one folder', () => {
  assert.ok(globToRegExp('apps/web/**').test('apps/web/src/features/vat/vat-card.tsx'));
  assert.ok(globToRegExp('**/*.test.ts').test('packages/domain/src/vat/cells.test.ts'));
  assert.ok(globToRegExp('**/*.test.ts').test('cells.test.ts'));
  assert.ok(!globToRegExp('apps/*.ts').test('apps/web/main.ts'));
  assert.ok(!globToRegExp('apps/web/**').test('apps/api/src/main.ts'));
});

test('parses the policy subset and rejects anything else', () => {
  const policy = parsePolicy('# comment\nfrontend-engineer:\n  allow: ["apps/web/**"]\n  deny: ["**/*.test.tsx"]\nreviewer:\n  allow: []\n');
  assert.deepEqual(policy['frontend-engineer'], { allow: ['apps/web/**'], deny: ['**/*.test.tsx'] });
  assert.deepEqual(policy.reviewer, { allow: [], deny: [] });
  assert.throws(() => parsePolicy('frontend-engineer:\n  allow: apps/web/**\n'), /cannot read/);
  assert.throws(() => parsePolicy('a:\n  allow: []\na:\n  allow: []\n'), /appears twice/);
});

test('deny wins over allow, unknown agents write nothing', () => {
  const policy = parsePolicy('frontend-engineer:\n  allow: ["apps/web/**"]\n  deny: ["**/*.test.tsx"]\n');
  assert.equal(decideWrite(policy, 'frontend-engineer', 'apps/web/src/vat-card.tsx').allowed, true);
  assert.equal(decideWrite(policy, 'frontend-engineer', 'apps/web/src/vat-card.test.tsx').allowed, false);
  assert.equal(decideWrite(policy, 'frontend-engineer', 'apps/api/src/main.ts').allowed, false);
  assert.equal(decideWrite(policy, 'general-purpose', 'apps/web/src/vat-card.tsx').allowed, false);
});

test('plugin agent names lose the plugin prefix', () => {
  assert.equal(bareAgentName('invoicely-agents:reviewer'), 'reviewer');
  assert.equal(bareAgentName('reviewer'), 'reviewer');
});
