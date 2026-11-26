#!/usr/bin/env node
// The runner: from a task in Linear to a merged PR with a review and a summary (INV-64, the document "Процесът").
//
//   1. A task Yoan moves to Ready goes into the queue, unless a task that blocks it is still open.
//   2. test-author writes the tests in its own session; the runner commits them. Then the implementer, in another
//      session, writes the code until they pass; the runner commits, pushes and opens the PR to main. The role guard
//      locks the tests for the implementer and the code for test-author, and the runner checks every session's diff.
//      A test the implementer calls wrong goes back to test-author with the reason.
//   3. The reviewer reads the PR in CI (the review job) and writes a GitHub review, inline where it can.
//   4. Findings or a red CI: the implementer fixes them in the same PR and the reviewer looks again. After 3 rounds
//      the task goes to "Чака Йоан" with the question. An exhausted Max limit is not a failure: the step waits and
//      runs again after the reset.
//   5. Reviewer PASS and green CI: the runner merges.
//   6. The summary goes into the task; a task labelled UI goes to "Чака Йоан" for Yoan's check, the others to Done.
//
//   factory queue run              the runner (launchd runs it as com.invoicely.runner)
//   factory status                 the queue, locks and the last runs
//   factory pause [--wait] | resume
//   factory requeue <INV-xx> [--message <text>]   put back a task that waits for Yoan, without his answer in Linear
//   factory clean [--dry-run]      copies and branches of finished tasks
//   factory linear ask|comment <INV-xx> --body-file <file> | factory linear state <INV-xx> <state>
//   factory service install|uninstall|status
import { execFileSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mergeInProgress, policyViolations, unmergedFiles } from './git-check.mjs';
import { appSettings, installationToken, sessionEnv, writeGhConfig } from './github-app.mjs';
import { documentsBlock, linearDocument, linearGlossary, prDocumentsSection, sessionGate, taskDocuments } from './documents.mjs';
import { cleanupSummary, oldLogs, parseWorktrees, planCleanup } from './janitor.mjs';
import { linearClient, mention } from './linear.mjs';
import { answerAfter, planFromReady } from './linear-sync.mjs';
import {
  budgetAnswer, classify, entryCosts, fillTemplate, findingLines, fixMessage, isReviewCheck, minutesBetween, newQueueEntry, nextRunnable,
  parseOutcome, parseResult, retryAt, reviewDecision, reviewText, servicePlist, sessionArgs, statusAction, stoppedTaskPlan, summaryBody, taskCost,
  transcriptFile,
} from './lib.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOME = os.homedir();
const STATE = process.env.INVOICELY_HOME || path.join(HOME, '.invoicely');
const AGENTS_REPO = path.join(HOME, 'projects', 'invoicely-agents');
const config = {
  // The repos the agents work in; a task's Linear label picks one (see linear-sync.mjs).
  repos: { invoicely: path.join(HOME, 'projects', 'invoicely'), 'invoicely-agents': AGENTS_REPO },
  // The plugin loads from its own copy, outside the repo: Claude Code refuses edits to every file under a loaded
  // plugin's folder, and the task copies live inside the repo (INV-49).
  plugin: path.join(STATE, 'plugin'),
  pluginRef: 'origin/main',
  budgetUsd: 15, // API dollars a task's sessions may spend; then it asks Yoan
  nodeBin: '',
  linearTeam: 'INV',
  ...readJson(path.join(STATE, 'config.json'), {}),
};
// The sandbox of the agent sessions (INV-57): their Bash commands may not read the runner's state, SSH, gh, AWS,
// Docker or git credentials or the Keychain, and reach only GitHub and npm.
const SANDBOX = path.join(HERE, 'sandbox.json');
const QUEUE = path.join(STATE, 'queue.json');
const LEDGER = path.join(STATE, 'ledger', 'runs.jsonl');
const PAUSED = path.join(STATE, 'paused');
for (const dir of ['locks', 'ledger', 'logs', 'briefs']) fs.mkdirSync(path.join(STATE, dir), { recursive: true });

const MAX_ROUNDS = 3; // review rounds before the task goes to Yoan
const MAX_DISPUTES = 2; // times a test may go back to test-author before Yoan decides
const MAX_LIMIT_WAITS = 8; // limit resets waited for in a row before Yoan is told ("Credit balance is too low" may not reset)
const MAX_REVIEW_ERRORS = 5; // rounds in a row in which GitHub or git failed on a PR before Yoan is told
const REVIEW_TIMEOUT_MINUTES = 150;
const PR_BODY_LIMIT = 65000; // GitHub refuses a PR description of more than about 65 536 characters

// The runner runs from the main checkout of invoicely-agents, which stays on main and which nobody works in.
const RUNS_FROM_REPO = path.resolve(path.dirname(HERE)) === path.resolve(AGENTS_REPO);
let startCommit = null;
try {
  startCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: path.dirname(HERE), stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
} catch {
  // not a git checkout: no self-update
}

// What the sessions may run. They do not commit, merge, push or open PRs: the runner does, as the bot.
const COMMON_TOOLS = [
  'Agent', 'Read', 'Write', 'Edit', 'Glob', 'Grep',
  'Bash(git status:*)', 'Bash(git diff:*)', 'Bash(git log:*)', 'Bash(git show:*)', 'Bash(ls:*)', 'Bash(mkdir:*)',
];
const REPO_TOOLS = {
  // The * form: on 25.11 `Bash(node scripts/:*)` refused `node scripts/x.mjs`, `Bash(node scripts/*)` allowed it.
  'invoicely-agents': ['Bash(node --test:*)', 'Bash(node --check:*)', 'Bash(claude plugin validate:*)', 'Bash(node scripts/*)', 'Bash(node hooks/*)'],
  invoicely: ['Bash(pnpm:*)', 'Bash(node --test:*)', 'Bash(npx tsc:*)', 'Bash(npx vitest:*)', 'Bash(npx eslint:*)', 'Bash(npx playwright:*)'],
};

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

// The same line every round says nothing new: a state is logged once.
const loggedOnce = new Set();
function logOnce(key, message) {
  if (loggedOnce.has(key)) return;
  loggedOnce.add(key);
  log(message);
}

function git(cwd, args, env) {
  return execFileSync('git', args, { cwd, env: env ?? process.env, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 }).toString().trim();
}

const gitZ = (cwd, args) => execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 }).toString().split('\0').filter(Boolean);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// --- The queue and the ledger ---

function readQueue() {
  return readJson(QUEUE, []);
}

function writeQueue(queue) {
  fs.writeFileSync(QUEUE, JSON.stringify(queue, null, 2));
}

// Change one queue item by its task id; null removes it. The file is re-read, so edits made meanwhile stay.
function updateItem(issue, change) {
  const queue = readQueue();
  const at = queue.findIndex((t) => t.issue === issue);
  if (at === -1) return;
  if (change === null) queue.splice(at, 1);
  else {
    queue[at] = { ...queue[at], ...change };
    for (const key of Object.keys(queue[at])) if (queue[at][key] === undefined) delete queue[at][key];
  }
  writeQueue(queue);
}

