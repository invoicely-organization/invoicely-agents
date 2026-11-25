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

test('the runner\'s role (INVOICELY_ROLE) limits the whole session, also without a subagent', () => {
  const asRole = (role, file, agentType) => runHook('role-guard.mjs', {
    tool_name: 'Write', cwd: project, ...(agentType ? { agent_id: 'a1', agent_type: agentType } : {}),
    tool_input: { file_path: path.join(project, file) },
  }, { ...env, INVOICELY_ROLE: role });
  assert.equal(asRole('frontend-engineer', 'apps/web/src/x.ts').denied, false);
  assert.equal(asRole('frontend-engineer', 'apps/web/src/x.test.ts').denied, true);
  // A subagent of the session keeps the session's role.
  assert.equal(asRole('reviewer', 'apps/web/src/x.ts', 'general-purpose').denied, true);
});

test('the policy in this repo: test-author writes tests only, implementer everything but tests, etalons locked for both', () => {
  const write = (role, file) => runHook('role-guard.mjs', {
    tool_name: 'Write', cwd: project, tool_input: { file_path: path.join(project, file) },
  }, { CLAUDE_PROJECT_DIR: project, INVOICELY_ROLE_GUARD_POLICY: '', INVOICELY_ROLE: role });
  assert.equal(write('test-author', 'packages/domain/src/vat/cells.test.ts').denied, false);
  assert.equal(write('test-author', 'factory/test/review.test.mjs').denied, false);
  assert.equal(write('test-author', 'packages/domain/src/vat/cells.ts').denied, true);
  assert.equal(write('implementer', 'packages/domain/src/vat/cells.ts').denied, false);
  assert.equal(write('implementer', 'factory/factory.mjs').denied, false);
  const test = write('implementer', 'packages/domain/src/vat/cells.test.ts');
  assert.equal(test.denied, true);
  assert.doesNotMatch(test.reason, /cannot be read/);
  assert.equal(write('implementer', 'factory/test/lib.test.mjs').denied, true);
  assert.equal(write('implementer', 'policies/role-guard.yaml').denied, true);
  assert.equal(write('implementer', '.github/workflows/ci.yml').denied, true);
  for (const role of ['test-author', 'implementer', 'reviewer']) assert.equal(write(role, 'fixtures/etalons/vat/DEKLAR.txt').denied, true);
});
