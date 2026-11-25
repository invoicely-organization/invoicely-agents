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
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appSettings, installationToken, sessionEnv, writeGhConfig } from './github-app.mjs';
import { linearClient, mention } from './linear.mjs';
import { answerAfter, planFromReady } from './linear-sync.mjs';
import { cleanupSummary, oldLogs, parseWorktrees, planCleanup } from './janitor.mjs';
import {
  blockingDeps, checksVerdict, classify, failedChecks, fillTemplate, findPrUrl, fixMessage, inWindow, isFeatureBranch,
  entryCosts, minutesBetween, nextRunnable, nextWindowStart, nightReport, nightStart, parseLimitReset, parseResult,
  servicePlist, sessionBudget, sessionDirName, spendingPeriod, spentSince, taskSpent,
} from './lib.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOME = os.homedir();
const STATE = process.env.INVOICELY_HOME || path.join(HOME, '.invoicely');
const config = {
  repo: path.join(HOME, 'projects/invoicely-agents'),
  // New task copies live in the repo's .claude/worktrees, the place `claude -w` uses (INV-48); a task that began in
  // the old folder keeps its copy there until it ends, because its session resumes by path.
  worktrees: path.join(HOME, 'projects/invoicely-agents/.claude/worktrees'),
  legacyWorktrees: path.join(HOME, 'projects/ia-wt'),
  // The plugin loads from its own copy, outside the repo: Claude Code refuses edits to every file under a loaded
  // plugin's folder, and the task copies live inside the repo (checked on 25.11, INV-49). It is runner state.
  plugin: path.join(STATE, 'plugin'),
  pluginRef: 'origin/main',
  budgetUsd: 15, // API dollars a task's sessions may spend over all their runs; a task's own budgetUsd overrides it
  windowStart: 22,
  windowEnd: 8,
  nodeBin: '',
  nightBudgetUsd: 60, // API dollars a night may spend on sessions and CI evals; then the runner stops until the next night
  dayBudgetUsd: 20, // the same for the day between two nights, when the runner is started with --now
  reportProjectId: 'a2abfb0c-4d55-41a7-8719-3838050c6d0c', // Linear project "M0 Инфраструктура": the night report goes there
  ...readJson(path.join(STATE, 'config.json'), {}),
};
const QUEUE = path.join(STATE, 'queue.json');
const LEDGER = path.join(STATE, 'ledger', 'runs.jsonl');
for (const dir of ['locks', 'ledger', 'logs']) fs.mkdirSync(path.join(STATE, dir), { recursive: true });

// --- The runner as a service (INV-49) ---

// While this file exists the runner starts nothing: no session, no CI merge, no clean-up. `factory pause` lets the
// running session finish first, so that the copies can be worked on safely; `factory resume` goes on.
const PAUSED = path.join(STATE, 'paused');
// The runner runs from the main checkout, which stays on main and which nobody works in.
const RUNS_FROM_REPO = path.resolve(path.dirname(HERE)) === path.resolve(config.repo);
let startCommit = null;
try {
  startCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: path.dirname(HERE), stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
} catch {
  // not a git checkout: no self-update
}

const ALLOWED_TOOLS = [
  'Agent', 'Read', 'Write', 'Edit', 'Glob', 'Grep',
  'Bash(claude plugin validate:*)', 'Bash(claude plugin eval:*)', 'Bash(node --test:*)', 'Bash(node:*)',
  'Bash(git status:*)', 'Bash(git diff:*)', 'Bash(git log:*)', 'Bash(git add:*)', 'Bash(git commit:*)', 'Bash(git push:*)',
  'Bash(gh pr create:*)', 'Bash(gh pr view:*)', 'Bash(gh pr checks:*)', 'Bash(gh run view:*)', 'Bash(gh run list:*)',
  'Bash(git fetch:*)', 'Bash(git merge:*)', 'Bash(ls:*)', 'Bash(mkdir:*)', 'Bash(chmod:*)', 'Bash(cat:*)',
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
  const runtime = config.plugin;
  if (!fs.existsSync(runtime)) {
    git(config.repo, ['fetch', '-q', 'origin']);
    git(config.repo, ['worktree', 'add', '-q', '--detach', runtime, config.pluginRef]);
  } else {
    git(runtime, ['fetch', '-q', 'origin']);
    git(runtime, ['checkout', '-q', '--detach', config.pluginRef]);
  }
  return runtime;
}

// A task's copy lives as long as the task (INV-48): the queue item and every ledger entry keep its path.
function taskCopyPath(task) {
  if (task.worktree) return task.worktree;
  const legacy = path.join(config.legacyWorktrees, task.branch);
  return fs.existsSync(legacy) ? legacy : path.join(config.worktrees, task.branch);
}

// A new task branch starts from its base as it is now: for a subtask, the feature branch with every merged subtask.
function ensureWorktree(task, base = 'main') {
  const branch = task.branch;
  const wt = taskCopyPath(task);
  if (fs.existsSync(wt)) return wt;
  fs.mkdirSync(path.dirname(wt), { recursive: true });
  git(config.repo, ['fetch', '-q', 'origin']);
  try {
    git(config.repo, ['worktree', 'add', '-q', wt, branch]);
  } catch {
    git(config.repo, ['worktree', 'add', '-q', '-b', branch, wt, `origin/${base}`]);
  }
  return wt;
}

// --- Feature branches (INV-43) ---

// gh for the runner itself; asBot runs it as the GitHub App bot (merges), otherwise as Yoan (reads).
async function gh(args, { asBot = false, json = false } = {}) {
  let env = { ...process.env };
  if (asBot) {
    const app = appSettings(STATE);
    if (app) {
      const ghConfigDir = path.join(STATE, 'gh-bot');
      writeGhConfig(ghConfigDir, await installationToken(app), app.slug);
      env = sessionEnv(env, { slug: app.slug, botUserId: app.botUserId, ghConfigDir, helperCommand: '' });
    }
  }
  let out;
  try {
    out = execFileSync('gh', args, { cwd: config.repo, env, stdio: ['ignore', 'pipe', 'pipe'] }).toString();
  } catch (error) {
    // gh pr checks exits with 8 while checks run and 1 when one failed, and still prints the JSON.
    out = error.stdout?.toString() ?? '';
    if (!json || !out.trim()) throw new Error(`gh ${args.join(' ')}: ${(error.stderr?.toString() || error.message).trim().slice(0, 300)}`);
  }
  return json ? JSON.parse(out) : out.trim();
}

