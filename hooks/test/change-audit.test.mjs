import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { hooksDir, tempDir, writePolicy } from './helpers.mjs';

const policyFile = writePolicy(tempDir('audit-policy-'), [
  'backend-engineer:',
  '  allow: ["apps/api/**", "packages/db/**"]',
  '  deny: ["**/*.test.ts", "fixtures/etalons/**"]',
].join('\n'));

function repo() {
  const dir = tempDir('audit-repo-');
  const run = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
  run('init', '-q', '-b', 'inv-42');
  run('config', 'user.email', 'test@example.com');
  run('config', 'user.name', 'test');
  mkdirSync(path.join(dir, 'apps/api/src'), { recursive: true });
  mkdirSync(path.join(dir, 'fixtures/etalons'), { recursive: true });
  writeFileSync(path.join(dir, 'apps/api/src/vat.ts'), 'export const a = 1;\n');
  writeFileSync(path.join(dir, 'apps/api/src/vat.test.ts'), 'test locked\n');
  writeFileSync(path.join(dir, 'fixtures/etalons/DEKLAR.txt'), 'etalon\n');
  run('add', '-A');
  run('commit', '-q', '-m', 'init');
  return dir;
}

function hook(mode, dir, extra = {}) {
  const result = spawnSync(process.execPath, [path.join(hooksDir, 'change-audit.mjs'), mode], {
    input: JSON.stringify({ session_id: 's1', agent_id: 'a1', agent_type: 'invoicely-agents:backend-engineer', cwd: dir, ...extra }),
    env: { ...process.env, CLAUDE_PROJECT_DIR: dir, INVOICELY_ROLE_GUARD_POLICY: policyFile, INVOICELY_AUDIT_DIR: path.join(dir, '..', `${path.basename(dir)}-state`) },
    encoding: 'utf8',
  });
  return result.stdout.trim() ? JSON.parse(result.stdout) : {};
}

test('changes inside its paths let the subagent finish', () => {
  const dir = repo();
  hook('start', dir);
  writeFileSync(path.join(dir, 'apps/api/src/vat.ts'), 'export const a = 2;\n');
  writeFileSync(path.join(dir, 'apps/api/src/cells.ts'), 'export const b = 1;\n');
  assert.deepEqual(hook('stop', dir), {});
});

test('a locked test changed through Bash blocks the finish', () => {
  const dir = repo();
  hook('start', dir);
  writeFileSync(path.join(dir, 'apps/api/src/vat.test.ts'), 'test edited\n');
  const out = hook('stop', dir);
  assert.equal(out.decision, 'block');
  assert.match(out.reason, /vat\.test\.ts matches deny/);
});

test('a deleted etalon and a new file outside its paths are both reported', () => {
  const dir = repo();
  hook('start', dir);
  execFileSync('rm', [path.join(dir, 'fixtures/etalons/DEKLAR.txt')]);
  mkdirSync(path.join(dir, 'packages/domain'), { recursive: true });
  writeFileSync(path.join(dir, 'packages/domain/money.ts'), 'x\n');
  const out = hook('stop', dir);
  assert.equal(out.decision, 'block');
  assert.match(out.reason, /DEKLAR\.txt/);
  assert.match(out.reason, /packages\/domain\/money\.ts/);
});

test('changes made before the subagent started are not counted', () => {
  const dir = repo();
  writeFileSync(path.join(dir, 'fixtures/etalons/DEKLAR.txt'), 'changed by Yoan\n');
  hook('start', dir);
  writeFileSync(path.join(dir, 'apps/api/src/vat.ts'), 'export const a = 3;\n');
  assert.deepEqual(hook('stop', dir), {});
});

test('after one send-back it warns instead of looping', () => {
  const dir = repo();
  hook('start', dir);
  writeFileSync(path.join(dir, 'apps/api/src/vat.test.ts'), 'test edited\n');
  assert.equal(hook('stop', dir).decision, 'block');
  const second = hook('stop', dir, { stop_hook_active: true });
  assert.equal(second.decision, undefined);
  assert.match(second.systemMessage, /stopped without fixing it/);
});

test('the main session is not audited', () => {
  const dir = repo();
  const result = spawnSync(process.execPath, [path.join(hooksDir, 'change-audit.mjs'), 'stop'], {
    input: JSON.stringify({ session_id: 's1', cwd: dir }), encoding: 'utf8',
  });
  assert.equal(result.stdout.trim(), '');
});
