import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { runHook, tempDir } from './helpers.mjs';

const home = tempDir('secret-guard-home-');
const state = path.join(home, '.invoicely');
const work = path.join(home, 'projects', 'invoicely-agents', '.claude', 'worktrees', 'inv-51');
mkdirSync(work, { recursive: true });
const call = (tool_name, tool_input, cwd = work) => runHook('secret-guard.mjs', { hook_event_name: 'PreToolUse', tool_name, cwd, tool_input }, { HOME: home, INVOICELY_HOME: state });

test('ordinary work passes: the agent\'s own files, tests, the queue is not touched', () => {
  assert.equal(call('Read', { file_path: path.join(work, 'agents', 'reviewer.md') }).denied, false);
  assert.equal(call('Grep', { pattern: 'cell 18', path: work }).denied, false);
  assert.equal(call('Glob', { pattern: 'evals/**/case.yaml' }).denied, false);
  assert.equal(call('Bash', { command: 'node --test hooks/test/*.test.mjs && git status' }).denied, false);
  assert.equal(call('Edit', { file_path: path.join(work, 'skills', 'bg-vat', 'SKILL.md') }).denied, false);
});

test('the runner\'s key, tokens and the personal originals cannot be read, which a probe did on 25.11', () => {
  assert.equal(call('Read', { file_path: path.join(state, 'github-app.pem') }).denied, true);
  assert.equal(call('Read', { file_path: '~/.invoicely/.env' }).denied, true);
  assert.equal(call('Grep', { pattern: 'token', path: path.join(state, 'gh-bot') }).denied, true);
  assert.equal(call('Glob', { pattern: `${state}/originals/**` }).denied, true);
  assert.equal(call('Read', { file_path: path.join(state, 'cache', 'linear-app-token.json') }).denied, true);
});

test('Bash cannot reach them either, by absolute, home or relative path', () => {
  assert.equal(call('Bash', { command: `cat ${path.join(state, 'github-app.pem')}` }).denied, true);
  assert.equal(call('Bash', { command: 'node -e "console.log(require(\'fs\').readFileSync(process.env.HOME + \'/.invoicely/.env\', \'utf8\'))"' }).denied, true);
  assert.equal(call('Bash', { command: 'cat $HOME/.config/gh/hosts.yml' }).denied, true);
  assert.equal(call('Bash', { command: 'cat ../../.invoicely/github-app.pem' }, path.join(home, 'projects', 'x')).denied, true);
  assert.equal(call('Bash', { command: 'security find-generic-password -s claude -w' }).denied, true);
  assert.equal(call('Bash', { command: 'ls ~/.ssh' }).denied, true);
});

test('a folder that holds secrets cannot be searched, listed or diffed (independent review, 25.11)', () => {
  assert.equal(call('Grep', { pattern: 'BEGIN', path: state, output_mode: 'content' }).denied, true);
  assert.equal(call('Grep', { pattern: 'token', path: home }).denied, true);
  assert.equal(call('Glob', { pattern: `${home}/**/*.json` }).denied, true);
  assert.equal(call('Bash', { command: `mkdir /tmp/e && git diff --no-index /tmp/e ${state}` }).denied, true);
  assert.equal(call('Bash', { command: 'ls -la ~' }).denied, true);
  assert.equal(call('Grep', { pattern: 'cell 18', path: path.join(home, 'projects') }).denied, false);
});

test('case does not help on the Mac', { skip: process.platform !== 'darwin' }, () => {
  assert.equal(call('Read', { file_path: path.join(home, '.INVOICELY', '.ENV') }).denied, true);
  assert.equal(call('Read', { file_path: path.join(state, 'GitHub-App.PEM') }).denied, true);
});

test('naming .env in a message passes; reading a real one does not', () => {
  assert.equal(call('Bash', { command: 'git commit -m "INV-12: read the config from .env"' }).denied, false);
  assert.equal(call('Bash', { command: 'git config core.sshCommand' }).denied, false);
  assert.equal(call('Bash', { command: 'git commit -m "INV-51: guard Read / Grep in ~ and ~/.ssh"' }).denied, false);
  assert.equal(call('Bash', { command: "gh pr create --title 'INV-51: /' --body 'keys in ~/.invoicely/.env stay out'" }).denied, false);
  assert.equal(call('Bash', { command: 'git commit -m "ok" && cat ~/.ssh/id_rsa' }).denied, true);
  writeFileSync(path.join(work, '.env'), 'KEY=fake\n');
  assert.equal(call('Bash', { command: 'cat .env' }).denied, true);
});

test('key and env files anywhere are secret, and writing them is blocked too', () => {
  assert.equal(call('Write', { file_path: path.join(work, '.env') }).denied, true);
  assert.equal(call('Read', { file_path: path.join(work, 'deploy', 'server.pem') }).denied, true);
  assert.equal(call('Read', { file_path: path.join(work, '.env.local') }).denied, true);
  assert.equal(call('Read', { file_path: path.join(work, 'docs', 'environment.md') }).denied, false);
  assert.equal(call('Read', { file_path: path.join(work, '.env.example') }).denied, false);
});
