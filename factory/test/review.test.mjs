import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { verdictOf } from '../../scripts/review-pr.mjs';

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', 'review-pr.mjs');

test('the verdict is read from the first "Verdict:" line, in plain or bold form', () => {
  assert.equal(verdictOf('Verdict: PASS\n\nFindings: none'), 'PASS');
  assert.equal(verdictOf('**Verdict:** FAIL\n- critical x'), 'FAIL');
  assert.equal(verdictOf('Verdict: QUESTION\nНяма критерии.'), 'QUESTION');
  assert.equal(verdictOf('Looks good to me'), null);
});

test('a failed review sends the agent to the review comment', async () => {
  const { fixMessage } = await import('../lib.mjs');
  const text = fixMessage({ pr: 'https://github.com/o/r/pull/9', failed: ['review'], branch: 'b', base: 'feature/INV-10' });
  assert.match(text, /gh pr view https:\/\/github\.com\/o\/r\/pull\/9 --comments/);
});

test('without a reviewer agent in the branch the review is skipped and passes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-skip-'));
  const summary = path.join(dir, 'summary.md');
  const r = spawnSync(process.execPath, [script, '1', 'abc'], { cwd: dir, env: { ...process.env, GITHUB_STEP_SUMMARY: summary }, encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.match(fs.readFileSync(summary, 'utf8'), /no reviewer agent/);
});
