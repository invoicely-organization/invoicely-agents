#!/usr/bin/env node
// The factory runner: one queue for the agent sessions on the Mac, with a spending cap per run,
// one session per task, a night window, and automatic resume after the usage limit resets.
// Ideas taken from Paperclip (budgets, heartbeats, atomic checkout, audit log).
//
//   factory queue add <INV-xx> --branch <b> --brief <file> [--answers <file>] [--budget <usd>] [--add-dir <dir>]
//                              [--resume-session <id> --message <text>]
//   factory queue run [--now]     run the queue, one task at a time, in the night window unless --now
//   factory run <INV-xx> ...      run one task now (same options as queue add)
//   factory status                queue, locks, GitHub identity and the last runs
//
// With githubApp set in ~/.invoicely/config.json and the key in ~/.invoicely/github-app.pem, the sessions commit,
// push and open PRs as the App bot (see github-app.mjs). Without them they act as Yoan.
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appSettings, installationToken, sessionEnv, writeGhConfig } from './github-app.mjs';
import { classify, fillTemplate, findPrUrl, inWindow, minutesBetween, nextWindowStart, parseLimitReset, parseResult, sessionDirName } from './lib.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOME = os.homedir();
const STATE = process.env.INVOICELY_HOME || path.join(HOME, '.invoicely');
const config = {
  repo: path.join(HOME, 'projects/invoicely-agents'),
  worktrees: path.join(HOME, 'projects/ia-wt'),
  pluginRef: 'origin/main',
  budgetUsd: 15,
  windowStart: 22,
  windowEnd: 8,
  nodeBin: '',
  ...readJson(path.join(STATE, 'config.json'), {}),
};
const QUEUE = path.join(STATE, 'queue.json');
const LEDGER = path.join(STATE, 'ledger', 'runs.jsonl');
for (const dir of ['locks', 'ledger', 'logs']) fs.mkdirSync(path.join(STATE, dir), { recursive: true });

const ALLOWED_TOOLS = [
  'Agent', 'Read', 'Write', 'Edit', 'Glob', 'Grep',
  'Bash(claude plugin validate:*)', 'Bash(claude plugin eval:*)', 'Bash(node --test:*)', 'Bash(node:*)',
  'Bash(git status:*)', 'Bash(git diff:*)', 'Bash(git log:*)', 'Bash(git add:*)', 'Bash(git commit:*)', 'Bash(git push:*)',
  'Bash(gh pr create:*)', 'Bash(gh pr view:*)', 'Bash(ls:*)', 'Bash(mkdir:*)', 'Bash(chmod:*)', 'Bash(cat:*)',
];

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function log(message) {
  process.stdout.write(`${new Date().toISOString()} ${message}\n`);
}

function git(cwd, args) {
  return execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function sleepUntil(when) {
  log(`waiting until ${when.toString()}`);
  while (Date.now() < when.getTime()) await sleep(Math.min(when.getTime() - Date.now(), 5 * 60 * 1000));
}

// The plugin loads from its own copy: Claude Code refuses edits to a loaded plugin's files.
function ensureRuntime() {
  const runtime = path.join(config.worktrees, 'plugin-runtime');
  if (!fs.existsSync(runtime)) {
    git(config.repo, ['fetch', '-q', 'origin']);
    git(config.repo, ['worktree', 'add', '-q', '--detach', runtime, config.pluginRef]);
  } else {
    git(runtime, ['fetch', '-q', 'origin']);
    git(runtime, ['checkout', '-q', '--detach', config.pluginRef]);
  }
  return runtime;
}

function ensureWorktree(branch) {
  const wt = path.join(config.worktrees, branch);
  if (fs.existsSync(wt)) return wt;
  git(config.repo, ['fetch', '-q', 'origin']);
  try {
    git(config.repo, ['worktree', 'add', '-q', wt, branch]);
  } catch {
    git(config.repo, ['worktree', 'add', '-q', '-b', branch, wt, 'origin/main']);
  }
  return wt;
}

// One task, one session: a second run of the same task is refused while the first one lives.
function lock(issue) {
  const file = path.join(STATE, 'locks', `${issue}.lock`);
  const pid = Number(readJson(file, {}).pid);
  if (pid) {
    try {
      process.kill(pid, 0);
      throw new Error(`${issue} is already running (pid ${pid})`);
    } catch (error) {
      if (error.code !== 'ESRCH') throw error;
    }
  }
  fs.writeFileSync(file, JSON.stringify({ pid: process.pid, since: new Date().toISOString() }));
  return () => fs.rmSync(file, { force: true });
}

function latestSession(cwd) {
  const dir = path.join(HOME, '.claude', 'projects', sessionDirName(cwd));
  try {
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'))
      .map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs })).sort((a, b) => b.t - a.t);
    return files.length ? files[0].f.replace(/\.jsonl$/, '') : null;
  } catch {
    return null;
  }
}