function ledger(entry) {
  fs.appendFileSync(LEDGER, `${JSON.stringify({ ended: new Date().toISOString(), ...entry })}\n`);
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

// --- Copies, the plugin and GitHub ---

// The plugin loads from its own copy at origin/main: a PR cannot change the agents that work on it.
function ensureRuntime() {
  const runtime = config.plugin;
  if (!fs.existsSync(runtime)) {
    git(AGENTS_REPO, ['fetch', '-q', 'origin']);
    git(AGENTS_REPO, ['worktree', 'add', '-q', '--detach', runtime, config.pluginRef]);
  } else {
    git(runtime, ['fetch', '-q', 'origin']);
    git(runtime, ['checkout', '-q', '--detach', config.pluginRef]);
  }
  return runtime;
}

const repoDir = (task) => config.repos[task.repo] ?? config.repos.invoicely;
// The task's copy is one of Claude Code's own worktrees in the repo, .claude/worktrees/<branch> (in .gitignore). It
// lives as long as the task: the runner removes it after the merge.
const copyPath = (task) => path.join(repoDir(task), '.claude', 'worktrees', task.branch);

function ensureWorktree(task) {
  const wt = copyPath(task);
  if (fs.existsSync(wt)) return wt;
  const repo = repoDir(task);
  fs.mkdirSync(path.dirname(wt), { recursive: true });
  git(repo, ['fetch', '-q', 'origin']);
  try {
    git(repo, ['worktree', 'add', '-q', wt, task.branch]);
  } catch {
    git(repo, ['worktree', 'add', '-q', '-b', task.branch, wt, 'origin/main']);
  }
  return wt;
}

function repoSlug(repo) {
  return /github\.com[:/](.+?)(?:\.git)?$/.exec(git(repo, ['remote', 'get-url', 'origin']))?.[1];
}

// The bot's environment for the runner's own git and gh: commits, pushes, PRs and merges go out as the GitHub App.
async function botEnv() {
  const app = appSettings(STATE);
  if (!app) return { ...process.env };
  const ghConfigDir = path.join(STATE, 'gh-bot');
  writeGhConfig(ghConfigDir, await installationToken(app), app.slug);
  return sessionEnv({ ...process.env }, {
    slug: app.slug, botUserId: app.botUserId, ghConfigDir,
    helperCommand: `!'${process.execPath}' '${path.join(HERE, 'github-app.mjs')}' git-credential`,
  });
}

// gh for the runner; asBot as the GitHub App, otherwise as Yoan (reads, and reruns the App may not do).
async function gh(args, { asBot = false, json = false, cwd = AGENTS_REPO } = {}) {
  const env = asBot ? await botEnv() : { ...process.env };
  let out;
  try {
    out = execFileSync('gh', args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 }).toString();
  } catch (error) {
    // gh pr checks exits with 8 while checks run and 1 when one failed, and still prints the JSON.
    out = error.stdout?.toString() ?? '';
    if (!json || !out.trim()) throw new Error(`gh ${args.join(' ')}: ${(error.stderr?.toString() || error.message).trim().slice(0, 300)}`);
  }
  return json ? JSON.parse(out) : out.trim();
}

// --- The role guard after every session ---

// The policy comes from the plugin's copy at origin/main, not from the task's branch.
function guardViolations(wt, before, role) {
  return policyViolations(wt, before, role, path.join(ensureRuntime(), 'policies', 'role-guard.yaml'));
}

// The runner's own git never runs hooks: nothing a session wrote may run with the bot's token.
const NO_HOOKS = ['-c', 'core.hooksPath=/dev/null'];

// Commits everything in the copy as the bot; finishes a merge of main when one is in progress. Returns true when
// there was something to commit. The caller checks for unresolved conflicts first.
async function commitAll(wt, message) {
  const env = await botEnv();
  git(wt, ['add', '-A'], env);
  const merging = mergeInProgress(wt);
  if (!merging && git(wt, ['diff', '--cached', '--name-only']) === '') return false;
  git(wt, [...NO_HOOKS, 'commit', '-q', ...(merging ? ['--no-edit'] : ['-m', message])], env);
  return true;
}

async function push(task, wt) {
  git(wt, [...NO_HOOKS, 'push', '-q', '-u', 'origin', `HEAD:refs/heads/${task.branch}`], await botEnv());
  return git(wt, ['rev-parse', 'HEAD']);
}

// --- Sessions ---

const CONTINUE = 'You were interrupted (the usage limit, a restart or the Mac turned off). Continue exactly where you stopped and finish the same instructions, ending with the RESULT line.';

// The tasks whose session runs now: lock files of a process that is gone (a power cut) do not count.
function activeLocks() {
  return fs.readdirSync(path.join(STATE, 'locks')).filter((file) => {
    const pid = Number(readJson(path.join(STATE, 'locks', file), {}).pid);
    if (!pid) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return error.code === 'EPERM';
    }
  }).map((file) => file.replace(/\.lock$/, ''));
}

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

// Where Claude Code's own installer puts claude (~/.local/bin, since 25.11 on this Mac), before the service's PATH.
const SESSION_PATH = (base) => [config.nodeBin, path.join(HOME, '.local', 'bin'), base].filter(Boolean).join(':');

