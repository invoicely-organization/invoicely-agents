#!/usr/bin/env node
// Sums the cost of every eval run under a results folder, per run and per case, as a Markdown table.
// The figures are what `claude plugin eval` reports (API prices); on the Max plan they show the share of the limit.
//   node scripts/eval-cost.mjs evals/results [--json]
import fs from 'node:fs';
import path from 'node:path';

const dir = process.argv[2] ?? 'evals/results';
const asJson = process.argv.includes('--json');
const rows = [];
if (fs.existsSync(dir)) {
  for (const run of fs.readdirSync(dir).sort()) {
    const file = path.join(dir, run, 'aggregate-result.json');
    if (!fs.existsSync(file)) continue;
    const result = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const c of result.cases ?? []) {
      const arms = Object.values(c.arms ?? {}).flat();
      const cost = arms.reduce((sum, a) => sum + (a.costUsd ?? 0) + (a.judgeCostUsd ?? 0), 0);
      rows.push({ run, case: c.name ?? c.id ?? '?', runs: arms.length, costUsd: Number(cost.toFixed(4)) });
    }
  }
}
const total = Number(rows.reduce((sum, r) => sum + r.costUsd, 0).toFixed(2));
if (asJson) {
  console.log(JSON.stringify({ totalUsd: total, cases: rows }, null, 2));
} else {
  console.log(`### Eval cost: $${total} (API prices)\n`);
  console.log('| run | case | runs | $ |\n| --- | --- | --- | --- |');
  for (const r of rows) console.log(`| ${r.run} | ${r.case} | ${r.runs} | ${r.costUsd} |`);
}