function loadEnv() {
  const env = {};
  try {
    for (const line of fs.readFileSync(path.join(STATE, '.env'), 'utf8').split('\n')) {
      const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
      if (match) env[match[1]] = match[2].replace(/^["']|["']$/g, '');
    }
  } catch {
    // no .env yet
  }
  return env;
}

// Linear: a comment on the task after every run; a question also moves it to "Чака Йоан".
async function linear(query, variables) {
  const key = loadEnv().LINEAR_API_KEY;
  if (!key) return null;
  const response = await fetch('https://api.linear.app/graphql', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: key },
    body: JSON.stringify({ query, variables }),
  });
  const json = await response.json();
  if (json.errors) throw new Error(JSON.stringify(json.errors));
  return json.data;
}

async function reportToLinear(entry, resultText) {
  try {
    const issue = (await linear('query($id:String!){issue(id:$id){id team{id}}}', { id: entry.issue }))?.issue;
    if (!issue) return;
    const cost = entry.costUsd == null ? '' : `, около $${entry.costUsd.toFixed(2)}`;
    const head = `Агентът работи ${entry.minutes} мин.${cost}.`;
    let body;
    if (entry.status === 'done') body = `**Готово.** ${head} PR: ${entry.pr}`;
    else if (entry.status === 'limit') body = `**Спрян от лимита на Max.** ${head} Подновява се сам в ${entry.resetAt}.`;
    else if (entry.status === 'error') body = `**Грешка.** ${head}\n\n${resultText.slice(0, 1500)}`;
    else {
      body = `**Чака:** отговор на въпроса на агента.\n\n**Какво да направиш:** прочети въпроса и предложения отговор по-долу и отговори тук.\n\n**Ако не отговориш:** задачата стои, нищо не се променя.\n\n---\n\n${resultText.slice(0, 3000)}`;
      const states = await linear('query($team:String!){team(id:$team){states{nodes{id name}}}}', { team: issue.team.id });
      const waiting = states?.team?.states?.nodes?.find((s) => s.name === 'Чака Йоан');
      if (waiting) await linear('mutation($id:String!,$state:String!){issueUpdate(id:$id,input:{stateId:$state}){success}}', { id: issue.id, state: waiting.id });
    }
    await linear('mutation($id:String!,$body:String!){commentCreate(input:{issueId:$id,body:$body}){success}}', { id: issue.id, body });
  } catch (error) {
    log(`linear: ${error.message}`);
  }
}

