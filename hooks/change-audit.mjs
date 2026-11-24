#!/usr/bin/env node
// SubagentStart and SubagentStop hooks: the role guard for files a subagent changes
// through Bash (sed -i, >, cp, rm), which the PreToolUse guard on Write and Edit cannot see.
// "start" records the changed files in the working copy and their content; "stop" compares,
// checks every file the subagent touched against policies/role-guard.yaml, and does not let
// the subagent finish while a touched file is outside its paths.
// Limit: two subagents working at the same time in one working copy cannot be told apart,
// so agents that write code run in separate worktrees.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bareAgentName, decideWrite, loadPolicy, relativeToProject } from './lib/policy.mjs';

const mode = process.argv[2];
const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT || path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const policyFile = process.env.INVOICELY_ROLE_GUARD_POLICY || path.join(pluginRoot, 'policies', 'role-guard.yaml');
const stateDir = process.env.INVOICELY_AUDIT_DIR || path.join(tmpdir(), 'invoicely-change-audit');

let input;
try {
  input = JSON.parse(readFileSync(0, 'utf8'));
} catch {
  process.exit(0);
}
if (!input.agent_type || !input.agent_id) process.exit(0);

const cwd = input.cwd || process.cwd();
const stateFile = path.join(stateDir, `${input.session_id ?? 'session'}-${input.agent_id}.json`.replace(/[^A-Za-z0-9._-]/g, '_'));

function git(dir, args) {
  return execFileSync('git', args, { cwd: dir, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 }).toString();
}

// Changed files (tracked and untracked) with a hash of their content, or "deleted".
function snapshot(dir) {
  let top;
  try {
    top = git(dir, ['rev-parse', '--show-toplevel']).trim();
  } catch {
    return null;
  }
  const entries = git(top, ['status', '--porcelain=v1', '-z', '--untracked-files=all']).split('\0').filter(Boolean);
  const files = {};
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    const code = entry.slice(0, 2);
    const file = entry.slice(3);
    if (code[0] === 'R' || code[0] === 'C') i += 1;
    const full = path.join(top, file);
    files[file] = existsSync(full) ? git(top, ['hash-object', '--', file]).trim() : 'deleted';
  }
  return { top, files };
}

if (mode === 'start') {
  const snap = snapshot(cwd);
  if (snap) {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(stateFile, JSON.stringify(snap));
  }
  process.exit(0);
}

if (mode !== 'stop') process.exit(0);

const before = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : null;
const after = snapshot(cwd);
if (!after) process.exit(0);
const beforeFiles = before?.files ?? {};
const touched = [...new Set([...Object.keys(beforeFiles), ...Object.keys(after.files)])]
  .filter((file) => beforeFiles[file] !== after.files[file]);

const agent = bareAgentName(input.agent_type);
const projectDir = process.env.CLAUDE_PROJECT_DIR || after.top;
let policy;
let policyError;
try {
  policy = loadPolicy(policyFile);
} catch (error) {
  policyError = error.message;
}

const violations = touched.flatMap((file) => {
  const rel = relativeToProject(projectDir, path.join(after.top, file));
  if (rel.startsWith('../')) return [`${file} (outside the project)`];
  if (policyError) return [`${rel} (policies/role-guard.yaml cannot be read: ${policyError})`];
  const decision = decideWrite(policy, agent, rel);
  return decision.allowed ? [] : [decision.reason];
});

if (violations.length === 0) {
  rmSync(stateFile, { force: true });
  process.exit(0);
}

const reason = `role guard: ${agent} changed files outside its paths: ${violations.join('; ')}. `
  + 'Put these files back as they were (git checkout or git restore for tracked files, delete new ones), '
  + 'then report to the orchestrator which change you need and why.';

if (input.stop_hook_active) {
  // Already sent back once; do not loop. The orchestrator sees the warning.
  rmSync(stateFile, { force: true });
  process.stdout.write(JSON.stringify({ systemMessage: `${reason} The subagent stopped without fixing it.` }));
  process.exit(0);
}

process.stdout.write(JSON.stringify({ decision: 'block', reason }));
process.exit(0);
