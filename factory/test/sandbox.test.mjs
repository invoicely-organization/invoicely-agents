import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const FACTORY = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const settings = JSON.parse(fs.readFileSync(path.join(FACTORY, 'sandbox.json'), 'utf8')).sandbox;

test('agent sessions run their commands in the sandbox and cannot ask to leave it (INV-57)', () => {
  assert.equal(settings.enabled, true);
  assert.equal(settings.failIfUnavailable, true, 'no sandbox on the Mac means no session, not an unsandboxed one');
  assert.equal(settings.allowUnsandboxedCommands, false);
  assert.deepEqual(settings.excludedCommands, ['claude plugin eval:*'], 'only the evals run outside it');
});

test('the sandbox keeps the runner state, the credentials and the Keychain out of reach', () => {
  for (const dir of ['~/.invoicely', '~/.ssh', '~/.config/gh', '~/.aws', '~/Library/Keychains']) {
    assert.ok(settings.filesystem.denyRead.includes(dir), `${dir} must be in denyRead`);
  }
  assert.ok(!settings.filesystem.denyRead.some((d) => d.includes('.invoicely-session')), 'the session reads its own token');
});

test('the network reaches GitHub and npm only', () => {
  assert.deepEqual([...settings.network.allowedDomains].sort(), ['*.githubusercontent.com', 'api.github.com', 'github.com', 'registry.npmjs.org']);
});

test('the git helper of a session answers from the token file and never needs the App key', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'token-file-'));
  const file = path.join(dir, 'git-token');
  fs.writeFileSync(file, 'ghs_example\n');
  // INVOICELY_HOME points at an empty folder: a helper that looked for config.json or the key would fail.
  const env = { ...process.env, INVOICELY_HOME: path.join(dir, 'no-state') };
  const run = (op, input) => spawnSync(process.execPath, [path.join(FACTORY, 'github-app.mjs'), 'git-credential', '--token-file', file, op], { input, env, encoding: 'utf8' });
  const get = run('get', 'protocol=https\nhost=github.com\n');
  assert.equal(get.status, 0, get.stderr);
  assert.equal(get.stdout, 'username=x-access-token\npassword=ghs_example\n');
  assert.equal(run('get', 'protocol=https\nhost=example.com\n').stdout, '');
  assert.equal(run('store', 'protocol=https\nhost=github.com\npassword=x\n').stdout, '');
});