// Agent sessions act as the GitHub App bot when it is set up: Yoan gets the notifications and approves its PRs,
// and the bot cannot change workflows or the protection of main. Without the App they act as Yoan, as before.
async function sessionIdentity() {
  const app = appSettings(STATE);
  if (!app) return null;
  const ghConfigDir = path.join(STATE, 'gh-bot');
  // Fails here, before the session, when the key or the installation is wrong.
  writeGhConfig(ghConfigDir, await installationToken(app), app.slug);
  const refresh = async () => writeGhConfig(ghConfigDir, await installationToken(app), app.slug);
  const script = path.join(HERE, 'github-app.mjs');
  return {
    name: `${app.slug}[bot]`, slug: app.slug, botUserId: app.botUserId, ghConfigDir, refresh,
    helperCommand: `!'${process.execPath}' '${script}' git-credential`,
  };
}

function runClaude(args, cwd, logFile, identity) {
  return new Promise((resolve) => {
    let env = { ...process.env };
    if (config.nodeBin) env.PATH = `${config.nodeBin}:${env.PATH}`;
    if (identity) env = sessionEnv(env, identity);
    const child = spawn('claude', args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    const out = fs.createWriteStream(logFile, { flags: 'a' });
    // The bot token lives one hour; gh reads it from the file, so the file is renewed while the session runs.
    const timer = identity ? setInterval(() => identity.refresh().catch((error) => log(`github: ${error.message}`)), 5 * 60 * 1000) : null;
    child.stdout.on('data', (chunk) => { stdout += chunk; out.write(chunk); });
    child.stderr.on('data', (chunk) => out.write(chunk));
    child.on('close', (code) => { if (timer) clearInterval(timer); out.end(); resolve({ code, stdout }); });
  });
}

async function runTask(task) {
  const unlock = lock(task.issue);
  try {
    const runtime = ensureRuntime();
    const wt = ensureWorktree(task.branch);
    const budget = task.budgetUsd ?? config.budgetUsd;
    const base = ['--plugin-dir', runtime, '--permission-mode', 'acceptEdits', '--output-format', 'json',
      '--max-budget-usd', String(budget), ...(task.addDir ? ['--add-dir', task.addDir] : []), '--allowedTools', ...ALLOWED_TOOLS];
    let args;
    if (task.resumeSession) {
      const message = task.message || 'You stopped before finishing (usage limit or interruption). Continue exactly where you stopped and finish the same instructions.';
      args = ['-p', message, '--resume', task.resumeSession, ...base];
    } else {
      const template = fs.readFileSync(path.join(HERE, 'prompts', 'prompt-engineer-task.md'), 'utf8');
      const prompt = fillTemplate(template, {
        ISSUE: task.issue, BRANCH: task.branch, BRIEF: task.brief, WT: wt,
        ANSWERS_LINE: task.answers ? ` Add the answers in ${task.answers} to the questions it asked earlier.` : '',
      });
      args = ['-p', prompt, ...base];
    }
    const started = new Date();
    const logFile = path.join(STATE, 'logs', `${task.issue}-${started.toISOString().replace(/[:.]/g, '-')}.log`);
    log(`${task.issue}: start in ${wt}${task.resumeSession ? ` (resume ${task.resumeSession})` : ''}, cap $${budget}`);
    const identity = await sessionIdentity();
    log(`${task.issue}: github as ${identity ? identity.name : 'Yoan (no GitHub App in config.json)'}`);
    const { code, stdout } = await runClaude(args, wt, logFile, identity);
    const result = parseResult(stdout);
    const status = classify(result);
    const ended = new Date();
    const reset = parseLimitReset(result.text, ended);
    const entry = {
      issue: task.issue, branch: task.branch, session: result.sessionId || latestSession(wt), started: started.toISOString(),
      ended: ended.toISOString(), minutes: minutesBetween(started, ended), status, exitCode: code, costUsd: result.costUsd,
      turns: result.turns, pr: findPrUrl(result.text), resetAt: reset ? reset.toString() : null, resumedFrom: task.resumeSession ?? null, actor: identity ? identity.name : 'yoan', log: logFile,
    };
    fs.appendFileSync(LEDGER, `${JSON.stringify(entry)}\n`);
    log(`${task.issue}: ${status}${entry.pr ? ` ${entry.pr}` : ''}`);
    await reportToLinear(entry, result.text);
    return { ...entry, reset };
  } finally {
    unlock();
  }
}

function parseTask(argv) {
  const [issue, ...rest] = argv;
  if (!/^INV-\d+$/.test(issue ?? '')) throw new Error('first argument must be a task id such as INV-31');
  const task = { issue };
  for (let i = 0; i < rest.length; i += 2) {
    const key = { '--branch': 'branch', '--brief': 'brief', '--answers': 'answers', '--budget': 'budgetUsd', '--resume-session': 'resumeSession', '--message': 'message', '--add-dir': 'addDir' }[rest[i]];
    if (!key) throw new Error(`unknown option ${rest[i]}`);
    task[key] = key === 'budgetUsd' ? Number(rest[i + 1]) : rest[i + 1];
  }
  if (!task.branch) throw new Error('--branch is required');
  if (!task.brief && !task.resumeSession) throw new Error('--brief is required for a new run');
  return task;
}

async function runQueue(now) {
  for (;;) {
    const queue = readJson(QUEUE, []);
    if (queue.length === 0) return log('queue empty');
    if (!now && !inWindow(new Date(), config.windowStart, config.windowEnd)) {
      await sleepUntil(nextWindowStart(new Date(), config.windowStart));
      continue;
    }
    const task = queue[0];
    let result;
    try {
      result = await runTask(task);
    } catch (error) {
      log(`${task.issue}: could not run: ${error.message}`);
      fs.appendFileSync(LEDGER, `${JSON.stringify({ issue: task.issue, branch: task.branch, ended: new Date().toISOString(), status: 'error', error: error.message })}\n`);
      result = { status: 'error' };
    }
    const latest = readJson(QUEUE, []);
    if (result.status === 'limit' && result.reset) {
      latest[0] = { ...task, resumeSession: result.session, message: undefined };
      fs.writeFileSync(QUEUE, JSON.stringify(latest, null, 2));
      await sleepUntil(new Date(result.reset.getTime() + 3 * 60 * 1000));
    } else {
      latest.shift();
      fs.writeFileSync(QUEUE, JSON.stringify(latest, null, 2));
    }
  }
}

async function main() {
  const [command, sub, ...rest] = process.argv.slice(2);
  if (command === 'queue' && sub === 'add') {
    const queue = readJson(QUEUE, []);
    queue.push(parseTask(rest));
    fs.writeFileSync(QUEUE, JSON.stringify(queue, null, 2));
    return log(`queued ${rest[0]} (${queue.length} in queue)`);
  }
  if (command === 'queue' && sub === 'run') return runQueue(rest.includes('--now'));
  if (command === 'run') return runTask(parseTask([sub, ...rest]));
  if (command === 'status') {
    console.log('queue:', JSON.stringify(readJson(QUEUE, []), null, 2));
    console.log('locks:', fs.readdirSync(path.join(STATE, 'locks')).join(', ') || 'none');
    const app = appSettings(STATE);
    console.log('github:', app ? `${app.slug}[bot] (App ${app.appId}, installation ${app.installationId})` : 'Yoan (no GitHub App in config.json)');
    const runs = fs.existsSync(LEDGER) ? fs.readFileSync(LEDGER, 'utf8').trim().split('\n').slice(-10) : [];
    console.log('last runs:');
    for (const line of runs) {
      const r = JSON.parse(line);
      console.log(`  ${r.ended} ${r.issue} ${r.status} ${r.minutes}min $${r.costUsd ?? '?'} ${r.pr ?? ''}`);
    }
    return undefined;
  }
  console.log('usage: factory queue add <INV-xx> --branch <b> --brief <file> [...] | factory queue run [--now] | factory run <INV-xx> ... | factory status');
  return undefined;
}

main().catch((error) => {
  log(`error: ${error.message}`);
  process.exit(1);
});
