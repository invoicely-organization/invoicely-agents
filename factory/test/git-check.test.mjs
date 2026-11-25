import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { mergeInProgress, policyViolations, touchedFiles, unmergedFiles } from '../git-check.mjs';

const POLICY = path.join(path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url)))), 'policies', 'role-guard.yaml');
const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const git = (cwd, ...args) => execFileSync('git', args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
const write = (dir, file, text) => {
  fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  fs.writeFileSync(path.join(dir, file), text);
};

function repo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-check-'));
  git(dir, 'init', '-q', '-b', 'main');
  write(dir, 'src/cells.ts', 'export const cell = 17;\n');
  write(dir, 'src/money.ts', 'export const round = 1;\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'base');
  git(dir, 'checkout', '-q', '-b', 'task');
  write(dir, 'src/cells.test.ts', 'test 18\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'tests');
  return dir;
}

test('the implementer may change code, not the locked tests, through any tool', () => {
  const dir = repo();
  const before = git(dir, 'rev-parse', 'HEAD');
  write(dir, 'src/cells.ts', 'export const cell = 18;\n');
  write(dir, 'src/new.ts', 'x\n');
  assert.deepEqual(policyViolations(dir, before, 'implementer', POLICY), []);
  fs.rmSync(path.join(dir, 'src/cells.test.ts'));
  assert.equal(policyViolations(dir, before, 'implementer', POLICY).length, 1, 'a deleted test is caught');
  assert.equal(policyViolations(dir, before, 'test-author', POLICY).length, 2, 'test-author may not write code');
});

test('while the runner\'s merge of main is open, what came from main is not the session\'s, a deleted test still is', () => {
  const dir = repo();
  git(dir, 'checkout', '-q', 'main');
  write(dir, 'src/money.ts', 'export const round = 2;\n');
  write(dir, 'src/cells.ts', 'export const cell = 19;\n');
  write(dir, 'src/other.test.ts', 'from another task\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'main moved on');
  git(dir, 'checkout', '-q', 'task');
  write(dir, 'src/cells.ts', 'export const cell = 18;\n');
  git(dir, 'commit', '-q', '-am', 'code');
  const before = git(dir, 'rev-parse', 'HEAD');
  try {
    git(dir, 'merge', '-q', '--no-edit', 'main');
  } catch {
    // the conflict in src/cells.ts is the point
  }
  assert.equal(mergeInProgress(dir), true);
  assert.deepEqual(unmergedFiles(dir), ['src/cells.ts']);
  // The implementer resolves the conflict and, through Bash, deletes test-author's test.
  write(dir, 'src/cells.ts', 'export const cell = 18; // 19 on main is for goods\n');
  fs.rmSync(path.join(dir, 'src/cells.test.ts'));
  assert.deepEqual(touchedFiles(dir, before).sort(), ['src/cells.test.ts', 'src/cells.ts']);
  assert.deepEqual(policyViolations(dir, before, 'implementer', POLICY), ['src/cells.test.ts matches deny "**/*.test.ts" for implementer']);
});
