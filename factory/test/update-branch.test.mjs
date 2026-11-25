import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { conflictOnly } from '../lib.mjs';
import { alreadyUpdated, copyMatchesPr, mergeBaseInto, mergePolicies } from '../update-branch.mjs';

const ATTRIBUTES = path.join(path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url)))), '.gitattributes');
const ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const HEADER = '# The paths each agent may write.\nprompt-engineer:\n  allow: ["agents/**"]\n';

// A repo with a feature branch and a task branch made from it; returns helpers to change both.
function repo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'update-branch-'));
  const git = (...args) => execFileSync('git', args, { cwd: dir, env: ENV, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
  const write = (file, text) => {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), text);
  };
  git('init', '-q', '-b', 'feature');
  write('policies/role-guard.yaml', HEADER);
  write('README.md', 'one\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  git('checkout', '-q', '-b', 'task');
  return { dir, git, write, commit: (m) => { git('add', '-A'); git('commit', '-q', '-m', m); } };
}

test('the runner merges a base whose only conflict is a second agent entry in the role guard policy', () => {
  const r = repo();
  r.write('policies/role-guard.yaml', `${HEADER}reviewer:\n  allow: []\n`);
  r.commit('reviewer');
  r.git('checkout', '-q', 'feature');
  r.write('policies/role-guard.yaml', `${HEADER}test-author:\n  allow: ["**/*.test.ts"]\n`);
  r.commit('test-author');
  r.git('checkout', '-q', 'task');
  const result = mergeBaseInto({ cwd: r.dir, ref: 'feature', attributesFile: ATTRIBUTES, message: 'INV-31: merge feature', env: ENV });
  assert.deepEqual(result, { merged: true });
  const policy = fs.readFileSync(path.join(r.dir, 'policies/role-guard.yaml'), 'utf8');
  assert.match(policy, /reviewer:/);
  assert.match(policy, /test-author:/);
  assert.equal(r.git('log', '-1', '--format=%s'), 'INV-31: merge feature');
  assert.equal(r.git('status', '--porcelain'), '');
});

test('a union that gives one agent two entries is undone and left to the agent', () => {
  const r = repo();
  r.write('policies/role-guard.yaml', `${HEADER}reviewer:\n  allow: []\n`);
  r.commit('reviewer, no writes');
  r.git('checkout', '-q', 'feature');
  r.write('policies/role-guard.yaml', `${HEADER}reviewer:\n  allow: ["notes/**"]\n`);
  r.commit('reviewer, notes');
  r.git('checkout', '-q', 'task');
  const before = r.git('rev-parse', 'HEAD');
  const result = mergeBaseInto({ cwd: r.dir, ref: 'feature', attributesFile: ATTRIBUTES, message: 'm', env: ENV });
  assert.equal(result.merged, false);
  assert.match(result.why, /both sides changed the same agent/);
  assert.equal(r.git('rev-parse', 'HEAD'), before);
  assert.equal(r.git('status', '--porcelain'), '');
});

test('a conflict in any other file is not the runner\'s: the merge is aborted and the copy is as before', () => {
  const r = repo();
  r.write('README.md', 'task\n');
  r.commit('task readme');
  r.git('checkout', '-q', 'feature');
  r.write('README.md', 'feature\n');
  r.commit('feature readme');
  r.git('checkout', '-q', 'task');
  const before = r.git('rev-parse', 'HEAD');
  const result = mergeBaseInto({ cwd: r.dir, ref: 'feature', attributesFile: ATTRIBUTES, message: 'm', env: ENV });
  assert.deepEqual(result, { merged: false, why: 'conflicts in README.md' });
  assert.equal(r.git('rev-parse', 'HEAD'), before);
  assert.equal(r.git('status', '--porcelain'), '');
});

