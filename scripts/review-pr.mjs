#!/usr/bin/env node
// CI job "review" (INV-44): the reviewer agent reads the PR with a fresh context and gives a verdict.
// PASS lets the PR through; FAIL or QUESTION fails the check, so the runner does not merge a subtask into its
// feature branch, and Yoan sees the findings in a comment instead of reading every file.
//   node scripts/review-pr.mjs <pr number> <base sha>
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const [pr, baseSha] = process.argv.slice(2);
const BUDGET_USD = process.env.REVIEW_BUDGET_USD || '3';
const MAX_DIFF = 200 * 1024;
const summary = (text) => process.env.GITHUB_STEP_SUMMARY && fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n`);
const sh = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

export function verdictOf(text) {
  return /^\s*\**Verdict:?\**\s*:?\s*(PASS|FAIL|QUESTION)\b/im.exec(text ?? '')?.[1] ?? null;
}

function main() {
  if (!fs.existsSync('agents/reviewer.md')) {
    summary('review: no reviewer agent in this branch yet, skipped');
    return 0;
  }
  if (!process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    summary('review: no CLAUDE_CODE_OAUTH_TOKEN (a PR from a fork), skipped');
    return 0;
  }
  const meta = JSON.parse(sh('gh', ['pr', 'view', pr, '--json', 'title,body,baseRefName,headRefName']));
  const diff = sh('git', ['diff', `${baseSha}...HEAD`]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-'));
  const diffFile = path.join(dir, 'pr.diff');
  fs.writeFileSync(diffFile, diff.slice(0, MAX_DIFF));
  const toMain = meta.baseRefName === 'main';
  const prompt = [
    `Review pull request #${pr} (${meta.headRefName} into ${meta.baseRefName}).`,
    `The brief is the PR title and description:\n<brief>\n${meta.title}\n\n${meta.body}\n</brief>`,
    `The diff is in ${diffFile}${diff.length > MAX_DIFF ? ` (cut at ${MAX_DIFF} bytes of ${diff.length}; say so in a finding)` : ''}. Read it, and any file of the repo you need.`,
    toMain
      ? 'This PR brings a whole feature into main, for Yoan to approve. After your verdict and findings, add in Bulgarian: what the feature changes in a few lines, the risks, and what Yoan should test by hand.'
      : 'This PR brings one subtask into a feature branch.',
    'Write the findings in Bulgarian. Start with the line "Verdict: PASS", "Verdict: FAIL" or "Verdict: QUESTION".',
  ].join('\n\n');
  const run = spawnSync('claude', ['-p', prompt, '--plugin-dir', '.', '--agent', 'invoicely-agents:reviewer', '--output-format', 'json',
    '--max-budget-usd', BUDGET_USD, '--allowedTools', 'Read', 'Grep', 'Glob'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  let result = {};
  try {
    result = JSON.parse(run.stdout.trim().split('\n').pop());
  } catch {
    result = { result: run.stdout || run.stderr, is_error: true };
  }
  const text = String(result.result ?? '');
  const verdict = result.is_error ? null : verdictOf(text);
  const cost = Number(result.total_cost_usd ?? 0);
  fs.writeFileSync('review-cost.json', JSON.stringify({ pr: Number(pr), verdict, costUsd: cost }));
  const head = verdict ? `## Преглед от reviewer агента: ${verdict}` : '## Прегледът от reviewer агента не завърши';
  const body = `${head}\n\n${text.slice(0, 60000)}\n\n<sub>Цена на прегледа: $${cost.toFixed(2)} по API цена (дял от лимита на Max).</sub>`;
  const bodyFile = path.join(dir, 'comment.md');
  fs.writeFileSync(bodyFile, body);
  sh('gh', ['pr', 'comment', pr, '--body-file', bodyFile]);
  summary(`review: ${verdict ?? 'no verdict'}, $${cost.toFixed(2)}`);
  return verdict === 'PASS' ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  process.exit(main());
}