function ensureBase(base) {
  if (!isFeatureBranch(base)) return;
  git(config.repo, ['fetch', '-q', 'origin']);
  if (git(config.repo, ['ls-remote', '--heads', 'origin', base])) return;
  git(config.repo, ['push', '-q', 'origin', `origin/main:refs/heads/${base}`]);
  log(`created ${base} from main`);
}

// Tasks already merged into a base: from the ledger, and from GitHub for PRs merged by hand.
async function mergedInto(base) {
  const merged = new Set();
  if (fs.existsSync(LEDGER)) {
    for (const line of fs.readFileSync(LEDGER, 'utf8').trim().split('\n')) {
      try {
        const r = JSON.parse(line);
        if (r.status === 'merged' && r.base === base) merged.add(r.issue);
      } catch {
        // a broken line does not stop the runner
      }
    }
  }
  try {
    for (const pr of await gh(['pr', 'list', '--base', base, '--state', 'merged', '--limit', '200', '--json', 'title'], { json: true })) {
      const match = /^(INV-\d+):/.exec(pr.title);
      if (match) merged.add(match[1]);
    }
  } catch (error) {
    log(`github: ${error.message}`);
  }
  return merged;
}

// The PR of a finished subtask: point it at the feature branch, then merge it there when CI is green.
async function advanceCi(item) {
  const view = await gh(['pr', 'view', item.pr, '--json', 'state,baseRefName,mergeable'], { json: true });
  if (view.state === 'MERGED') return { verdict: 'merged' };
  if (view.state === 'CLOSED') return { verdict: 'closed' };
  if (view.baseRefName !== item.base) {
    await gh(['pr', 'edit', item.pr, '--base', item.base], { asBot: true });
    log(`${item.issue}: PR now targets ${item.base}`);
    return { verdict: 'pending' };
  }
  if (view.mergeable === 'CONFLICTING') return { verdict: 'fail', failed: [`merge conflict with ${item.base}`] };
  let checks = [];
  try {
    checks = await gh(['pr', 'checks', item.pr, '--json', 'name,bucket'], { json: true });
  } catch {
    // no checks reported yet
  }
  const verdict = checksVerdict(checks);
  if (verdict !== 'pass') return { verdict, failed: failedChecks(checks) };
  await gh(['pr', 'merge', item.pr, '--squash'], { asBot: true });
  return { verdict: 'merged' };
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

// Linear: a comment on the task after every run; a question also moves it to "Чака Йоан" and mentions Yoan.
// As the "Invoicely Agents" app when its client credentials are in .env (INV-30), otherwise as Yoan.
async function linear(query, variables, options) {
  const client = linearClient({ env: loadEnv(), cacheFile: path.join(STATE, 'cache', 'linear-app-token.json') });
  if (!client) return null;
  return client(query, variables, options);
}

let yoanUser;
async function yoanMention() {
  if (yoanUser === undefined) {
    try {
      yoanUser = (await linear('{viewer{name displayName url}}', {}, { asYoan: true }))?.viewer ?? null;
    } catch {
      yoanUser = null;
    }
  }
  return mention(yoanUser);
}

async function reportToLinear(entry, resultText) {
  try {
    const issue = (await linear('query($id:String!){issue(id:$id){id team{id}}}', { id: entry.issue }))?.issue;
    if (!issue) return;
    const cost = entry.costUsd == null ? '' : `, около $${entry.costUsd.toFixed(2)}`;
    const head = `Агентът работи ${entry.minutes} мин.${cost}.`;
    const who = await yoanMention();
    const ask = (what, todo, ifNot, details = '') => `${who ? `${who} ` : ''}**Чака:** ${what}\n\n**Какво да направиш:** ${todo}\n\n**Ако не отговориш:** ${ifNot}${details ? `\n\n---\n\n${details}` : ''}`;
    let body;
    let waitForYoan = false;
    if (entry.status === 'done' && isFeatureBranch(entry.base)) return; // reported when it is merged
    if (entry.status === 'done') body = `**Готово.** ${head} PR: ${entry.pr}`;
    else if (entry.status === 'merged') body = `**Слято в \`${entry.base}\`.** CI е зелен. PR: ${entry.pr}`;
    else if (entry.status === 'ci_failed') {
      waitForYoan = true;
      body = ask(`CI на ${entry.pr} остава червен след ${entry.fixRounds} поправки (${(entry.failed ?? []).join(', ') || 'проверка'}).`,
        'виж проверките в PR-а и пиши тук "опитай пак" или "поемам". Предложение: "опитай пак", ако грешката е от лимита на Max.',
        `PR-ът не се слива в \`${entry.base}\`, а задачите, които зависят от тази, не тръгват.`);
    } else if (entry.status === 'blocked') {
      waitForYoan = true;
      body = ask(`задачата зависи от ${entry.blockedBy.join(', ')}, която не е слята в \`${entry.base}\` и не е в опашката.`,
        'добави зависимостта в опашката или махни зависимостта. Предложение: добави я.', 'задачата не тръгва.');
    } else if (entry.status === 'over_budget') {
      waitForYoan = true;
      body = ask(`задачата стигна тавана си: сесиите ѝ са похарчили $${entry.spentUsd.toFixed(2)} от $${entry.capUsd} (цена по API; на Max е дял от лимита).`,
        `пиши тук "продължи", за да получи още $${config.budgetUsd}, или "спри". Предложение: "продължи", ако PR-ът е близо до готов.`,
        'задачата стои извън опашката и не харчи нищо.');
    } else if (entry.status === 'limit') body = `**Спрян от лимита на Max.** ${head} Подновява се сам в ${entry.resetAt}.`;
    else if (entry.status === 'error') body = `**Грешка.** ${head}\n\n${resultText.slice(0, 1500)}`;
    else {
      waitForYoan = true;
      body = ask('отговор на въпроса на агента.', 'прочети въпроса и предложения отговор по-долу и отговори тук.', 'задачата стои, нищо не се променя.', resultText.slice(0, 3000));
    }
    if (waitForYoan) {
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
    // A headless session ends with its last turn: an agent left running in the background would be lost with it.
    env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS = '1';
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

async function runTask(task, budgetCap) {
  const unlock = lock(task.issue);
  try {
    const runtime = ensureRuntime();
    const prBase = task.base || 'main';
    ensureBase(prBase);
    const wt = ensureWorktree(task, prBase);
    if (task.worktree !== wt) updateItem(task.issue, { worktree: wt });
    const budget = Math.min(task.budgetUsd ?? config.budgetUsd, budgetCap ?? Infinity);
    const base = ['--plugin-dir', runtime, '--permission-mode', 'acceptEdits', '--output-format', 'json',
      '--max-budget-usd', String(budget), ...(task.addDir ? ['--add-dir', task.addDir] : []), '--allowedTools', ...ALLOWED_TOOLS];
    let args;
    let newSession = null;
    if (task.resumeSession) {
      const message = task.message || 'You stopped before finishing (usage limit or interruption). Continue exactly where you stopped and finish the same instructions.';
      args = ['-p', `${message}\n\n${FOREGROUND}`, '--resume', task.resumeSession, ...base];
    } else {
      // The session gets its id up front and the queue remembers it, so a run cut off by a restart or by the Mac
      // turning off resumes the same session instead of starting over. Commits and PRs name it (INV-49).
      newSession = crypto.randomUUID();
      const template = fs.readFileSync(path.join(HERE, 'prompts', 'prompt-engineer-task.md'), 'utf8');
      const prompt = fillTemplate(template, {
        ISSUE: task.issue, BRANCH: task.branch, BRIEF: task.brief, WT: wt, BASE: prBase, SESSION: newSession,
        ANSWERS_LINE: task.answers ? ` Add the answers in ${task.answers} to the questions it asked earlier.` : '',
      });
      args = ['-p', prompt, '--session-id', newSession, ...base];
    }
    const started = new Date();
    const logFile = path.join(STATE, 'logs', `${task.issue}-${started.toISOString().replace(/[:.]/g, '-')}.log`);
    log(`${task.issue}: start in ${wt}${task.resumeSession ? ` (resume ${task.resumeSession})` : ''}, cap $${budget}`);
    const identity = await sessionIdentity();
    log(`${task.issue}: github as ${identity ? identity.name : 'Yoan (no GitHub App in config.json)'}`);
    if (newSession) updateItem(task.issue, { resumeSession: newSession, message: INTERRUPTED, startFailures: undefined });
    const { code, stdout } = await runClaude(args, wt, logFile, identity);
    const result = parseResult(stdout);
    const status = classify(result);
    const ended = new Date();
    const reset = parseLimitReset(result.text, ended);
    const session = result.sessionId || latestSession(wt);
    // result.costUsd is the session's running total; the entry keeps it and what this run itself cost (INV-47).
    const runCost = result.costUsd == null ? null : entryCosts([...readLedger(), { session, sessionCostUsd: result.costUsd }]).at(-1);
    const entry = {
      issue: task.issue, branch: task.branch, base: prBase, session, started: started.toISOString(),
      ended: ended.toISOString(), minutes: minutesBetween(started, ended), status, exitCode: code, costUsd: runCost, sessionCostUsd: result.costUsd,
      turns: result.turns, pr: findPrUrl(result.text), resetAt: reset ? reset.toString() : null, resumedFrom: task.resumeSession ?? null, actor: identity ? identity.name : 'yoan', log: logFile, worktree: wt,
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
    const key = {
      '--branch': 'branch', '--brief': 'brief', '--answers': 'answers', '--budget': 'budgetUsd', '--resume-session': 'resumeSession',
      '--message': 'message', '--add-dir': 'addDir', '--base': 'base', '--depends-on': 'dependsOn',
    }[rest[i]];
    if (!key) throw new Error(`unknown option ${rest[i]}`);
    if (key === 'budgetUsd') task[key] = Number(rest[i + 1]);
    else if (key === 'dependsOn') task[key] = rest[i + 1].split(',').map((s) => s.trim()).filter(Boolean);
    else task[key] = rest[i + 1];
  }
  if (task.base && task.base !== 'main' && !isFeatureBranch(task.base)) throw new Error('--base must be main or feature/<name>');
  if (!task.branch) throw new Error('--branch is required');
  if (!task.brief && !task.resumeSession) throw new Error('--brief is required for a new run');
  return task;
}

const FOREGROUND = 'Run every agent in the foreground (run_in_background: false) and wait for its result: this session ends with your turn, so an agent left in the background is lost.';
const INTERRUPTED = `You were interrupted: the runner restarted or the Mac was turned off. Continue exactly where you stopped and finish the same instructions. ${FOREGROUND}`;
const MAX_FIX_ROUNDS = 2;
const CI_TIMEOUT_MINUTES = 150;

function ledger(entry) {
  fs.appendFileSync(LEDGER, `${JSON.stringify(entry)}\n`);
}

function readLedger() {
  if (!fs.existsSync(LEDGER)) return [];
  return fs.readFileSync(LEDGER, 'utf8').split('\n').filter(Boolean).flatMap((line) => {
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });
}

// The evals CI ran on a PR spend the same Max limit, so their cost goes into the ledger as well (once per CI run).
async function recordCiEvals(item) {
  try {
    const runs = await gh(['run', 'list', '--branch', item.branch, '--event', 'pull_request', '--status', 'completed', '--limit', '1', '--json', 'databaseId'], { json: true });
    const runId = runs[0]?.databaseId;
    if (!runId || readLedger().some((e) => e.status === 'ci-evals' && e.runId === runId)) return;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-evals-'));
    try {
      await gh(['run', 'download', String(runId), '-n', 'eval-results', '-D', dir]);
    } catch {
      return; // no evals in this run: no agent changed
    } finally {
      setTimeout(() => fs.rmSync(dir, { recursive: true, force: true }), 60 * 1000).unref();
    }
    const script = path.join(ensureRuntime(), 'scripts', 'eval-cost.mjs');
    const cost = JSON.parse(execFileSync(process.execPath, [script, dir, '--json']).toString());
    ledger({ issue: item.issue, branch: item.branch, base: item.base, pr: item.pr, runId, ended: new Date().toISOString(), status: 'ci-evals', costUsd: cost.totalUsd, cases: cost.cases.length });
    log(`${item.issue}: CI evals cost $${cost.totalUsd} (run ${runId})`);
  } catch (error) {
    log(`${item.issue}: CI evals cost unknown: ${error.message}`);
  }
}

// One report per night, as an update of the Linear project, when the night is over or the queue is empty.
async function reportNight(reason) {
  const since = nightStart(new Date(), config.windowStart);
  const stateFile = path.join(STATE, 'reports.json');
  const state = readJson(stateFile, { nights: [] });
  if (state.nights.includes(since.toISOString())) return;
  const entries = readLedger();
  if (!entries.some((e) => e.ended && Date.parse(e.ended) >= since.getTime())) return;
  const cleaned = readJson(path.join(STATE, 'cleanup.json'), {}).summary;
  const fresh = cleaned && cleaned.day === new Date().toLocaleDateString('sv-SE') ? `\n\n${cleaned.text}` : '';
  const body = `${nightReport(entries, since, config.nightBudgetUsd)}\n\n${reason}${fresh}`;
  // A report that did not reach Linear (no network after the Mac wakes) is tried again on the next round, up to
  // 12 times (about an hour); before INV-47 it was marked as sent and never reached Linear.
  const key = since.toISOString();
  const tries = (state.tries?.[key] ?? 0) + 1;
  let sent = false;
  try {
    const ok = await linear('mutation($p:String!,$b:String!){projectUpdateCreate(input:{projectId:$p,body:$b}){success}}', { p: config.reportProjectId, b: body });
    if (ok === null) log('night report: no Linear key, report only in the log');
    sent = true;
  } catch (error) {
    log(`night report (try ${tries} of 12): ${error.message}`);
  }
  if (tries === 1) log(`night report\n${body}`);
  if (sent || tries >= 12) {
    state.nights = [...state.nights.slice(-30), key];
    if (state.tries) delete state.tries[key];
  } else {
    state.tries = { ...(state.tries ?? {}), [key]: tries };
  }
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
}

// Change one queue item by its task id; null removes it. The queue file is re-read, so edits made meanwhile stay.
function updateItem(issue, change) {
  const queue = readJson(QUEUE, []);
  const at = queue.findIndex((t) => t.issue === issue);
  if (at === -1) return;
  if (change === null) queue.splice(at, 1);
  else {
    queue[at] = { ...queue[at], ...change };
    for (const key of Object.keys(queue[at])) if (queue[at][key] === undefined) delete queue[at][key];
  }
  fs.writeFileSync(QUEUE, JSON.stringify(queue, null, 2));
}

// PRs waiting for CI are checked at any hour: merging into a feature branch needs no session.
async function processCi() {
  for (const item of readJson(QUEUE, []).filter((t) => t.stage === 'ci')) {
    let result;
    try {
      result = await advanceCi(item);
    } catch (error) {
      log(`${item.issue}: ci: ${error.message}`);
      continue;
    }
    const done = { issue: item.issue, branch: item.branch, base: item.base, pr: item.pr, ended: new Date().toISOString() };
    if (result.verdict === 'pending') {
      if (minutesBetween(new Date(item.ciSince), new Date()) < CI_TIMEOUT_MINUTES) continue;
      result = { verdict: 'timeout', failed: [`CI did not finish in ${CI_TIMEOUT_MINUTES} minutes`] };
    }
    await recordCiEvals(item);
    if (result.verdict === 'merged' || result.verdict === 'closed') {
      const entry = { ...done, status: result.verdict };
      ledger(entry);
      updateItem(item.issue, null);
      log(`${item.issue}: ${entry.status} ${item.pr}`);
      if (entry.status === 'merged') await reportToLinear(entry, '');
      await cleanup({ only: item.branch }); // the task's copy and branch go with it (INV-48)
      continue;
    }
    const rounds = item.fixRounds ?? 0;
    if (result.verdict === 'fail' && rounds < MAX_FIX_ROUNDS) {
      log(`${item.issue}: CI failed (${result.failed.join(', ')}), fix round ${rounds + 1}`);
      updateItem(item.issue, {
        stage: 'run', resumeSession: item.session, fixRounds: rounds + 1,
        message: fixMessage({ pr: item.pr, failed: result.failed, branch: item.branch, base: item.base }),
      });
      continue;
    }
    const entry = { ...done, status: 'ci_failed', fixRounds: rounds, failed: result.failed, session: item.session };
    ledger(entry);
    updateItem(item.issue, null);
    log(`${item.issue}: ci_failed ${item.pr}`);
    await reportToLinear(entry, '');
  }
}

async function mergedByBase(queue) {
  const map = new Map();
  for (const base of new Set(queue.map((t) => t.base || 'main'))) map.set(base, await mergedInto(base));
  return map;
}

// A task whose dependency is neither merged nor in the queue would wait forever: it is taken out and Yoan is asked.
// A dependency that waits for Yoan's answer (a question, a red CI) is not gone: its answer puts it back in the queue.
async function dropBlocked(queue, merged) {
  const last = new Map();
  for (const e of readLedger()) if (['needs_answer', 'ci_failed', 'over_budget', 'answered', 'merged', 'error', 'blocked', 'closed'].includes(e.status)) last.set(e.issue, e.status);
  const waitingForYoan = (id) => ['needs_answer', 'ci_failed', 'over_budget'].includes(last.get(id));
  for (const task of queue) {
    if (task.stage === 'ci') continue;
    const missing = blockingDeps(task, merged.get(task.base || 'main') ?? new Set()).filter((dep) => !queue.some((q) => q.issue === dep) && !waitingForYoan(dep));
    if (missing.length === 0) continue;
    const entry = { issue: task.issue, branch: task.branch, base: task.base || 'main', ended: new Date().toISOString(), status: 'blocked', blockedBy: missing };
    ledger(entry);
    updateItem(task.issue, null);
    log(`${task.issue}: blocked by ${missing.join(', ')}`);
    await reportToLinear(entry, '');
  }
}

// --- Linear as the "go" button (INV-45) ---

const ISSUE_FIELDS = 'id identifier title description branchName state{name type} team{id} parent{identifier} inverseRelations{nodes{type issue{identifier state{type}}}}';

async function setState(issueKey, stateName) {
  const issue = (await linear('query($id:String!){issue(id:$id){id team{states{nodes{id name}}}}}', { id: issueKey }))?.issue;
  const state = issue?.team?.states?.nodes?.find((s) => s.name === stateName);
  if (state) await linear('mutation($id:String!,$s:String!){issueUpdate(id:$id,input:{stateId:$s}){success}}', { id: issue.id, s: state.id });
}

async function askYoan(issueKey, what, todo, ifNot) {
  const who = await yoanMention();
  const body = `${who ? `${who} ` : ''}**Чака:** ${what}\n\n**Какво да направиш:** ${todo}\n\n**Ако не отговориш:** ${ifNot}`;
  const issue = (await linear('query($id:String!){issue(id:$id){id}}', { id: issueKey }))?.issue;
  if (!issue) return;
  await setState(issueKey, 'Чака Йоан');
  await linear('mutation($id:String!,$b:String!){commentCreate(input:{issueId:$id,body:$b}){success}}', { id: issue.id, b: body });
}

// Tasks (or whole features) Yoan moved to Ready go into the queue; the rest of the work is the runner's.
const skippedOnce = new Set();
async function takeReady() {
  const data = await linear(
    `query($team:String!){issues(first:50,filter:{team:{key:{eq:$team}},state:{name:{eq:"Ready"}},project:{null:false}}){nodes{${ISSUE_FIELDS} children(first:50){nodes{${ISSUE_FIELDS}}}}}}`,
    { team: config.linearTeam ?? 'INV' },
  );
  if (!data) return;
  const queue = readJson(QUEUE, []);
  const known = new Set([...queue.map((t) => t.issue), ...fs.readdirSync(path.join(STATE, 'locks')).map((f) => f.replace(/\.lock$/, ''))]);
  const { add, skip } = planFromReady(data.issues.nodes, known, (id) => path.join(STATE, 'briefs', `${id}.md`));
  fs.mkdirSync(path.join(STATE, 'briefs'), { recursive: true });
  for (const { briefText, ...task } of add) {
    fs.writeFileSync(task.brief, `${briefText}\n`);
    const latest = readJson(QUEUE, []);
    latest.push(task);
    fs.writeFileSync(QUEUE, JSON.stringify(latest, null, 2));
    await setState(task.issue, 'In Progress');
    log(`linear: queued ${task.issue} on ${task.base}${task.dependsOn ? ` after ${task.dependsOn.join(', ')}` : ''}`);
  }
  for (const { issue, why } of skip) {
    if (skippedOnce.has(issue)) continue;
    skippedOnce.add(issue);
    log(`linear: ${issue} left in Ready (${why})`);
  }
  for (const feature of data.issues.nodes.filter((i) => (i.children?.nodes ?? []).length)) {
    if (add.some((t) => t.base === `feature/${feature.identifier}`)) await setState(feature.identifier, 'In Progress');
  }
}

// Yoan's answer in Linear to a question of the agent, or to a red CI, resumes the same session.
async function takeAnswers() {
  const data = await linear(
    'query($team:String!){issues(first:50,filter:{team:{key:{eq:$team}},state:{name:{eq:"Чака Йоан"}}}){nodes{identifier comments(last:30){nodes{body createdAt user{id}}}}}}',
    { team: config.linearTeam ?? 'INV' },
  );
  if (!data) return;
  const yoanId = (await linear('{viewer{id}}', {}, { asYoan: true }))?.viewer?.id;
  const entries = readLedger();
  const queue = readJson(QUEUE, []);
  for (const issue of data.issues.nodes) {
    if (queue.some((t) => t.issue === issue.identifier)) continue;
    const last = [...entries].reverse().find((e) => e.issue === issue.identifier && ['needs_answer', 'ci_failed', 'over_budget', 'answered'].includes(e.status));
    if (!last || last.status === 'answered') continue;
    if (last.status === 'over_budget' ? !last.task : !last.session) continue;
    const answer = answerAfter(issue.comments.nodes, yoanId, last.ended);
    if (!answer) continue;
    ledger({ issue: issue.identifier, ended: new Date().toISOString(), status: 'answered' });
    if (last.status === 'over_budget') {
      if (/спри/i.test(answer)) {
        log(`linear: ${issue.identifier}: Yoan stops it at its cap`);
        continue;
      }
      const task = { ...last.task, budgetUsd: last.capUsd + config.budgetUsd };
      if (!/^\s*продължи\W*$/i.test(answer) && task.resumeSession) {
        task.message = `Yoan answered in Linear:\n\n${answer}\n\n${task.message ?? 'Continue exactly where you stopped and finish the same instructions.'}`;
      }
      const latest = readJson(QUEUE, []);
      latest.unshift(task);
      fs.writeFileSync(QUEUE, JSON.stringify(latest, null, 2));
      await setState(issue.identifier, 'In Progress');
      log(`linear: ${issue.identifier} goes on with a cap of $${task.budgetUsd}`);
      continue;
    }
    if (last.status === 'ci_failed' && /поемам/i.test(answer)) {
      log(`linear: ${issue.identifier}: Yoan takes it over`);
      continue;
    }
    const fix = last.status === 'ci_failed' ? `\n\n${fixMessage({ pr: last.pr, failed: last.failed ?? [], branch: last.branch, base: last.base })}` : '';
    const latest = readJson(QUEUE, []);
    latest.unshift({
      issue: issue.identifier, branch: last.branch, base: last.base, resumeSession: last.session, ...(last.pr ? { pr: last.pr } : {}),
      message: `Yoan answered in Linear:\n\n${answer}\n\nContinue with this answer and finish the same instructions.${fix}`,
    });
    fs.writeFileSync(QUEUE, JSON.stringify(latest, null, 2));
    await setState(issue.identifier, 'In Progress');
    log(`linear: ${issue.identifier} resumes with Yoan's answer`);
  }
}

let lastSync = 0;
async function syncFromLinear() {
  if (Date.now() - lastSync < 5 * 60 * 1000) return;
  lastSync = Date.now();
  try {
    await takeAnswers();
    await takeReady();
  } catch (error) {
    log(`linear sync: ${error.message.slice(0, 300)}`);
  }
}

// --- Clean-up (INV-48): copies and branches of finished tasks go; see janitor.mjs for the rules ---

function repoSlug() {
  return /github\.com[:/](.+?)(?:\.git)?$/.exec(git(config.repo, ['remote', 'get-url', 'origin']))?.[1];
}

async function cleanupFacts({ fetch }) {
  if (fetch) git(config.repo, ['fetch', '-q', '--prune', 'origin']);
  const managed = [config.worktrees, config.legacyWorktrees];
  const copies = parseWorktrees(git(config.repo, ['worktree', 'list', '--porcelain']))
    .filter((w) => managed.includes(path.dirname(w.path)))
    .map((w) => {
      let dirty = true;
      try {
        dirty = execFileSync('git', ['status', '--porcelain'], { cwd: w.path, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' }, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim() !== '';
      } catch {
        // a copy git cannot read is treated as holding work
      }
      return { ...w, dirty };
    });
  const refs = (prefix) => git(config.repo, ['for-each-ref', prefix, '--format=%(refname:short) %(objectname)'])
    .split('\n').filter(Boolean).map((line) => { const [name, head] = line.split(' '); return { name, head }; });
  const remoteBranches = refs('refs/remotes/origin').filter((b) => b.name.startsWith('origin/') && b.name !== 'origin/HEAD')
    .map((b) => ({ name: b.name.slice('origin/'.length), head: b.head }));
  const prs = await gh(['pr', 'list', '--state', 'all', '--limit', '500', '--json', 'number,headRefName,headRefOid,state'], { json: true });
  // The plugin's copy, the copy this runner runs from, and the main checkout are never touched.
  const protectedPaths = [path.join(config.legacyWorktrees, 'plugin-runtime'), path.dirname(HERE), config.repo];
  return { copies, prs, localBranches: refs('refs/heads'), remoteBranches, protectedPaths, queue: readJson(QUEUE, []) };
}

async function cleanup({ only = null, dryRun = false } = {}) {
  let facts;
  try {
    facts = await cleanupFacts({ fetch: !dryRun });
  } catch (error) {
    log(`cleanup: ${error.message.split('\n')[0]}`);
    return null;
  }
  if (only) {
    facts.copies = facts.copies.filter((c) => c.branch === only);
    facts.localBranches = facts.localBranches.filter((b) => b.name === only);
    facts.remoteBranches = facts.remoteBranches.filter((b) => b.name === only);
  }
  const plan = planCleanup(facts);
  const done = { copies: 0, local: 0, remote: 0, logs: 0 };
  if (dryRun) return { plan, done };
  const tried = (what, fn) => {
    try {
      fn();
      return true;
    } catch (error) {
      log(`cleanup: ${what}: ${error.message.split('\n')[0]}`);
      return false;
    }
  };
  for (const c of plan.removeCopies) {
    if (tried(c.path, () => git(config.repo, ['worktree', 'remove', c.path]))) { done.copies += 1; log(`cleanup: removed ${c.path} (${c.why})`); }
  }
  for (const name of plan.deleteLocal) if (tried(name, () => git(config.repo, ['branch', '-D', name]))) done.local += 1;
  const slug = plan.deleteRemote.length ? repoSlug() : null;
  for (const name of plan.deleteRemote) {
    try {
      await gh(['api', '-X', 'DELETE', `repos/${slug}/git/refs/heads/${name}`], { asBot: true });
      done.remote += 1;
    } catch (error) {
      log(`cleanup: origin/${name}: ${error.message.split('\n')[0]}`);
    }
  }
  if (!only) {
    tried('worktree prune', () => git(config.repo, ['worktree', 'prune']));
    const logsDir = path.join(STATE, 'logs');
    const files = fs.readdirSync(logsDir).map((name) => ({ name, mtimeMs: fs.statSync(path.join(logsDir, name)).mtimeMs }));
    for (const name of oldLogs(files, new Date())) if (tried(name, () => fs.rmSync(path.join(logsDir, name)))) done.logs += 1;
    // The copy of a brief goes when its task is merged or closed and no longer queued; Linear keeps the brief.
    const last = new Map();
    for (const e of readLedger()) if (e.issue && e.status !== 'ci-evals') last.set(e.issue, e.status);
    const briefs = path.join(STATE, 'briefs');
    for (const file of fs.existsSync(briefs) ? fs.readdirSync(briefs) : []) {
      const issue = file.replace(/\.md$/, '');
      if (!facts.queue.some((t) => t.issue === issue) && ['merged', 'closed'].includes(last.get(issue))) tried(file, () => fs.rmSync(path.join(briefs, file)));
    }
  }
  for (const kept of plan.report) await reportCopyKept(kept);
  if (done.copies + done.local + done.remote + done.logs > 0) log(`cleanup: ${cleanupSummary(plan, done)}`);
  return { plan, done };
}

// A copy whose PR is over but that holds unsaved work stays; Yoan is told once, in the task.
async function reportCopyKept(kept) {
  const stateFile = path.join(STATE, 'cleanup.json');
  const state = readJson(stateFile, {});
  if ((state.told ?? []).includes(kept.path)) return;
  const issue = /^inv-(\d+)/i.exec(kept.branch)?.[1];
  log(`cleanup: kept ${kept.path}: ${kept.why}`);
  if (issue) {
    try {
      const found = (await linear('query($id:String!){issue(id:$id){id}}', { id: `INV-${issue}` }))?.issue;
      if (found) {
        await linear('mutation($id:String!,$body:String!){commentCreate(input:{issueId:$id,body:$body}){success}}', {
          id: found.id,
          body: `**Копието остава на диска:** \`${kept.path}\`. ${kept.why.replace(/^PR/, 'PR-ът')}. Нищо не се губи; копието се маха, щом работата в него бъде записана или вече не трябва.`,
        });
      }
    } catch (error) {
      log(`linear: ${error.message}`);
    }
  }
  state.told = [...(state.told ?? []).slice(-50), kept.path];
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
}

// Once a day, after the night window, and never while a session runs.
async function maybeCleanup() {
  const now = new Date();
  if (inWindow(now, config.windowStart, config.windowEnd)) return;
  const stateFile = path.join(STATE, 'cleanup.json');
  const today = now.toLocaleDateString('sv-SE');
  if (readJson(stateFile, {}).lastRun === today) return;
  if (fs.readdirSync(path.join(STATE, 'locks')).length > 0) return;
  retireOldCopies();
  const result = await cleanup();
  const state = readJson(stateFile, {});
  state.lastRun = today;
  if (result) state.summary = { day: today, text: cleanupSummary(result.plan, result.done) };
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
}

// Before each round: the main checkout follows origin/main, so that merged changes to the runner and the agents take
// effect. It is fast-forwarded only when it is on main with no changes to tracked files. When the runner's own code
// changed, a runner under launchd exits and launchd starts it again with the new code.
function updateRunnerCode() {
  if (!RUNS_FROM_REPO || !startCommit) return;
  try {
    const branch = git(config.repo, ['symbolic-ref', '--short', 'HEAD']);
    const dirty = git(config.repo, ['status', '--porcelain', '--untracked-files=no']) !== '';
    if (branch !== 'main' || dirty) {
      logOnce(`repo:${branch}:${dirty}`, `the main checkout is ${dirty ? 'changed' : `on ${branch}`}; it is not updated until it is clean main again`);
      return;
    }
    git(config.repo, ['fetch', '-q', 'origin']);
    git(config.repo, ['merge', '-q', '--ff-only', 'origin/main']);
    if (git(config.repo, ['diff', '--name-only', startCommit, 'HEAD', '--', 'factory/']) === '') return;
    if (process.env.INVOICELY_SERVICE === '1') {
      log('the runner code changed in main; exiting so that launchd starts the new code');
      process.exit(0);
    }
    logOnce(`code:${git(config.repo, ['rev-parse', 'HEAD'])}`, 'the runner code changed in main; restart the runner to use it');
  } catch (error) {
    log(`update: ${error.message.split('\n')[0]}`);
  }
}

// The two copies the runner needed before INV-49 go once it runs from the repo: the plugin's old copy and the
// runner's old copy in ~/projects/ia-wt. Only when clean, and the runner's old copy only once the bot tools no
// longer load code from it. The old folder goes when it is empty. The copy guard stops removing them by hand.
function retireOldCopies() {
  if (!RUNS_FROM_REPO) return;
  const tools = path.join(STATE, 'tools');
  const usedByTools = (dir) => fs.existsSync(tools) && fs.readdirSync(tools).some((f) => f.endsWith('.mjs') && fs.readFileSync(path.join(tools, f), 'utf8').includes(dir));
  for (const name of ['plugin-runtime', 'factory-runner']) {
    const old = path.join(config.legacyWorktrees, name);
    if (!fs.existsSync(old)) continue;
    if (usedByTools(old)) {
      logOnce(`tools:${old}`, `kept ${old}: a bot tool in ${tools} still loads code from it`);
      continue;
    }
    try {
      if (git(old, ['status', '--porcelain']) !== '') {
        logOnce(`changed:${old}`, `kept ${old}: it has changes`);
        continue;
      }
      git(config.repo, ['worktree', 'remove', old]);
      log(`removed ${old}: the runner runs from ${config.repo}, the plugin loads from ${config.plugin}`);
    } catch (error) {
      log(`${old}: ${error.message.split('\n')[0]}`);
    }
  }
  try {
    if (fs.existsSync(config.legacyWorktrees) && fs.readdirSync(config.legacyWorktrees).every((f) => f === '.DS_Store')) {
      fs.rmSync(config.legacyWorktrees, { recursive: true });
      log(`removed the empty ${config.legacyWorktrees}`);
    }
  } catch (error) {
    log(`${config.legacyWorktrees}: ${error.message}`);
  }
}

// The same line every 5 minutes says nothing new: a state is logged once.
const loggedOnce = new Set();
function logOnce(key, message) {
  if (loggedOnce.has(key)) return;
  loggedOnce.add(key);
  log(message);
}

// A task over its cap leaves the queue and asks Yoan (INV-47). The entry keeps the task as it was, so that
// "продължи" puts it back with one more default budget.
async function stopOverBudget(task, spent, cap) {
  const entry = {
    issue: task.issue, branch: task.branch, base: task.base || 'main', ended: new Date().toISOString(), status: 'over_budget',
    spentUsd: Math.round(spent * 100) / 100, capUsd: cap, session: task.resumeSession ?? task.session ?? null, task,
    ...(task.pr ? { pr: task.pr } : {}),
  };
  ledger(entry);
  updateItem(task.issue, null);
  log(`${task.issue}: over its cap ($${entry.spentUsd} of $${cap}), taken out of the queue`);
  await reportToLinear(entry, '');
}

async function runQueue(now) {
  retireOldCopies();
  for (;;) {
    if (fs.existsSync(PAUSED)) {
      logOnce(`paused:${fs.statSync(PAUSED).mtimeMs}`, 'paused: no sessions, CI merges or clean-up until `factory resume`');
      await sleep(60 * 1000);
      continue;
    }
    updateRunnerCode();
    await syncFromLinear();
    await processCi();
    await maybeCleanup();
    let queue = readJson(QUEUE, []);
    if (queue.length === 0) {
      await reportNight('Опашката е празна.');
      await sleep(5 * 60 * 1000); // keep watching Linear for tasks in Ready
      continue;
    }
    const merged = await mergedByBase(queue);
    await dropBlocked(queue, merged);
    queue = readJson(QUEUE, []);
    const waitingForCi = queue.some((t) => t.stage === 'ci');
    const task = nextRunnable(queue, merged);
    if (!task) {
      if (!waitingForCi) await reportNight('Нищо не може да тръгне: всяка задача чака зависимост.');
      await sleep((waitingForCi ? 2 : 5) * 60 * 1000);
      continue;
    }
    if (!now && !inWindow(new Date(), config.windowStart, config.windowEnd)) {
      await reportNight(`Нощта свърши. В опашката остават: ${queue.map((t) => `${t.issue}${t.stage === 'ci' ? ' (чака CI)' : ''}`).join(', ')}.`);
      // By day: no sessions, but CI, merges and Linear (answers, tasks in Ready) are still followed every 5 minutes.
      await sleep(Math.min(5 * 60 * 1000, nextWindowStart(new Date(), config.windowStart) - Date.now()));
      continue;
    }
    // Two caps (INV-47): the task's, over all its sessions, and the period's (night or day), sessions and CI evals
    // together. A session never gets more than what is left of either, also when started with --now.
    const entries = readLedger();
    const period = spendingPeriod(new Date(), config);
    const periodSpent = spentSince(entries, period.start);
    const taskCap = task.budgetUsd ?? config.budgetUsd;
    const spentOnTask = taskSpent(entries, task.issue);
    const { budget, stoppedBy } = sessionBudget({ taskCap, taskSpent: spentOnTask, periodCap: period.cap, periodSpent });
    if (budget === 0 && stoppedBy === 'task') {
      await stopOverBudget(task, spentOnTask, taskCap);
      continue;
    }
    if (budget === 0) {
      logOnce(`cap:${period.kind}:${period.start.toISOString()}`, `${period.kind} cap reached: $${periodSpent.toFixed(2)} of $${period.cap}; no new session until the next period`);
      await sleep(5 * 60 * 1000);
      continue;
    }
    let result;
    try {
      result = await runTask(task, budget);
    } catch (error) {
      // A run that could not even start (no network after the Mac wakes, GitHub down) keeps its place in the queue
      // and is tried again in 5 minutes; only after 6 failed starts in a row is it taken out.
      const failures = (task.startFailures ?? 0) + 1;
      log(`${task.issue}: could not run (${failures}/6): ${error.message.split('\n')[0]}`);
      if (failures < 6) {
        updateItem(task.issue, { startFailures: failures });
        await sleep(5 * 60 * 1000);
        continue;
      }
      ledger({ issue: task.issue, branch: task.branch, ended: new Date().toISOString(), status: 'error', error: error.message });
      result = { status: 'error' };
    }
    const pr = result.pr || task.pr;
    if (result.status === 'limit' && result.reset) {
      updateItem(task.issue, { resumeSession: result.session, message: undefined, startFailures: undefined });
      await sleepUntil(new Date(result.reset.getTime() + 3 * 60 * 1000));
    } else if (isFeatureBranch(task.base) && pr && (result.status === 'done' || (task.pr && result.status === 'needs_answer'))) {
      updateItem(task.issue, { stage: 'ci', pr, session: result.session || task.session, ciSince: new Date().toISOString(), resumeSession: undefined, message: undefined });
      log(`${task.issue}: waiting for CI on ${pr}`);
    } else {
      updateItem(task.issue, null);
    }
  }
}

// The runner as a launchd service: starts at login, starts again when it stops (a crash, or new code in main),
// logs to runner.log. Install it once, after the manual runner is stopped.
const LABEL = 'com.invoicely.runner';
function service(sub) {
  const plistFile = path.join(HOME, 'Library', 'LaunchAgents', `${LABEL}.plist`);
  const domain = `gui/${process.getuid()}`;
  if (sub === 'install') {
    if (!RUNS_FROM_REPO) return console.log(`install the service from the main checkout: node ${path.join(config.repo, 'factory', 'factory.mjs')} service install`);
    const nodeBin = config.nodeBin || path.dirname(process.execPath);
    fs.mkdirSync(path.dirname(plistFile), { recursive: true });
    fs.writeFileSync(plistFile, servicePlist({
      label: LABEL, node: path.join(nodeBin, 'node'), script: path.join(config.repo, 'factory', 'factory.mjs'), cwd: config.repo,
      logFile: path.join(STATE, 'logs', 'runner.log'), pathEnv: `${nodeBin}:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin`, home: HOME,
    }));
    execFileSync('launchctl', ['bootstrap', domain, plistFile], { stdio: 'inherit' });
    return console.log(`installed ${plistFile}; the runner runs as ${LABEL}`);
  }
  if (sub === 'uninstall') {
    try {
      execFileSync('launchctl', ['bootout', `${domain}/${LABEL}`], { stdio: 'inherit' });
    } catch {
      // not loaded
    }
    fs.rmSync(plistFile, { force: true });
    return console.log(`uninstalled ${LABEL}`);
  }
  try {
    const out = execFileSync('launchctl', ['print', `${domain}/${LABEL}`], { stdio: ['ignore', 'pipe', 'ignore'] }).toString();
    return console.log(out.split('\n').filter((l) => /state =|pid =|last exit code/.test(l)).map((l) => l.trim()).join('\n'));
  } catch {
    return console.log(`${LABEL} is not installed (factory service install)`);
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
  if (command === 'pause') {
    fs.writeFileSync(PAUSED, `${new Date().toISOString()}\n`);
    console.log('paused: the runner finishes the session that runs now and then starts nothing until `factory resume`');
    if (sub === '--wait' || rest.includes('--wait')) {
      while (fs.readdirSync(path.join(STATE, 'locks')).length > 0) {
        console.log(`waiting for ${fs.readdirSync(path.join(STATE, 'locks')).join(', ')} to finish`);
        await sleep(60 * 1000);
      }
      console.log('no session runs: the copies may be worked on');
    }
    return undefined;
  }
  if (command === 'resume') {
    fs.rmSync(PAUSED, { force: true });
    return console.log('resumed');
  }
  // Puts a task back from the ledger, instead of editing queue.json by hand: --ci to wait for its PR's CI and merge
  // it when green, otherwise to resume its session (with --message <text>).
  if (command === 'requeue') {
    const issue = sub;
    const entries = readLedger().filter((e) => e.issue === issue);
    const last = [...entries].reverse().find((e) => e.branch);
    if (!issue || !last) return console.log(`usage: factory requeue <INV-xx> [--ci | --message <text>]; no run of ${issue ?? '?'} in the ledger`);
    if (readJson(QUEUE, []).some((t) => t.issue === issue)) return console.log(`${issue} is already in the queue`);
    const session = [...entries].reverse().find((e) => e.session)?.session;
    const pr = [...entries].reverse().find((e) => e.pr)?.pr;
    const worktree = [...entries].reverse().find((e) => e.worktree)?.worktree;
    const at = rest.indexOf('--message');
    const item = rest.includes('--ci')
      ? { issue, branch: last.branch, base: last.base, stage: 'ci', pr, session, ciSince: new Date().toISOString(), fixRounds: 1, worktree }
      : { issue, branch: last.branch, base: last.base, resumeSession: session, pr, worktree, message: at >= 0 ? rest[at + 1] : undefined };
    if (item.stage === 'ci' && !pr) return console.log(`${issue} has no PR in the ledger`);
    for (const key of Object.keys(item)) if (item[key] === undefined) delete item[key];
    const queue = readJson(QUEUE, []);
    queue.unshift(item);
    fs.writeFileSync(QUEUE, JSON.stringify(queue, null, 2));
    return log(`requeued ${issue}${item.stage === 'ci' ? ` to wait for CI on ${pr}` : ''}`);
  }
  if (command === 'service') return service(sub);
  if (command === 'clean') {
    const dryRun = sub === '--dry-run' || rest.includes('--dry-run');
    const result = await cleanup({ dryRun });
    if (!result) return undefined;
    const { plan } = result;
    for (const c of plan.removeCopies) console.log(`${dryRun ? 'would remove' : 'removed'} copy ${c.path} (${c.why})`);
    for (const c of plan.keepCopies) console.log(`keep copy ${c.path}: ${c.why}`);
    if (plan.deleteLocal.length) console.log(`${dryRun ? 'would delete' : 'deleted'} local branches: ${plan.deleteLocal.join(', ')}`);
    if (plan.deleteRemote.length) console.log(`${dryRun ? 'would delete' : 'deleted'} branches on GitHub: ${plan.deleteRemote.join(', ')}`);
    return undefined;
  }
  if (command === 'run') return runTask(parseTask([sub, ...rest]));
  if (command === 'status') {
    console.log('queue:', JSON.stringify(readJson(QUEUE, []), null, 2));
    console.log('locks:', fs.readdirSync(path.join(STATE, 'locks')).join(', ') || 'none');
    const app = appSettings(STATE);
    console.log('github:', app ? `${app.slug}[bot] (App ${app.appId}, installation ${app.installationId})` : 'Yoan (no GitHub App in config.json)');
    const entries = readLedger();
    const period = spendingPeriod(new Date(), config);
    console.log(`${period.kind} since ${period.start.toLocaleString()}: $${spentSince(entries, period.start).toFixed(2)} of $${period.cap}`);
    for (const t of readJson(QUEUE, [])) {
      console.log(`  ${t.issue}: sessions $${taskSpent(entries, t.issue).toFixed(2)} of $${t.budgetUsd ?? config.budgetUsd}`);
    }
    const costs = entryCosts(entries);
    console.log('last runs:');
    entries.forEach((r, i) => {
      if (i < entries.length - 10) return;
      console.log(`  ${r.ended} ${r.issue} ${r.status}${r.minutes == null ? '' : ` ${r.minutes}min`} $${costs[i].toFixed(2)} ${r.pr ?? ''}`);
    });
    return undefined;
  }
  console.log('usage: factory queue add <INV-xx> --branch <b> --brief <file> [...] | factory queue run [--now] | factory run <INV-xx> ... | factory status | factory clean [--dry-run] | factory pause [--wait] | factory resume | factory requeue <INV-xx> [--ci | --message <text>] | factory service install|uninstall|status');
  return undefined;
}

main().catch((error) => {
  log(`error: ${error.message}`);
  process.exit(1);
});