function runClaude(args, cwd, logFile, role, onStart = () => {}) {
  return new Promise((resolve) => {
    const env = { ...process.env };
    env.PATH = SESSION_PATH(env.PATH);
    // The session works without any GitHub identity: the runner pushes and opens the PR.
    for (const key of ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN']) delete env[key];
    // The role guard reads the role from here, for the whole session and its subagents.
    env.INVOICELY_ROLE = role;
    // A headless session ends with its last turn: an agent left running in the background would be lost with it.
    env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS = '1';
    // Marks the agent's session: the runner's own CLI refuses to run inside it (see main).
    env.INVOICELY_AGENT_SESSION = '1';
    const child = spawn('claude', args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      out.end();
      resolve(result);
    };
    child.on('spawn', onStart);
    const out = fs.createWriteStream(logFile, { flags: 'a' });
    child.stdout.on('data', (chunk) => { stdout += chunk; out.write(chunk); });
    child.stderr.on('data', (chunk) => out.write(chunk));
    // claude not found or not startable: the step failed to start, the runner itself goes on (25.11: ENOENT under
    // launchd crashed the runner every minute).
    child.on('error', (error) => finish({ code: null, stdout, spawnError: error }));
    child.on('close', (code) => finish({ code, stdout }));
  });
}

// A session can be resumed only when Claude Code kept its transcript; one that never started cannot.
function sessionExists(cwd, id) {
  return fs.existsSync(transcriptFile(HOME, cwd, id));
}

function testsLine(task) {
  if (!task.testsCommit) return 'test-author wrote no tests for this task; its report says why.';
  return `in commit ${task.testsCommit.slice(0, 10)}: ${(task.testFiles ?? []).join(', ') || 'see git show --stat'}`;
}

// The documents the agents got, kept next to the brief for the PR description.
const documentsFile = (task) => path.join(STATE, 'briefs', `${task.issue}.documents.json`);

// The task's Linear documents (INV-71): the linked ones, and the glossary for the invoicely repo.
async function readTaskDocuments(task, text) {
  return taskDocuments({
    text, repo: task.repo,
    getDocument: (slugId) => linearDocument(linear, slugId),
    findGlossary: () => linearGlossary(linear).catch((error) => {
      log(`${task.issue}: the glossary could not be read: ${error.message.slice(0, 200)}`);
      return null;
    }),
  });
}

// One session of a role on the task's copy: a new one with the role's prompt, or the same session resumed with a
// message. Returns what the session left: its status, its report and what it cost.
async function runSession(task, role, wt, budget) {
  const runtime = ensureRuntime();
  const sessions = task.sessions ?? {};
  const base = { role, pluginDir: runtime, sandboxFile: SANDBOX, budget, tools: [...COMMON_TOOLS, ...(REPO_TOOLS[task.repo] ?? [])] };
  let args;
  let id = sessions[role] && sessionExists(wt, sessions[role]) ? sessions[role] : null;
  if (sessions[role] && !id) log(`${task.issue}: ${role} session ${sessions[role]} has no transcript, so a new session starts`);
  const resumed = Boolean(id);
  if (id) {
    args = sessionArgs({ ...base, prompt: task.message || CONTINUE, resume: id });
  } else {
    // The Linear documents the task links, read now for their last version (INV-71). A document that cannot be read
    // stops the task with a question, before any session starts.
    const text = fs.readFileSync(task.brief, 'utf8').trim();
    const { docs, unreadable } = await readTaskDocuments(task, text);
    const gate = sessionGate({ text, unreadable });
    if (gate.action === 'ask') {
      await askYoan(task, {
        kind: 'documents', role,
        what: gate.what,
        todo: 'оправи задачата (критериите или линковете към документите) или достъпа до документа и пиши тук "опитай пак". Предложение: махни линка, ако документът вече не трябва.',
        ifNot: 'задачата стои, сесия не се пуска.',
      });
      return { status: 'asked', text: '', report: '', session: null };
    }
    fs.writeFileSync(documentsFile(task), JSON.stringify(docs));
    // The session gets its id up front and the queue remembers it, so a run cut off by a restart resumes it.
    id = crypto.randomUUID();
    const prompt = fillTemplate(fs.readFileSync(path.join(HERE, 'prompts', `${role}.md`), 'utf8'), {
      ISSUE: task.issue, TASK: text, DOCUMENTS: documentsBlock(docs), WT: wt, REPO: task.repo, BRANCH: task.branch, TESTS: testsLine(task),
    });
    const message = task.message && task.message !== CONTINUE ? task.message : '';
    args = sessionArgs({ ...base, prompt: message ? `${prompt}\n\n${message}` : prompt, sessionId: id });
    updateItem(task.issue, { sessions: { ...sessions, [role]: id } });
  }
  const started = new Date();
  const logFile = path.join(STATE, 'logs', `${task.issue}-${role}-${started.toISOString().replace(/[:.]/g, '-')}.log`);
  log(`${task.issue}: ${role} starts in ${wt}${resumed ? ' (resumed)' : ''}, cap $${budget}`);
  // Once claude runs, a restart resumes the session instead of repeating the instructions. Not before: a claude that
  // does not start leaves the step's message (findings, Yoan's answer) in the queue for the next try.
  const { code, stdout, spawnError } = await runClaude(args, wt, logFile, role, () => updateItem(task.issue, { message: CONTINUE }));
  if (spawnError) throw new Error(`claude did not start: ${spawnError.message}`);
  const result = parseResult(stdout);
  const status = classify(result);
  const ended = new Date();
  const session = result.sessionId || id;
  const runCost = result.costUsd == null ? null : entryCosts([...readLedger(), { session, sessionCostUsd: result.costUsd }]).at(-1);
  ledger({
    issue: task.issue, role, stage: task.stage, branch: task.branch, session, started: started.toISOString(), ended: ended.toISOString(),
    minutes: minutesBetween(started, ended), status, exitCode: code, costUsd: runCost, sessionCostUsd: result.costUsd, turns: result.turns, log: logFile,
  });
  log(`${task.issue}: ${role} ${status}${runCost == null ? '' : ` $${runCost.toFixed(2)}`}`);
  return { status, text: result.text, report: parseOutcome(result.text).report, session };
}

// Limit, error and question are the same for both roles. Returns true when the step ends here.
async function settleSession(task, role, r) {
  if (r.status === 'asked') return true; // no session started: runSession asked Yoan already
  if (r.status === 'limit') {
    const waits = (task.limitWaits ?? 0) + 1;
    if (waits > MAX_LIMIT_WAITS) {
      await askYoan(task, {
        kind: 'error', role,
        what: `лимитът на Max не се поднови след ${MAX_LIMIT_WAITS} изчаквания.`,
        todo: 'виж съобщението по-долу (може да е плащане или настройка, не лимит) и пиши тук "опитай пак", когато е наред.',
        ifNot: 'задачата стои.', details: r.text.slice(0, 1500),
      });
      return true;
    }
    const until = retryAt(r.text);
    limitUntil = Math.max(limitUntil, until.getTime());
    updateItem(task.issue, { waitUntil: until.toISOString(), limitWaits: waits, message: CONTINUE, sessions: { ...(task.sessions ?? {}), [role]: r.session } });
    log(`${task.issue}: ${role} stopped by the Max limit; again at ${until.toString()}`);
    return true;
  }
  updateItem(task.issue, { limitWaits: undefined, waitUntil: undefined });
  if (r.status === 'error') {
    await askYoan(task, {
      kind: 'error', role,
      what: `сесията на ${role} спря с грешка.`,
      todo: 'прочети грешката по-долу и пиши тук "опитай пак" или какво да промени. Предложение: "опитай пак".',
      ifNot: 'задачата стои, нищо не се променя.',
      details: r.text.slice(0, 1500),
    });
    return true;
  }
  if (r.status === 'question') {
    await askYoan(task, {
      kind: 'question', role,
      what: `отговор на въпроса на ${role}.`,
      todo: 'прочети въпроса и предложения отговор по-долу и отговори тук.',
      ifNot: 'задачата стои, нищо не се променя.',
      details: r.report.slice(0, 3000),
    });
    return true;
  }
  return false;
}

// A session that wrote outside its role gets one chance to put the files back; then Yoan is asked.
async function guardFailed(task, role, violations) {
  if (!task.guardRetry) {
    updateItem(task.issue, {
      guardRetry: 1,
      message: `The runner's check of your changes found files outside your role: ${violations.join('; ')}. Put them back as they were (git checkout or delete new files) and finish the same instructions without them, ending with the RESULT line.`,
    });
    log(`${task.issue}: ${role} wrote outside its role; one more try`);
    return;
  }
  await askYoan(task, {
    kind: 'question', role,
    what: `${role} промени файлове извън ролята си и не ги върна.`,
    todo: 'виж файловете по-долу и пиши тук какво да направи. Предложение: "върни ги и продължи".',
    ifNot: 'задачата стои, нищо не се слива.',
    details: violations.join('\n'),
  });
}

// --- The steps ---

// test-author: the tests of a new task, or its answer when the implementer called a test wrong.
async function stepTests(task) {
  const wt = ensureWorktree(task);
  const before = git(wt, ['rev-parse', 'HEAD']);
  const r = await runSession(task, 'test-author', wt, await budgetFor(task));
  if (await settleSession(task, 'test-author', r)) return;
  const violations = guardViolations(wt, before, 'test-author');
  if (violations.length) return guardFailed(task, 'test-author', violations);
  const dispute = task.stage === 'tests-fix';
  // Committed here and pushed with the code: a PR never shows the implementer's work half done.
  const changed = await commitAll(wt, dispute ? `${task.issue}: tests, after the implementer's report` : `${task.issue}: tests from the task's criteria`);
  const next = { stage: dispute ? (task.afterDispute ?? 'code') : 'code', guardRetry: undefined, waitUntil: undefined, afterDispute: undefined };
  if (changed) {
    const files = gitZ(wt, ['diff', '--no-renames', '--name-only', '-z', `${before}..HEAD`]);
    Object.assign(next, { testsCommit: git(wt, ['rev-parse', 'HEAD']), testFiles: [...new Set([...(task.testFiles ?? []), ...files])] });
  }
  if (!dispute) next.testReport = r.report;
  next.message = dispute
    ? `test-author answered your report about the tests:\n\n${r.report}\n\n${r.status === 'keep' ? 'The test stays as it is: implement to it, or end with RESULT: QUESTION if you still think the task says otherwise.' : `test-author changed the tests${changed ? ` (commit ${next.testsCommit.slice(0, 10)})` : ''}: run them again.`} Then finish the same instructions, ending with the RESULT line.`
    : undefined;
  updateItem(task.issue, next);
  log(`${task.issue}: tests ${changed ? 'committed' : 'unchanged'}; next ${next.stage}`);
}

// The implementer: the code until the tests pass, or a fix round. Then the runner commits, pushes and opens the PR.
async function stepCode(task) {
  const wt = ensureWorktree(task);
  const before = git(wt, ['rev-parse', 'HEAD']);
  const r = await runSession(task, 'implementer', wt, await budgetFor(task));
  if (await settleSession(task, 'implementer', r)) return;
  const violations = guardViolations(wt, before, 'implementer');
  const unresolved = unmergedFiles(wt);
  if (unresolved.length) violations.push(`the merge of main still has conflicts in ${unresolved.join(', ')}`);
  if (violations.length) return guardFailed(task, 'implementer', violations);
  if (r.status === 'test_wrong') {
    // The implementer's work so far is kept in a commit, so that test-author's diff is only its own.
    await commitAll(wt, `${task.issue}: work in progress, before test-author's answer`);
    const disputes = (task.disputes ?? 0) + 1;
    const toTestAuthor = `The implementer says a test is wrong:\n\n${r.report}\n\nCheck it against the task. If the implementer is right, fix the test and end with RESULT: DONE. If the test is right, leave it and explain why for the implementer, ending with RESULT: KEEP.`;
    if (disputes > MAX_DISPUTES) {
      // Yoan's answer goes to test-author with the implementer's report, then back to the implementer.
      updateItem(task.issue, { disputes: 0, stage: 'tests-fix', afterDispute: task.stage, message: toTestAuthor });
      await askYoan(task, {
        kind: 'dispute', role: 'test-author',
        what: `test-author и implementer не са съгласни за тест, вече ${MAX_DISPUTES} пъти.`,
        todo: 'прочети спора по-долу и пиши тук кой е прав и какво да направят. Предложение: прав е този, който следва "Как проверявам".',
        ifNot: 'задачата стои, нищо не се слива.',
        details: r.report.slice(0, 3000),
      });
      return;
    }
    updateItem(task.issue, { stage: 'tests-fix', afterDispute: task.stage, disputes, guardRetry: undefined, message: toTestAuthor });
    log(`${task.issue}: the implementer calls a test wrong; back to test-author (${disputes}/${MAX_DISPUTES})`);
    return;
  }
  const round = task.round ?? 0;
  await commitAll(wt, task.stage === 'fix' ? `${task.issue}: fix round ${round}` : `${task.issue}: ${task.title}`);
  if (git(wt, ['rev-list', '--count', 'origin/main..HEAD']) === '0') {
    await askYoan(task, {
      kind: 'question', role: 'implementer', what: 'implementer свърши без нито една промяна, така че няма PR.',
      todo: 'прочети отчета по-долу и пиши тук какво да направи. Предложение: уточни "Какво" в задачата.', ifNot: 'задачата стои.',
      details: r.report.slice(0, 3000),
    });
    return;
  }
  updateItem(task.issue, { stage: 'publish', message: undefined, guardRetry: undefined, ...(task.stage === 'code' ? { report: r.report } : {}) });
  await publish(readQueue().find((t) => t.issue === task.issue));
}

// Push and PR, apart from the session: when GitHub fails here, the runner tries again without a new session.
async function publish(task) {
  const wt = ensureWorktree(task);
  const sha = await push(task, wt);
  const pr = task.pr ?? (await existingPr(task)) ?? (await openPr(task, task.report));
  updateItem(task.issue, {
    stage: 'review', pr, pushedSha: sha, reviewSince: new Date().toISOString(), reviewReruns: undefined, rerunAt: undefined,
    // No new commit since the last review (the implementer changed nothing after an answer or a finding): the review
    // job runs again on the same head, with Yoan's answer in the PR description.
    needsReviewRerun: task.pr && sha === task.pushedSha ? true : undefined,
  });
  log(`${task.issue}: pushed ${sha.slice(0, 10)}; the reviewer reads ${pr}`);
}

async function existingPr(task) {
  const slug = repoSlug(repoDir(task));
  const open = await gh(['pr', 'list', '--repo', slug, '--head', task.branch, '--state', 'open', '--json', 'url'], { json: true, cwd: repoDir(task) });
  return open[0]?.url ?? null;
}

// The PR's description is the task itself (the reviewer's brief) and the implementer's summary.
async function openPr(task, report) {
  const file = path.join(os.tmpdir(), `invoicely-pr-${task.issue}.md`);
  const text = fs.readFileSync(task.brief, 'utf8').trim();
  const head = [
    '## Задачата', '', text, '',
    '## Какво е направено', '', report || '(няма резюме)', '',
    `## Тестове (test-author)`, '', testsLine(task), '',
  ].join('\n');
  const tail = `Linear: ${task.issue}`;
  // The documents the agents got, for the reviewer in CI (INV-71); within GitHub's limit for the whole description.
  const docs = readJson(documentsFile(task), null) ?? (await readTaskDocuments(task, text)).docs;
  const section = prDocumentsSection(docs, PR_BODY_LIMIT - head.length - tail.length - 4);
  const body = [head, ...(section ? [section, ''] : []), tail].join('\n');
  fs.writeFileSync(file, body);
  try {
    const slug = repoSlug(repoDir(task));
    const out = await gh(['pr', 'create', '--repo', slug, '--base', 'main', '--head', task.branch, '--title', `${task.issue}: ${task.title}`, '--body-file', file], { asBot: true, cwd: repoDir(task) });
    const url = /https:\/\/github\.com\/\S+\/pull\/\d+/.exec(out)?.[0];
    if (!url) throw new Error(`gh pr create gave no PR URL: ${out.slice(0, 200)}`);
    return url;
  } finally {
    fs.rmSync(file, { force: true });
  }
}

// --- The review, CI and the merge ---

async function rerunReview(task, check) {
  const job = /\/job\/(\d+)/.exec(check?.link ?? '')?.[1];
  if (!job) return false;
  const slug = repoSlug(repoDir(task));
  try {
    await gh(['api', '-X', 'POST', `repos/${slug}/actions/jobs/${job}/rerun`], { asBot: true });
  } catch {
    // The App may not rerun jobs (actions: read): Yoan's gh does it.
    await gh(['api', '-X', 'POST', `repos/${slug}/actions/jobs/${job}/rerun`]);
  }
  return true;
}

async function fixRound(task, { review = null, failed = [], conflict = null }) {
  const round = (task.round ?? 0) + 1;
  if (round > MAX_ROUNDS) {
    await askYoan(task, {
      kind: 'rounds', role: 'implementer',
      what: `ревюто или CI на ${task.pr} не минават след ${MAX_ROUNDS} кръга поправки.`,
      todo: 'прочети последните забележки по-долу и пиши тук как да продължи implementer. Предложение: кажи коя забележка е по-важна или "поемам", ако го поемаш ти.',
      ifNot: 'PR-ът остава отворен и не се слива.',
      details: [review, failed.length ? `Червени проверки: ${failed.join(', ')}` : '', conflict ? `Конфликт с main в: ${conflict.join(', ')}` : ''].filter(Boolean).join('\n\n').slice(0, 3000),
    });
    return;
  }
  updateItem(task.issue, { stage: 'fix', round, message: fixMessage({ round, maxRounds: MAX_ROUNDS, review, failed, conflict }), reviewReruns: undefined, waitUntil: undefined, limitWaits: undefined });
  log(`${task.issue}: fix round ${round}${review ? ' (review)' : ''}${failed.length ? ` (${failed.join(', ')})` : ''}${conflict ? ' (conflict with main)' : ''}`);
}

// main moved on and the PR conflicts with it: the runner merges main into the copy. A clean merge is pushed; otherwise
// the merge stays open with git's conflict markers and the implementer resolves them in a fix round.
async function mergeMain(task) {
  const wt = ensureWorktree(task);
  const env = await botEnv();
  git(wt, ['fetch', '-q', 'origin'], env);
  try {
    git(wt, [...NO_HOOKS, 'merge', '-q', '--no-edit', 'origin/main'], env);
  } catch {
    const conflicts = unmergedFiles(wt);
    if (conflicts.length) return { conflicts };
    throw new Error('git merge origin/main failed without conflicts');
  }
  const sha = await push(task, wt);
  updateItem(task.issue, { pushedSha: sha, reviewSince: new Date().toISOString() });
  return { merged: true };
}

function recordReview(task, review) {
  if (readLedger().some((e) => e.status === 'review' && e.reviewId === review.id)) return;
  ledger({
    issue: task.issue, status: 'review', reviewId: review.id, round: task.round ?? 0, verdict: review.marker.verdict,
    sha: review.marker.sha, costUsd: review.marker.costUsd, pr: task.pr, findings: findingLines(reviewText(review.body)).slice(0, 10),
  });
}

// One look at every PR that waits for its review. Needs no session, so it runs between sessions. A PR on which GitHub
// or git keeps failing is not left to wait forever: after a few rounds Yoan is told.
async function processReviews() {
  for (const task of readQueue().filter((t) => t.stage === 'review')) {
    try {
      await processReview(task);
      if (task.reviewErrors) updateItem(task.issue, { reviewErrors: undefined });
    } catch (error) {
      const errors = (task.reviewErrors ?? 0) + 1;
      log(`${task.issue}: review step failed (${errors}/${MAX_REVIEW_ERRORS}): ${error.message.split('\n')[0]}`);
      if (errors < MAX_REVIEW_ERRORS) {
        updateItem(task.issue, { reviewErrors: errors });
        continue;
      }
      updateItem(task.issue, { reviewErrors: undefined });
      await askYoan(task, {
        kind: 'review_stuck', role: 'reviewer', what: `runner-ът не може да продължи с ${task.pr}: GitHub или git отказват ${MAX_REVIEW_ERRORS} пъти подред.`,
        todo: 'виж грешката по-долу и пиши тук "опитай пак", когато е наред. Предложение: "опитай пак".', ifNot: 'PR-ът стои и не се слива.',
        details: error.message.slice(0, 1500),
      });
    }
  }
}

async function processReview(task) {
  const cwd = repoDir(task);
  const slug = repoSlug(cwd);
  const view = await gh(['pr', 'view', task.pr, '--json', 'number,state,headRefOid,mergeable'], { json: true, cwd });
  let checks = null;
  try {
    checks = await gh(['pr', 'checks', task.pr, '--json', 'name,bucket,link'], { json: true, cwd });
  } catch {
    // no checks reported yet, or GitHub did not answer: the decision waits
  }
  const reviews = await gh(['api', `repos/${slug}/pulls/${view.number}/reviews?per_page=100`], { json: true, cwd });
  const d = reviewDecision({ task, view, checks, reviews, limitUntil, timeoutMinutes: REVIEW_TIMEOUT_MINUTES, maxLimitWaits: MAX_LIMIT_WAITS });
  if (d.reviewEntry) recordReview(task, d.reviewEntry);
  const reviewCheck = checks?.find((c) => isReviewCheck(c.name));
  switch (d.action) {
    case 'wait':
      return undefined;
    case 'finish':
      return finish(task);
    case 'closed':
      ledger({ issue: task.issue, status: 'closed', pr: task.pr });
      updateItem(task.issue, null);
      await comment(task.issue, `**Спряно.** PR-ът ${task.pr} е затворен, затова runner-ът извади задачата от опашката. Върни я в Ready, за да започне отначало на нов клон.`);
      return undefined;
    case 'merge-main': {
      const merged = await mergeMain(task);
      if (merged.merged) log(`${task.issue}: merged main into the PR itself; the reviewer looks again`);
      else await fixRound(task, { conflict: merged.conflicts });
      return undefined;
    }
    case 'rerun':
      if (!(await rerunReview(task, reviewCheck))) {
        return askYoan(task, {
          kind: 'review_stuck', role: 'reviewer', what: `ревюто на ${task.pr} трябва да се пусне пак, а runner-ът не намира job-а.`,
          todo: 'пусни job-а review пак в PR-а или пиши тук "опитай пак". Предложение: "опитай пак".', ifNot: 'PR-ът стои и не се слива.',
        });
      }
      updateItem(task.issue, { ...d.set, rerunAt: new Date().toISOString(), reviewSince: new Date().toISOString() });
      log(`${task.issue}: the review job runs again`);
      return undefined;
    case 'limit-wait':
      updateItem(task.issue, { waitUntil: d.until, limitWaits: (task.limitWaits ?? 0) + 1 });
      log(`${task.issue}: the review waits for the Max limit; again at ${d.until}`);
      return undefined;
    case 'question':
      return askYoan(task, {
        kind: 'review_question', role: 'reviewer', what: `отговор на въпроса на reviewer-а за ${task.pr}.`,
        todo: 'прочети въпроса и предложения отговор по-долу и отговори тук.', ifNot: 'PR-ът стои и не се слива.', details: d.text.slice(0, 3000),
      });
    case 'fix':
      return fixRound(task, { review: d.review ?? null, failed: d.failed ?? [] });
    case 'merge':
      // Only the head the reviewer passed: a push after the review would make GitHub refuse the merge.
      await gh(['pr', 'merge', task.pr, '--squash', '--match-head-commit', d.sha], { asBot: true, cwd });
      log(`${task.issue}: merged ${task.pr}`);
      return finish(task);
    default:
      return askYoan(task, {
        kind: 'review_stuck', role: 'reviewer', what: `${task.pr}: ${d.why}.`,
        todo: 'виж PR-а и пиши тук "опитай пак", когато е наред. Предложение: "опитай пак".', ifNot: 'PR-ът стои и не се слива.',
      });
  }
}

// After the merge: the summary in the task, Done or "Чака Йоан" for the UI check, and the copy goes.
async function finish(task) {
  ledger({ issue: task.issue, status: 'merged', pr: task.pr, branch: task.branch });
  updateItem(task.issue, null);
  const entries = readLedger();
  const reviews = entries.filter((e) => e.issue === task.issue && e.status === 'review' && (!task.since || Date.parse(e.ended) >= Date.parse(task.since)));
  const summary = summaryBody({
    pr: task.pr, report: task.report, reviews, cost: taskCost(entries, task.issue, task.since),
    minutes: task.since ? minutesBetween(new Date(task.since), new Date()) : null,
  });
  const want = task.ui ? 'Чака Йоан' : 'Done';
  if (task.ui) {
    const who = await yoanMention();
    await comment(task.issue, `${summary}\n\n---\n\n${who ? `${who} ` : ''}**Чака:** твоята проверка на UI.\n\n**Какво да направиш:** мини стъпките от "Как проверявам" и премести задачата в Done. Ако нещо не е наред, опиши го в нова задача.\n\n**Ако не отговориш:** кодът е в main, задачата остава тук.`);
    ledger({ issue: task.issue, status: 'needs_answer', kind: 'ui_check' });
  } else {
    await comment(task.issue, summary);
  }
  // Linear's own GitHub rules may move the task when they see the merge, within seconds: the runner's status comes after.
  await sleep(30 * 1000);
  await setState(task.issue, want);
  await cleanup({ repo: repoDir(task), only: task.branch });
}

// --- Money ---

async function budgetFor(task) {
  const cap = task.budgetUsd ?? config.budgetUsd;
  const spent = taskCost(readLedger(), task.issue, task.since).sessions;
  const left = Math.floor((cap - spent) * 100) / 100;
  if (left >= 1) return left;
  await askYoan(task, {
    kind: 'over_budget', role: null,
    what: `задачата стигна тавана си: сесиите ѝ са похарчили $${spent.toFixed(2)} от $${cap} (цена по API; на Max е дял от лимита).`,
    todo: `пиши тук "продължи", за да получи още $${config.budgetUsd}, или "спри". Предложение: "продължи", ако PR-ът е близо до готов.`,
    ifNot: 'задачата стои и не харчи нищо.',
  });
  throw new OverBudget();
}

class OverBudget extends Error {}

// --- Linear ---

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

// As the "Invoicely Agents" app when its client credentials are in .env (INV-30), so Yoan gets the notifications.
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

async function setState(issueKey, stateName) {
  const issue = (await linear('query($id:String!){issue(id:$id){id team{states{nodes{id name}}}}}', { id: issueKey }))?.issue;
  const state = issue?.team?.states?.nodes?.find((s) => s.name === stateName);
  if (state) await linear('mutation($id:String!,$s:String!){issueUpdate(id:$id,input:{stateId:$s}){success}}', { id: issue.id, s: state.id });
}

async function comment(issueKey, body) {
  try {
    const issue = (await linear('query($id:String!){issue(id:$id){id}}', { id: issueKey }))?.issue;
    if (issue) await linear('mutation($id:String!,$b:String!){commentCreate(input:{issueId:$id,body:$b}){success}}', { id: issue.id, b: body });
  } catch (error) {
    log(`linear: ${error.message.slice(0, 300)}`);
  }
}

// A question in three parts that mentions Yoan (a notification on his phone) and moves the task to "Чака Йоан".
// The task leaves the queue; the ledger keeps it as it was, so his answer puts it back where it stopped.
async function askYoan(task, { kind, role, what, todo, ifNot, details = '' }) {
  // The queue item is fresher than the copy a step holds (session ids are written there as they start).
  const snapshot = { ...task, ...readQueue().find((t) => t.issue === task.issue) };
  delete snapshot.waitUntil;
  ledger({ issue: task.issue, status: 'needs_answer', kind, role, pr: task.pr ?? null, task: snapshot });
  updateItem(task.issue, null);
  log(`${task.issue}: waits for Yoan (${kind})`);
  const who = await yoanMention();
  const body = `${who ? `${who} ` : ''}**Чака:** ${what}\n\n**Какво да направиш:** ${todo}\n\n**Ако не отговориш:** ${ifNot}${details ? `\n\n---\n\n${details}` : ''}`;
  try {
    await setState(task.issue, 'Чака Йоан');
  } catch (error) {
    log(`linear: ${error.message.slice(0, 300)}`);
  }
  await comment(task.issue, body);
}

// A task without criteria never entered the queue, so the ledger keeps no step for it: Yoan's fix is to add the
// criteria and move it back to Ready, where it starts as a new task.
async function askNoCriteria(issue, what) {
  ledger({ issue, status: 'needs_answer', kind: 'no_criteria' });
  log(`${issue}: no acceptance criteria; waits for Yoan`);
  const who = await yoanMention();
  try {
    await setState(issue, 'Чака Йоан');
  } catch (error) {
    log(`linear: ${error.message.slice(0, 300)}`);
  }
  await comment(issue, `${who ? `${who} ` : ''}**Чака:** ${what}\n\n**Какво да направиш:** добави раздел "Как проверявам" с поне една проверка и върни задачата в Ready.\n\n**Ако не отговориш:** задачата стои, сесия не се пуска.`);
}

// A new start never reuses a branch or a copy of an earlier run (a closed PR, a task started over): -2, -3, ...
function freeBranch(task) {
  const repo = config.repos[task.repo];
  const taken = (branch) => fs.existsSync(path.join(repo, '.claude', 'worktrees', branch))
    || git(repo, ['branch', '--list', branch]) !== ''
    || git(repo, ['ls-remote', '--heads', 'origin', branch]) !== '';
  let branch = task.branch;
  for (let n = 2; taken(branch); n += 1) branch = `${task.branch}-${n}`;
  return branch;
}

const ISSUE_FIELDS = 'id identifier title description branchName state{name type} labels{nodes{name}} inverseRelations{nodes{type issue{identifier state{type}}}}';

// Tasks Yoan moved to Ready go into the queue; a task blocked by an open one stays in Ready until it is free.
async function takeReady() {
  const data = await linear(`query($team:String!){issues(first:50,filter:{team:{key:{eq:$team}},state:{name:{eq:"Ready"}}}){nodes{${ISSUE_FIELDS}}}}`, { team: config.linearTeam });
  if (!data) return;
  const known = new Set([...readQueue().map((t) => t.issue), ...activeLocks()]);
  const { add, wait } = planFromReady(data.issues.nodes, known);
  const entries = readLedger();
  for (const { text, ...task } of add) {
    if (!config.repos[task.repo] || !fs.existsSync(config.repos[task.repo])) {
      logOnce(`repo:${task.issue}`, `linear: ${task.issue} is for ${task.repo}, which is not on this Mac`);
      continue;
    }
    // A task Yoan stopped (Backlog, Canceled) and put back in Ready goes on where it stopped, if its copy is still on
    // disk and its PR, if any, is open (INV-73); otherwise it starts over below, as a new task.
    const last = [...entries].reverse().find((e) => e.issue === task.issue && ['stopped', 'merged', 'closed'].includes(e.status));
    let plan = null;
    if (last?.status === 'stopped' && last.task) {
      let prState = null;
      if (last.task.pr) {
        try {
          prState = (await gh(['pr', 'view', last.task.pr, '--json', 'state'], { json: true, cwd: repoDir(last.task) })).state;
        } catch (error) {
          logOnce(`pr:${task.issue}`, `linear: ${task.issue} stays in Ready, its PR state is unknown: ${error.message.split('\n')[0]}`);
          continue;
        }
      }
      plan = stoppedTaskPlan({ stopped: last.task, copyExists: fs.existsSync(copyPath(last.task)), prState });
    }
    if (plan === 'resume') {
      writeQueue([...readQueue(), { ...last.task, ...(['tests', 'tests-fix', 'code', 'fix'].includes(last.task.stage) ? { message: last.task.message ?? CONTINUE } : {}) }]);
      await setState(task.issue, last.task.stage === 'review' ? 'In Review' : 'In Progress');
      log(`linear: ${task.issue} goes on at ${last.task.stage}`);
      continue;
    }
    if (plan === 'restart') log(`linear: ${task.issue} starts over: its copy is gone or its PR is not open`);
    // No acceptance criteria, no session (INV-71): the task goes to Yoan and starts over when he puts it back in Ready.
    const gate = sessionGate({ text });
    if (gate.action === 'ask') {
      await askNoCriteria(task.issue, gate.what);
      continue;
    }
    const brief = path.join(STATE, 'briefs', `${task.issue}.md`);
    fs.writeFileSync(brief, text);
    const branch = freeBranch(task);
    writeQueue([...readQueue(), newQueueEntry(task, { branch, brief, since: new Date().toISOString() })]);
    await setState(task.issue, 'In Progress');
    log(`linear: queued ${task.issue} (${task.repo}${task.ui ? ', UI' : ''}) on ${branch}`);
  }
  for (const { issue, why } of wait) logOnce(`wait:${issue}:${why}`, `linear: ${issue} stays in Ready (${why})`);
}

// Yoan's answer in Linear puts the task back where it stopped.
async function takeAnswers() {
  const data = await linear(
    'query($team:String!){issues(first:50,filter:{team:{key:{eq:$team}},state:{name:{eq:"Чака Йоан"}}}){nodes{identifier comments(last:30){nodes{body createdAt user{id}}}}}}',
    { team: config.linearTeam },
  );
  if (!data) return;
  const yoanId = (await linear('{viewer{id}}', {}, { asYoan: true }))?.viewer?.id;
  const entries = readLedger();
  for (const issue of data.issues.nodes) {
    if (readQueue().some((t) => t.issue === issue.identifier)) continue;
    const last = [...entries].reverse().find((e) => e.issue === issue.identifier && ['needs_answer', 'answered', 'merged', 'stopped'].includes(e.status));
    if (last?.status !== 'needs_answer' || !last.task || last.kind === 'ui_check') continue;
    const answer = answerAfter(issue.comments.nodes, yoanId, last.ended);
    if (!answer) continue;
    ledger({ issue: issue.identifier, status: 'answered', kind: last.kind });
    const item = resumeAfterAnswer(last, answer);
    if (!item) {
      ledger({ issue: issue.identifier, status: 'stopped', why: 'Yoan took it over or stopped it' });
      log(`linear: ${issue.identifier}: Yoan takes it over or stops it`);
      continue;
    }
    if (last.kind === 'review_question') await addAnswerToPr(item, last, answer);
    writeQueue([item, ...readQueue()]);
    await setState(issue.identifier, item.stage === 'review' ? 'In Review' : 'In Progress');
    log(`linear: ${issue.identifier} goes on with Yoan's answer (${last.kind})`);
  }
}

// Where a task goes on after Yoan's answer, by what it waited for; null when he stops it or takes it over.
function resumeAfterAnswer(last, answer) {
  const task = { ...last.task, guardRetry: undefined };
  const said = `Yoan answered in Linear:\n\n${answer}`;
  if (/^(поемам|спри)[\s.!]*$/iu.test(answer.trim())) return null;
  switch (last.kind) {
    case 'over_budget': {
      const decision = budgetAnswer(answer);
      if (decision === 'stop') return null;
      return { ...task, budgetUsd: (task.budgetUsd ?? config.budgetUsd) + config.budgetUsd, ...(decision === 'continue-with-note' ? { message: `${said}\n\n${task.message ?? CONTINUE}` } : {}) };
    }
    case 'review_question':
      return { ...task, stage: 'fix', message: `The reviewer asked a question about your PR and ${said}\n\nChange the code if the answer asks for it, then end with what you changed (in Bulgarian, at most 5 lines) and RESULT: DONE. If nothing has to change, end with RESULT: DONE as well.` };
    case 'rounds':
      return { ...task, stage: 'fix', round: 0, message: `${said}\n\nFix the PR with this answer, under the same rules, and end with what you changed (in Bulgarian, at most 5 lines) and RESULT: DONE.` };
    case 'dispute':
      return { ...task, stage: 'tests-fix', message: `${task.message ?? ''}\n\n${said}\n\nThis settles the disagreement about the test. Change the test if the answer says so (RESULT: DONE), or keep it and say so for the implementer (RESULT: KEEP).`.trim() };
    case 'review_stuck':
      return { ...task, stage: 'review', reviewReruns: undefined, reviewSince: new Date().toISOString() };
    default:
      return { ...task, message: `${said}\n\nContinue with this answer and finish the same instructions, ending with the RESULT line.` };
  }
}

// The reviewer reads the PR's description as its brief, so Yoan's answer goes there too.
async function addAnswerToPr(item, last, answer) {
  try {
    const cwd = repoDir(item);
    const body = await gh(['pr', 'view', item.pr, '--json', 'body', '-q', '.body'], { cwd });
    const file = path.join(os.tmpdir(), `invoicely-pr-${item.issue}-answer.md`);
    fs.writeFileSync(file, `${body}\n\n## Отговор на Йоан на въпроса на reviewer-а\n\n${answer}\n`);
    try {
      await gh(['pr', 'edit', item.pr, '--body-file', file], { asBot: true, cwd });
    } finally {
      fs.rmSync(file, { force: true });
    }
  } catch (error) {
    log(`${item.issue}: the answer did not reach the PR: ${error.message.split('\n')[0]}`);
  }
}

// One writer for the status of the runner's tasks (INV-50): the queue says where a task is and Linear shows it.
// Backlog or Canceled is Yoan's "stop": the task leaves the queue.
async function reconcileStatuses() {
  for (const task of readQueue()) {
    const state = (await linear('query($id:String!){issue(id:$id){state{name type}}}', { id: task.issue }))?.issue?.state;
    if (!state) continue;
    const { action, want, note } = statusAction(task, state);
    if (action === 'remove') {
      updateItem(task.issue, null);
      ledger({ issue: task.issue, branch: task.branch, status: 'stopped', state: state.name, task: { ...task, waitUntil: undefined } });
      await comment(task.issue, `**Спряно.** Задачата е в ${state.name}, затова runner-ът я извади от опашката. Върни я в Ready, за да продължи оттам, докъдето стигна.`);
      log(`linear: ${task.issue} is in ${state.name}, taken out of the queue`);
    } else if (action === 'set') {
      await setState(task.issue, want);
      if (note) await comment(task.issue, `**Вече не чака теб.** Задачата е пак в опашката на runner-а (${want}).`);
    }
  }
}

let lastSync = 0;
async function syncFromLinear() {
  if (Date.now() - lastSync < 5 * 60 * 1000) return;
  lastSync = Date.now();
  try {
    await takeAnswers();
    await takeReady();
    await reconcileStatuses();
  } catch (error) {
    log(`linear sync: ${error.message.slice(0, 300)}`);
  }
}

// --- Clean-up (INV-48): copies and branches of finished tasks go; see janitor.mjs for the rules ---

async function cleanupFacts(repo, { fetch }) {
  if (fetch) git(repo, ['fetch', '-q', '--prune', 'origin']);
  const holder = path.join(repo, '.claude', 'worktrees');
  const copies = parseWorktrees(git(repo, ['worktree', 'list', '--porcelain']))
    .filter((w) => path.dirname(w.path) === holder)
    .map((w) => {
      let dirty = true;
      try {
        dirty = execFileSync('git', ['status', '--porcelain'], { cwd: w.path, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' }, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim() !== '';
      } catch {
        // a copy git cannot read is treated as holding work
      }
      let ageDays = 0;
      try {
        const st = fs.statSync(w.path);
        ageDays = (Date.now() - (st.birthtimeMs || st.ctimeMs)) / 86400000;
      } catch {
        // gone meanwhile: treated as new
      }
      return { ...w, dirty, ageDays };
    });
  const refs = (prefix) => git(repo, ['for-each-ref', prefix, '--format=%(refname:short) %(objectname)'])
    .split('\n').filter(Boolean).map((line) => { const [name, head] = line.split(' '); return { name, head }; });
  const remoteBranches = refs('refs/remotes/origin').filter((b) => b.name.startsWith('origin/') && b.name !== 'origin/HEAD')
    .map((b) => ({ name: b.name.slice('origin/'.length), head: b.head }));
  const prs = await gh(['pr', 'list', '--state', 'all', '--limit', '500', '--json', 'number,headRefName,headRefOid,baseRefName,state'], { json: true, cwd: repo });
  // The plugin's copy, the copy this runner runs from, and the main checkouts are never touched.
  const protectedPaths = [config.plugin, path.dirname(HERE), ...Object.values(config.repos)];
  return { copies, prs, localBranches: refs('refs/heads'), remoteBranches, protectedPaths, queue: readQueue().filter((t) => repoDir(t) === repo) };
}

async function cleanup({ repo, only = null, dryRun = false }) {
  let facts;
  try {
    facts = await cleanupFacts(repo, { fetch: !dryRun });
  } catch (error) {
    logOnce(`cleanup:${error.message.split('\n')[0]}`, `cleanup: ${error.message.split('\n')[0]}`);
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
    if (tried(c.path, () => git(repo, ['worktree', 'remove', c.path]))) { done.copies += 1; log(`cleanup: removed ${c.path} (${c.why})`); }
  }
  for (const name of plan.deleteLocal) if (tried(name, () => git(repo, ['branch', '-D', name]))) done.local += 1;
  const slug = plan.deleteRemote.length ? repoSlug(repo) : null;
  for (const name of plan.deleteRemote) {
    try {
      await gh(['api', '-X', 'DELETE', `repos/${slug}/git/refs/heads/${name}`], { asBot: true });
      done.remote += 1;
    } catch (error) {
      log(`cleanup: origin/${name}: ${error.message.split('\n')[0]}`);
    }
  }
  if (!only) tried('worktree prune', () => git(repo, ['worktree', 'prune']));
  for (const kept of plan.report) await reportCopyKept(kept);
  if (done.copies + done.local + done.remote > 0) log(`cleanup ${path.basename(repo)}: ${cleanupSummary(plan, done)}`);
  return { plan, done };
}

// A copy whose PR is over but that holds unsaved work stays; Yoan is told once, in the task.
async function reportCopyKept(kept) {
  const stateFile = path.join(STATE, 'cleanup.json');
  const state = readJson(stateFile, {});
  if ((state.told ?? []).includes(kept.path)) return;
  const issue = /^inv-(\d+)/i.exec(kept.branch)?.[1];
  log(`cleanup: kept ${kept.path}: ${kept.why}`);
  if (issue) await comment(`INV-${issue}`, `**Копието остава на диска:** \`${kept.path}\`. ${kept.bg ?? kept.why}. Нищо не се губи; копието се маха, щом работата в него бъде записана или вече не трябва.`);
  state.told = [...(state.told ?? []).slice(-50), kept.path];
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
}

// Once a day, when no session runs: every repo's finished copies and branches, and logs older than 30 days.
async function maybeCleanup() {
  const stateFile = path.join(STATE, 'cleanup.json');
  const today = new Date().toLocaleDateString('sv-SE');
  if (readJson(stateFile, {}).lastRun === today || activeLocks().length > 0) return;
  const texts = [];
  for (const repo of Object.values(config.repos)) {
    if (!fs.existsSync(repo)) continue;
    const result = await cleanup({ repo });
    if (!result) return; // GitHub or git failed: tried again next round
    texts.push(`${path.basename(repo)}: ${cleanupSummary(result.plan, result.done)}`);
  }
  const logsDir = path.join(STATE, 'logs');
  const files = fs.readdirSync(logsDir).map((name) => ({ name, mtimeMs: fs.statSync(path.join(logsDir, name)).mtimeMs }));
  for (const name of oldLogs(files, new Date())) fs.rmSync(path.join(logsDir, name), { force: true });
  const state = readJson(stateFile, {});
  fs.writeFileSync(stateFile, JSON.stringify({ ...state, lastRun: today, summary: { day: today, text: texts.join(' ') } }, null, 2));
}

// Before each round: the main checkout follows origin/main, so that merged changes to the runner and the agents take
// effect. When the runner's own code changed, a runner under launchd exits and launchd starts the new code.
function updateRunnerCode() {
  if (!RUNS_FROM_REPO || !startCommit) return;
  try {
    const branch = git(AGENTS_REPO, ['symbolic-ref', '--short', 'HEAD']);
    const dirty = git(AGENTS_REPO, ['status', '--porcelain', '--untracked-files=no']) !== '';
    if (branch !== 'main' || dirty) {
      logOnce(`repo:${branch}:${dirty}`, `the main checkout is ${dirty ? 'changed' : `on ${branch}`}; it is not updated until it is clean main again`);
      return;
    }
    git(AGENTS_REPO, ['fetch', '-q', 'origin']);
    git(AGENTS_REPO, ['merge', '-q', '--ff-only', 'origin/main']);
    if (git(AGENTS_REPO, ['diff', '--name-only', startCommit, 'HEAD', '--', 'factory/', 'hooks/lib/']) === '') return;
    if (process.env.INVOICELY_SERVICE === '1') {
      log('the runner code changed in main; exiting so that launchd starts the new code');
      process.exit(0);
    }
    logOnce(`code:${git(AGENTS_REPO, ['rev-parse', 'HEAD'])}`, 'the runner code changed in main; restart the runner to use it');
  } catch (error) {
    logOnce(`update:${error.message.split('\n')[0]}`, `update: ${error.message.split('\n')[0]}`);
  }
}

// --- The loop ---

// The Max limit is shared by every session: once one hits it, no new session starts before the reset.
let limitUntil = 0;

async function runStep(task) {
  const unlock = lock(task.issue);
  try {
    if (task.stage === 'tests' || task.stage === 'tests-fix') await stepTests(task);
    else if (task.stage === 'publish') await publish(task);
    else await stepCode(task);
    updateItem(task.issue, { startFailures: undefined });
  } finally {
    unlock();
  }
}

async function runQueue() {
  for (;;) {
    if (fs.existsSync(PAUSED)) {
      logOnce(`paused:${fs.statSync(PAUSED).mtimeMs}`, 'paused: no sessions, merges or clean-up until `factory resume`');
      await sleep(60 * 1000);
      continue;
    }
    updateRunnerCode();
    await syncFromLinear();
    await processReviews();
    await maybeCleanup();
    const queue = readQueue();
    const task = Date.now() < limitUntil ? null : nextRunnable(queue);
    if (!task) {
      await sleep((queue.length ? 2 : 5) * 60 * 1000);
      continue;
    }
    try {
      await runStep(task);
    } catch (error) {
      if (error instanceof OverBudget) continue;
      // A step that could not even start (no network after the Mac wakes, GitHub down) keeps its place and is tried
      // again in 5 minutes; after 6 failed starts in a row Yoan is asked.
      const failures = (task.startFailures ?? 0) + 1;
      log(`${task.issue}: could not run (${failures}/6): ${error.message.split('\n')[0]}`);
      if (failures < 6) {
        updateItem(task.issue, { startFailures: failures });
        await sleep(5 * 60 * 1000);
        continue;
      }
      updateItem(task.issue, { startFailures: undefined });
      await askYoan(task, {
        kind: 'error', role: null, what: 'runner-ът не може да пусне стъпката 6 пъти подред.',
        todo: 'виж грешката по-долу и пиши тук "опитай пак", когато е наред. Предложение: "опитай пак".', ifNot: 'задачата стои.',
        details: error.message.slice(0, 1500),
      });
    }
  }
}

// --- The service and the CLI ---

// The runner as a launchd service: starts at login, starts again when it stops (a crash, or new code in main).
const LABEL = 'com.invoicely.runner';
function service(sub) {
  const plistFile = path.join(HOME, 'Library', 'LaunchAgents', `${LABEL}.plist`);
  const domain = `gui/${process.getuid()}`;
  if (sub === 'install') {
    if (!RUNS_FROM_REPO) return console.log(`install the service from the main checkout: node ${path.join(AGENTS_REPO, 'factory', 'factory.mjs')} service install`);
    const nodeBin = config.nodeBin || path.dirname(process.execPath);
    fs.mkdirSync(path.dirname(plistFile), { recursive: true });
    fs.writeFileSync(plistFile, servicePlist({
      label: LABEL, node: path.join(nodeBin, 'node'), script: path.join(AGENTS_REPO, 'factory', 'factory.mjs'), cwd: AGENTS_REPO,
      logFile: path.join(STATE, 'logs', 'runner.log'), pathEnv: `${nodeBin}:${path.join(HOME, '.local', 'bin')}:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin`, home: HOME,
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
    return console.log(`${LABEL} is not loaded (factory service install, or launchctl bootstrap gui/$(id -u) ${plistFile})`);
  }
}

async function main() {
  // An agent must not drive the runner (its queue, Linear as the app, the service): the runner marks every agent
  // session and refuses to run inside one.
  if (process.env.INVOICELY_AGENT_SESSION === '1') {
    process.stderr.write('factory: not available inside an agent session\n');
    process.exit(1);
  }
  const [command, sub, ...rest] = process.argv.slice(2);
  if (command === 'queue' && sub === 'run') return runQueue();
  if (command === 'pause') {
    fs.writeFileSync(PAUSED, `${new Date().toISOString()}\n`);
    console.log('paused: the runner finishes the session that runs now and then starts nothing until `factory resume`');
    if (sub === '--wait' || rest.includes('--wait')) {
      while (activeLocks().length > 0) {
        console.log(`waiting for ${activeLocks().join(', ')} to finish`);
        await sleep(60 * 1000);
      }
      console.log('no session runs');
    }
    return undefined;
  }
  if (command === 'resume') {
    fs.rmSync(PAUSED, { force: true });
    return console.log('resumed');
  }
  if (command === 'requeue') {
    const last = [...readLedger()].reverse().find((e) => e.issue === sub && e.task);
    if (!sub || !last) return console.log(`usage: factory requeue <INV-xx> [--message <text>]; ${sub ?? '?'} has no saved step in the ledger`);
    if (readQueue().some((t) => t.issue === sub)) return console.log(`${sub} is already in the queue`);
    const at = rest.indexOf('--message');
    const item = resumeAfterAnswer(last, at >= 0 ? rest[at + 1] : 'опитай пак') ?? last.task;
    writeQueue([item, ...readQueue()]);
    return log(`requeued ${sub} at ${item.stage}`);
  }
  if (command === 'service') return service(sub);
  // Claude in an interactive session writes in Linear as the app, not as Yoan (INV-50).
  if (command === 'linear') {
    const [issueKey, ...more] = rest;
    const at = more.indexOf('--body-file');
    const body = at >= 0 ? fs.readFileSync(more[at + 1], 'utf8').trim() : null;
    if (!issueKey || !['ask', 'comment', 'state'].includes(sub)) return console.log('usage: factory linear ask|comment <INV-xx> --body-file <file> | factory linear state <INV-xx> <state>');
    if (sub === 'state') {
      await setState(issueKey, more.join(' '));
      return console.log(`${issueKey}: ${more.join(' ')}`);
    }
    if (!body) return console.log('--body-file <file> is needed');
    if (sub === 'ask' && readQueue().some((t) => t.issue === issueKey)) {
      return console.log(`${issueKey} is in the runner's queue, so its status is the runner's: write a note with \`factory linear comment\``);
    }
    if (sub === 'ask') {
      const who = await yoanMention();
      await setState(issueKey, 'Чака Йоан');
      await comment(issueKey, `${who ? `${who} ` : ''}${body}`);
    } else {
      await comment(issueKey, body);
    }
    return console.log(`${issueKey}: ${sub} posted as the app`);
  }
  if (command === 'clean') {
    const dryRun = sub === '--dry-run' || rest.includes('--dry-run');
    for (const repo of Object.values(config.repos).filter((r) => fs.existsSync(r))) {
      const result = await cleanup({ repo, dryRun });
      if (!result) continue;
      const { plan } = result;
      for (const c of plan.removeCopies) console.log(`${dryRun ? 'would remove' : 'removed'} copy ${c.path} (${c.why})`);
      for (const c of plan.keepCopies) console.log(`keep copy ${c.path}: ${c.why}`);
      if (plan.deleteLocal.length) console.log(`${dryRun ? 'would delete' : 'deleted'} local branches in ${path.basename(repo)}: ${plan.deleteLocal.join(', ')}`);
      if (plan.deleteRemote.length) console.log(`${dryRun ? 'would delete' : 'deleted'} branches on GitHub in ${path.basename(repo)}: ${plan.deleteRemote.join(', ')}`);
    }
    return undefined;
  }
  if (command === 'status') {
    const entries = readLedger();
    console.log(fs.existsSync(PAUSED) ? 'paused' : 'running (if the service is loaded: factory service status)');
    console.log('queue:');
    for (const t of readQueue()) {
      const cost = taskCost(entries, t.issue, t.since);
      console.log(`  ${t.issue} ${t.repo} ${t.stage}${t.round ? ` round ${t.round}` : ''}${t.waitUntil ? ` waits until ${t.waitUntil}` : ''} $${cost.total.toFixed(2)} ${t.pr ?? ''}`);
    }
    console.log('locks:', activeLocks().join(', ') || 'none');
    const app = appSettings(STATE);
    console.log('github:', app ? `${app.slug}[bot]` : 'Yoan (no GitHub App in config.json)');
    const costs = entryCosts(entries);
    console.log('last runs:');
    entries.forEach((r, i) => {
      if (i < entries.length - 10) return;
      console.log(`  ${r.ended} ${r.issue} ${r.role ?? ''} ${r.status}${r.verdict ? ` ${r.verdict}` : ''}${r.minutes == null ? '' : ` ${r.minutes}min`} $${costs[i].toFixed(2)} ${r.pr ?? ''}`);
    });
    return undefined;
  }
  console.log('usage: factory queue run | factory status | factory pause [--wait] | factory resume | factory requeue <INV-xx> [--message <text>] | factory clean [--dry-run] | factory linear ask|comment|state ... | factory service install|uninstall|status');
  return undefined;
}

main().catch((error) => {
  log(`error: ${error.message}`);
  process.exit(1);
});
