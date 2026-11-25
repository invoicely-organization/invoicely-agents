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
  assert.equal(settings.excludedCommands, undefined, 'no command runs outside it');
});

test('the sandbox keeps the runner state, the credentials and the Keychain out of reach', () => {
  for (const dir of ['~/.invoicely', '~/.ssh', '~/.config/gh', '~/.aws', '~/Library/Keychains']) {
    assert.ok(settings.filesystem.denyRead.includes(dir), `${dir} must be in denyRead`);
  }
});

test('the network reaches GitHub and npm only', () => {
  assert.deepEqual([...settings.network.allowedDomains].sort(), ['*.githubusercontent.com', 'api.github.com', 'github.com', 'registry.npmjs.org']);
});
