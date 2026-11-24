import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { runHook, tempDir, writePolicy } from './helpers.mjs';

const project = tempDir('role-guard-project-');
const policyFile = writePolicy(tempDir('role-guard-policy-'), [
  'frontend-engineer:',
  '  allow: ["apps/web/**"]',
  '  deny: ["**/*.test.ts", "**/*.test.tsx", "fixtures/etalons/**"]',
  'reviewer:',
  '  allow: []',
].join('\n'));
const env = { CLAUDE_PROJECT_DIR: project, INVOICELY_ROLE_GUARD_POLICY: policyFile };
const write = (agent, file) => runHook('role-guard.mjs', {
  hook_event_name: 'PreToolUse', tool_name: 'Write', cwd: project,
  ...(agent ? { agent_id: 'a1', agent_type: agent } : {}),
  tool_input: { file_path: path.join(project, file), content: 'x' },
}, env);

test('the main session is not limited', () => {
  assert.equal(write(undefined, 'fixtures/etalons/vat/DEKLAR.txt').denied, false);
});

test('a subagent writes inside its paths', () => {
  const result = write('invoicely-agents:frontend-engineer', 'apps/web/src/features/vat/vat-card.tsx');
  assert.equal(result.code, 0);
  assert.equal(result.denied, false);
});

test('a frontend-engineer cannot edit a locked test', () => {
  const result = write('invoicely-agents:frontend-engineer', 'apps/web/src/features/vat/vat-summary.test.tsx');
  assert.equal(result.denied, true);
  assert.match(result.reason, /matches deny/);
});

test('a subagent cannot write outside its paths or outside the project', () => {
  assert.equal(write('frontend-engineer', 'apps/api/src/main.ts').denied, true);
  assert.equal(write('frontend-engineer', '../elsewhere/x.ts').denied, true);
  assert.equal(write('reviewer', 'apps/web/src/x.ts').denied, true);
});

test('an agent missing from the policy writes nothing', () => {
  const result = write('general-purpose', 'apps/web/src/x.ts');
  assert.equal(result.denied, true);
  assert.match(result.reason, /no entry/);
});

test('a broken policy blocks every subagent write', () => {
  const broken = writePolicy(tempDir('role-guard-broken-'), 'frontend-engineer:\n  allow: apps/web/**\n');
  const result = runHook('role-guard.mjs', {
    tool_name: 'Edit', cwd: project, agent_id: 'a1', agent_type: 'frontend-engineer',
    tool_input: { file_path: path.join(project, 'apps/web/src/x.ts') },
  }, { CLAUDE_PROJECT_DIR: project, INVOICELY_ROLE_GUARD_POLICY: broken });
  assert.equal(result.denied, true);
  assert.match(result.reason, /cannot be read/);
});

test('the policy in this repo parses', () => {
  const result = runHook('role-guard.mjs', {
    tool_name: 'Write', cwd: project, agent_id: 'a1', agent_type: 'invoicely-agents:prompt-engineer',
    tool_input: { file_path: path.join(project, 'README.md') },
  }, { CLAUDE_PROJECT_DIR: project, INVOICELY_ROLE_GUARD_POLICY: '' });
  assert.equal(result.denied, true);
  assert.doesNotMatch(result.reason, /cannot be read/);
});
