import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { reviewMarker } from '../lib.mjs';
import { commentableLines, inlineComments, reviewBody, verdictOf, verdictOfRun } from '../../scripts/review-pr.mjs';

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', 'review-pr.mjs');

test('the verdict is read from the first "Verdict:" line, in plain or bold form', () => {
  assert.equal(verdictOf('Verdict: PASS\n\nFindings: none'), 'PASS');
  assert.equal(verdictOf('**Verdict:** FAIL\n- critical x'), 'FAIL');
  assert.equal(verdictOf('Verdict: QUESTION\nНяма критерии.'), 'QUESTION');
  assert.equal(verdictOf('Looks good to me'), null);
});

test('an exhausted limit is LIMIT, not a FAIL; a run without a verdict is ERROR', () => {
  assert.equal(verdictOfRun({ isError: true, text: 'Credit balance is too low' }), 'LIMIT');
  assert.equal(verdictOfRun({ isError: true, text: 'API Error: 500' }), 'ERROR');
  assert.equal(verdictOfRun({ isError: false, text: 'Verdict: FAIL\n- critical a.ts:1 - x' }), 'FAIL');
  assert.equal(verdictOfRun({ isError: false, text: 'I could not finish' }), 'ERROR');
});

const diff = [
  'diff --git a/packages/vat.ts b/packages/vat.ts',
  '--- a/packages/vat.ts',
  '+++ b/packages/vat.ts',
  '@@ -10,3 +10,4 @@ export function cell(line) {',
  '   const x = 1;',
  '-  return 17;',
  '+  return 18;',
  '+  // services outside the EU',
  '   }',
  'diff --git a/old.ts b/old.ts',
  '--- a/old.ts',
  '+++ /dev/null',
  '@@ -1 +0,0 @@',
  '-gone',
].join('\n');

test('findings on lines of the diff become inline comments; the others stay in the body', () => {
  const lines = commentableLines(diff);
  assert.deepEqual([...lines.get('packages/vat.ts')], [10, 11, 12, 13]);
  assert.equal(lines.has('old.ts'), false);
  const text = [
    'Verdict: FAIL', '', 'Findings',
    '- critical packages/vat.ts:11 - клетка 18 е за услуги извън ЕС. Rule: bg-vat. Fix: 17.',
    '- warning packages/other.ts:4 - извън диффа.',
    '- info packages/vat.ts:99 - извън hunk-а.',
  ].join('\n');
  assert.deepEqual(inlineComments(text, lines), [{ path: 'packages/vat.ts', line: 11, side: 'RIGHT', body: '**critical**: клетка 18 е за услуги извън ЕС. Rule: bg-vat. Fix: 17.' }]);
});

test('the review body carries the marker the runner reads', () => {
  const body = reviewBody({ verdict: 'LIMIT', text: 'Credit balance is too low', costUsd: 0, sha: 'abc123' });
  assert.match(body, /отложено/);
  assert.deepEqual(reviewMarker(body), { verdict: 'LIMIT', sha: 'abc123', costUsd: 0 });
});

test('without a reviewer agent the review is skipped and passes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-skip-'));
  const summary = path.join(dir, 'summary.md');
  const r = spawnSync(process.execPath, [script, '1', 'abc'], { cwd: dir, env: { ...process.env, GITHUB_STEP_SUMMARY: summary, AGENTS_DIR: dir }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(fs.readFileSync(summary, 'utf8'), /no reviewer agent/);
});