test('a copy with uncommitted work, or one that already holds the base, is left alone', () => {
  const r = repo();
  assert.match(mergeBaseInto({ cwd: r.dir, ref: 'feature', attributesFile: ATTRIBUTES, message: 'm', env: ENV }).why, /already contains/);
  r.write('notes.md', 'unsaved\n');
  assert.match(mergeBaseInto({ cwd: r.dir, ref: 'feature', attributesFile: ATTRIBUTES, message: 'm', env: ENV }).why, /uncommitted/);
});

test('GitHub\'s stale "conflict" after a fixing push, and a copy that differs from the PR, are told apart', () => {
  const r = repo();
  r.git('update-ref', 'refs/remotes/origin/feature', 'feature');
  r.git('update-ref', 'refs/remotes/origin/task', 'task');
  assert.equal(alreadyUpdated({ cwd: r.dir, base: 'feature', branch: 'task', env: ENV }), true);
  assert.equal(copyMatchesPr({ cwd: r.dir, branch: 'task', env: ENV }), true);
  r.git('checkout', '-q', 'feature');
  r.write('README.md', 'two\n');
  r.commit('feature moves on');
  r.git('update-ref', 'refs/remotes/origin/feature', 'feature');
  r.git('checkout', '-q', 'task');
  assert.equal(alreadyUpdated({ cwd: r.dir, base: 'feature', branch: 'task', env: ENV }), false);
  r.write('x.md', 'x\n');
  r.commit('local only');
  assert.equal(copyMatchesPr({ cwd: r.dir, branch: 'task', env: ENV }), false);
});

test('the policy merges agent by agent: one side\'s change wins over the base, two different changes conflict', () => {
  const pe = { allow: ['agents/**'], deny: [] };
  const base = { 'prompt-engineer': pe };
  const reviewer = { allow: [], deny: [] };
  const testAuthor = { allow: ['**/*.test.ts'], deny: [] };
  assert.deepEqual(mergePolicies(base, { ...base, reviewer }, { ...base, 'test-author': testAuthor }), { 'prompt-engineer': pe, reviewer, 'test-author': testAuthor });
  const wider = { allow: ['agents/**', 'skills/**'], deny: [] };
  assert.deepEqual(mergePolicies(base, { 'prompt-engineer': wider }, { ...base, reviewer }), { 'prompt-engineer': wider, reviewer });
  assert.deepEqual(mergePolicies(base, {}, base), {}, 'an entry removed on one side stays removed');
  assert.equal(mergePolicies(base, { ...base, reviewer }, { ...base, reviewer: testAuthor }), null);
});

test('an edited entry next to a new one is not left to the text union, which would give the new agent the edit', () => {
  const r = repo();
  r.write('policies/role-guard.yaml', `${HEADER}reviewer:\n  allow: []\n`);
  r.commit('reviewer');
  r.git('checkout', '-q', 'feature');
  r.write('policies/role-guard.yaml', `# The paths each agent may write.\nprompt-engineer:\n  allow: ["agents/**", "skills/**"]\n`);
  r.commit('wider prompt-engineer');
  r.git('checkout', '-q', 'task');
  const before = r.git('rev-parse', 'HEAD');
  const result = mergeBaseInto({ cwd: r.dir, ref: 'feature', attributesFile: ATTRIBUTES, message: 'm', env: ENV });
  // Union keeps both sides of the hunk: the old prompt-engineer line, then reviewer, then the wider line under reviewer.
  assert.deepEqual(result, { merged: false, why: 'the text merge of policies/role-guard.yaml does not give each agent its entry' });
  assert.equal(r.git('rev-parse', 'HEAD'), before);
  assert.equal(r.git('status', '--porcelain'), '');
});

test('only a PR whose single problem is a conflict goes to the runner\'s own merge', () => {
  assert.equal(conflictOnly(['merge conflict with feature/INV-10']), true);
  assert.equal(conflictOnly(['merge conflict with feature/INV-10', 'evals']), false);
  assert.equal(conflictOnly(['evals']), false);
  assert.equal(conflictOnly([]), false);
  assert.equal(conflictOnly(undefined), false);
});
