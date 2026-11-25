import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { decide, runsByCase } from '../../scripts/run-evals.mjs';

const SCRIPT = path.join(path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url)))), 'scripts', 'run-evals.mjs');
const result = (cases) => ({ cases: Object.entries(cases).map(([name, runs]) => ({ name, arms: { with: runs.map((passed) => ({ passed })) } })) });

test('a case passes with more than half of its runs; one without a majority gets the runs it lacks up to three', () => {
  const { verdicts, rerun } = decide(runsByCase([result({ a: [true], b: [false], c: [true, false, true], d: [false, false, true] })]));
  assert.deepEqual(verdicts, { a: true, b: false, c: true, d: false });
  assert.deepEqual(rerun, { b: 2 });
});

test('the runs of a case add up over the rounds', () => {
  const byCase = runsByCase([result({ a: [false], b: [true] }), result({ a: [true, true] })]);
  assert.deepEqual(byCase, { a: [false, true, true], b: [true] });
  assert.deepEqual(decide(byCase).verdicts, { a: true, b: true });
  assert.deepEqual(decide(runsByCase([result({ a: [false] }), result({ a: [true, false] })])).verdicts, { a: false });
});

// The whole script against a fake claude that answers from a plan: per case, the outcomes of its next runs.
function runWithPlan(plan, args) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-evals-'));
  const state = path.join(dir, 'plan.json');
  const calls = path.join(dir, 'calls.jsonl');
  fs.writeFileSync(state, JSON.stringify(plan));
  const fake = path.join(dir, 'fake-claude.mjs');
  fs.writeFileSync(fake, `#!/usr/bin/env node
import fs from 'node:fs'; import path from 'node:path';
const args = process.argv.slice(2);
const opt = (k) => args[args.indexOf(k) + 1];
const plan = JSON.parse(fs.readFileSync(${JSON.stringify(state)}, 'utf8'));
const runs = Number(opt('--runs'));
const only = args.includes('--case') ? opt('--case') : null;
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ runs, only }) + '\\n');
const cases = [];
for (const name of Object.keys(plan)) {
  if (only && name !== only) continue;
  cases.push({ name, arms: { with: plan[name].splice(0, runs).map((passed) => ({ passed })) } });
}
fs.writeFileSync(${JSON.stringify(state)}, JSON.stringify(plan));
fs.mkdirSync(opt('--output-dir'), { recursive: true });
fs.writeFileSync(path.join(opt('--output-dir'), 'aggregate-result.json'), JSON.stringify({ cases }));
`);
  fs.chmodSync(fake, 0o755);
  const out = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: dir, env: { ...process.env, INVOICELY_EVAL_BIN: fake, GITHUB_STEP_SUMMARY: '' }, encoding: 'utf8' });
  return { status: out.status, stdout: out.stdout, calls: fs.readFileSync(calls, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) };
}

test('a case that fails once and then passes twice does not stop the merge; only that case is run again', () => {
  const r = runWithPlan({ 'reviewer-a': [true], 'reviewer-b': [false, true, true] }, ['--runs', '1', 'reviewer']);
  assert.equal(r.status, 0, r.stdout);
  assert.deepEqual(r.calls, [{ runs: 1, only: null }, { runs: 2, only: 'reviewer-b' }]);
  assert.match(r.stdout, /\| reviewer-b \| FAIL PASS PASS \| 2\/3 \| pass \|/);
});

test('a case that fails two runs of three stops the merge', () => {
  const r = runWithPlan({ 'reviewer-a': [true], 'reviewer-b': [false, true, false] }, ['--runs', '1', 'reviewer']);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /\| reviewer-b \| FAIL PASS FAIL \| 1\/3 \| FAIL \|/);
});

test('with three runs already (the PR into main) the majority is decided without reruns', () => {
  const r = runWithPlan({ 'reviewer-a': [true, false, true] }, ['--runs', '3', 'reviewer']);
  assert.equal(r.status, 0);
  assert.deepEqual(r.calls, [{ runs: 3, only: null }]);
});
