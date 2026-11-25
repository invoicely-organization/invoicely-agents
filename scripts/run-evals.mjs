#!/usr/bin/env node
// Runs the eval cases of the given agents and decides each case by majority (INV-62). The judges of a case can change
// their mind from one run to the next ("FAIL FAIL PASS"), so one run is not a verdict: a case without a majority of
// passing runs is run again until it has three, and it passes with two of three. Like pass@k in model evaluation and
// rerunning only the failed tests (pytest --lf).
//   node scripts/run-evals.mjs [--runs <n>] <agent>...
// Every round writes its own evals/results/<time>-<agent>-<round>/, so scripts/eval-cost.mjs counts the reruns too.
// CI runs this file as it is on the PR's base branch, so a PR cannot change the verdict on itself.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MAJORITY_OF = 3;

// { name: [true, false, ...] } from the aggregate results of one or more rounds, in order.
export function runsByCase(results) {
  const byCase = {};
  for (const result of results) {
    for (const c of result?.cases ?? []) {
      const runs = (c.arms?.with ?? []).map((run) => run.passed === true);
      byCase[c.name] = [...(byCase[c.name] ?? []), ...runs];
    }
  }
  return byCase;
}

const passes = (runs) => runs.filter(Boolean).length;

// A case passes when more than half of its runs pass. One that does not, and has fewer than three runs, gets the
// runs it lacks; with three or more its verdict stands.
export function decide(byCase) {
  const verdicts = {};
  const rerun = {};
  for (const [name, runs] of Object.entries(byCase)) {
    const passed = runs.length > 0 && passes(runs) * 2 > runs.length;
    verdicts[name] = passed;
    if (!passed && runs.length < MAJORITY_OF) rerun[name] = MAJORITY_OF - runs.length;
  }
  return { verdicts, rerun };
}

export function summary(byCase, verdicts) {
  const lines = ['### Evals by majority', '', '| case | runs | passed | verdict |', '| --- | --- | --- | --- |'];
  for (const [name, runs] of Object.entries(byCase)) {
    lines.push(`| ${name} | ${runs.map((r) => (r ? 'PASS' : 'FAIL')).join(' ')} | ${passes(runs)}/${runs.length} | ${verdicts[name] ? 'pass' : 'FAIL'} |`);
  }
  return lines.join('\n');
}

function runEval({ agent, runs, caseName, outputDir, bin }) {
  const args = ['plugin', 'eval', '.', '--trust-plugin', '--scaffold', '--allow-tools', 'Write', 'Edit', '--ablation', 'none',
    '--runs', String(runs), '-j', '3', '--threshold', '0.8', '--no-publish', '--tag', agent, '--output-dir', outputDir,
    ...(caseName ? ['--case', caseName] : [])];
  spawnSync(bin, args, { stdio: 'inherit' }); // its exit code is not the verdict; the results file is
  const file = path.join(outputDir, 'aggregate-result.json');
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
}

function main(argv) {
  const at = argv.indexOf('--runs');
  const runs = at >= 0 ? Number(argv[at + 1]) : 1;
  const agents = argv.filter((a, i) => a !== '--runs' && i !== at + 1);
  const bin = process.env.INVOICELY_EVAL_BIN || 'claude';
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  let ok = true;
  const tables = [];
  for (const agent of agents) {
    const results = [runEval({ agent, runs, outputDir: path.join('evals', 'results', `${stamp}-${agent}-1`), bin })];
    if (!results[0]) {
      console.log(`::error::${agent}: the evals gave no results`);
      ok = false;
      continue;
    }
    let { verdicts, rerun } = decide(runsByCase(results));
    for (const [name, more] of Object.entries(rerun)) {
      console.log(`${name} failed; ${more} more run${more > 1 ? 's' : ''} for a majority`);
      results.push(runEval({ agent, runs: more, caseName: name, outputDir: path.join('evals', 'results', `${stamp}-${agent}-${name}`), bin }));
    }
    const byCase = runsByCase(results.filter(Boolean));
    ({ verdicts } = decide(byCase));
    tables.push(`#### ${agent}\n\n${summary(byCase, verdicts)}`);
    if (Object.values(verdicts).some((v) => !v)) ok = false;
  }
  const text = tables.join('\n\n');
  console.log(text);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n\n`);
  return ok ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(main(process.argv.slice(2)));
