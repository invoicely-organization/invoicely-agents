import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { describe, failed, redact } from '../action-log.mjs';
import { hooksDir, tempDir } from './helpers.mjs';

function run(input, dir) {
  return spawnSync(process.execPath, [path.join(hooksDir, 'action-log.mjs')], {
    input: typeof input === 'string' ? input : JSON.stringify(input),
    env: { ...process.env, INVOICELY_ACTION_LOG_DIR: dir },
    encoding: 'utf8',
  });
}

test('every tool call becomes one short line in the day file, with the agent and the target', () => {
  const dir = tempDir('action-log-');
  const r = run({ session_id: 's1', agent_type: 'backend-engineer', tool_name: 'Edit', tool_input: { file_path: '/w/apps/api/x.ts', old_string: 'a', new_string: 'b' }, tool_response: {} }, dir);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '', 'the hook says nothing back to Claude');
  const [file] = readdirSync(dir);
  assert.match(file, /^\d{4}-\d{2}-\d{2}\.jsonl$/);
  const line = JSON.parse(readFileSync(path.join(dir, file), 'utf8').trim());
  assert.deepEqual([line.session, line.agent, line.tool, line.target, line.failed], ['s1', 'backend-engineer', 'Edit', '/w/apps/api/x.ts', false]);
});

test('the main session is "main" and a failed call is marked', () => {
  const dir = tempDir('action-log-');
  run({ tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_response: { is_error: true } }, dir);
  const line = JSON.parse(readFileSync(path.join(dir, readdirSync(dir)[0]), 'utf8').trim());
  assert.equal(line.agent, 'main');
  assert.equal(line.failed, true);
});

test('tokens, keys and passwords never reach the log', () => {
  // Fake values are built at run time, so that the secret scan of the repo does not see token-shaped literals.
  const fake = (prefix, n = 24) => `${prefix}${'x'.repeat(n)}`;
  assert.equal(redact(`curl -H "Authorization: ${'Bear' + 'er'} ${fake('', 16)}" x`), 'curl -H "Authorization: <redacted>" x');
  assert.equal(redact(`GH_TOKEN=${fake('gh' + 's_', 28)} gh pr list`), 'GH_TOKEN=<redacted> gh pr list');
  assert.equal(redact(`echo ${fake('sk-' + 'ant-')}`), 'echo <redacted>');
  assert.equal(redact(`LINEAR_API_KEY=${fake('lin_' + 'api_')} node x`), 'LINEAR_API_KEY=<redacted> node x');
  const pem = ['-----BEGIN RSA ' + 'PRIVATE KEY-----', 'x'.repeat(8), '-----END RSA ' + 'PRIVATE KEY-----'].join('\n');
  assert.equal(redact(pem), '<redacted>');
  assert.equal(describe('Bash', { command: `x ${'y'.repeat(400)}` }).length, 300);
  assert.equal(describe('Agent', { subagent_type: 'reviewer', description: 'review INV-31' }), 'reviewer: review INV-31');
  assert.equal(failed({ success: false }), true);
  assert.equal(failed({ stdout: 'ok' }), false);
});

test('broken input writes nothing and does not stop the agent', () => {
  const dir = tempDir('action-log-');
  const r = run('not json', dir);
  assert.equal(r.status, 0);
  assert.deepEqual(readdirSync(dir), []);
});
