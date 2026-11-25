import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { runHook, tempDir } from './helpers.mjs';

// A home with the old folder of copies and a repo with copies in .claude/worktrees.
const home = tempDir('copy-guard-home-');
const copy = path.join(home, 'projects', 'ia-wt', 'inv-31-reviewer');
const repo = path.join(home, 'projects', 'invoicely-agents');
const builtIn = path.join(repo, '.claude', 'worktrees', 'inv-46-factory-order');
for (const dir of [path.join(copy, 'evals', 'results'), path.join(builtIn, 'factory')]) mkdirSync(dir, { recursive: true });

const bash = (command, cwd = copy) => runHook('copy-guard.mjs', {
  hook_event_name: 'PreToolUse', tool_name: 'Bash', cwd, tool_input: { command },
}, { HOME: home });

test('work inside a copy passes, including moving and removing its own files', () => {
  for (const command of [
    'rm -rf evals/results',
    'mv agents/reviewer.md agents/reviewer.old.md',
    'rm -f /tmp/scratch.txt',
    `ls ${path.join(home, 'projects', 'ia-wt')}`,
    'git worktree list',
    'git status && rm -rf .scratch',
  ]) assert.equal(bash(command).denied, false, command);
  assert.equal(bash('rm -rf factory/test/tmp', builtIn).denied, false);
});

test('moving the folder of copies is blocked, which wiped INV-31 on 24.11', () => {
  assert.equal(bash(`mv ${path.join(home, 'projects', 'ia-wt')} ${path.join(home, 'projects', 'old')}`).denied, true);
  assert.equal(bash('mv ~/projects/ia-wt ~/projects/ia-wt.partial').denied, true);
  assert.equal(bash('cd ~/projects && mv ia-wt elsewhere', home).denied, true);
});

test('removing or moving one copy, or a folder above copies, is blocked', () => {
  assert.equal(bash(`rm -rf ${copy}`).denied, true);
  assert.equal(bash('rm -rf ~/projects').denied, true);
  assert.equal(bash(`mv ${builtIn} /tmp/x`).denied, true);
  assert.equal(bash(`rm -rf ${path.join(repo, '.claude', 'worktrees')}`).denied, true);
  assert.equal(bash(`rm -rf ${path.join(repo, '.claude')}`).denied, true);
  assert.equal(bash(`rm -rf ${repo}`).denied, true);
  assert.equal(bash(`sudo rm -r "${copy}"`).denied, true);
});

test('git worktree remove and move by hand are blocked; the runner does it', () => {
  const result = bash('git worktree remove ../inv-30-linear-app');
  assert.equal(result.denied, true);
  assert.match(result.reason, /runner creates and removes task copies/);
  assert.equal(bash('git worktree move a b').denied, true);
});
