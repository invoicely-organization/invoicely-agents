#!/usr/bin/env node
// PreToolUse hook for Bash (INV-48). The task copies (git worktrees) belong to the runner: it creates a copy for a
// task and removes it when the task's PR is merged or closed. Nobody moves, renames or deletes a copy, or a folder
// that holds copies, by hand: on 24.11 moving ~/projects/ia-wt during a session wiped the uncommitted work of INV-31.
// Files inside a copy may be moved and removed as usual.
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function deny(reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: `copy guard: ${reason}. The runner creates and removes task copies; report it instead.`,
    },
  }));
  process.exit(0);
}

let input;
try {
  input = JSON.parse(readFileSync(0, 'utf8'));
} catch {
  process.exit(0);
}
const command = input.tool_input?.command;
if (typeof command !== 'string') process.exit(0);

const home = os.homedir();
// Folders that hold copies outside a repo: the old place of the runner's copies.
const holders = [path.join(home, 'projects', 'ia-wt')];

const expand = (p) => {
  const q = p.replace(/^\$\{?HOME\}?(?=\/|$)/, home);
  return q === '~' ? home : q.startsWith('~/') ? path.join(home, q.slice(2)) : q;
};
const within = (child, parent) => child === parent || child.startsWith(parent + path.sep);

// A copy, a folder of copies, or a folder above one.
function isProtected(target) {
  for (const holder of holders) if (within(holder, target) || path.dirname(target) === holder) return `${target} holds or is a task copy`;
  const parts = target.split(path.sep);
  const at = parts.lastIndexOf('worktrees');
  if (at >= 1 && parts[at - 1] === '.claude' && parts.length <= at + 2) return `${target} is a task copy or the folder of copies`;
  if (path.basename(target) === '.claude' && existsSync(path.join(target, 'worktrees'))) return `${target} holds the task copies`;
  if (existsSync(path.join(target, '.claude', 'worktrees'))) return `${target} holds the task copies in .claude/worktrees`;
  return null;
}

const MOVERS = new Set(['mv', 'rm', 'rmdir', 'unlink', 'trash']);
const unquote = (w) => w.replace(/^['"]|['"]$/g, '');

let cwd = input.cwd || process.cwd();
for (const part of command.split(/&&|\|\||;|\||\n/).map((p) => p.trim()).filter(Boolean)) {
  const words = part.split(/\s+/).map(unquote);
  if (words[0] === 'cd' && words[1]) {
    cwd = path.resolve(cwd, expand(words[1]));
    continue;
  }
  const git = words.indexOf('git');
  const wt = git >= 0 ? words.indexOf('worktree', git + 1) : -1; // also `git -C <repo> worktree remove`
  if (wt > 0 && ['remove', 'move'].includes(words[wt + 1])) deny(`git worktree ${words[wt + 1]} by hand`);
  // `git rm` removes tracked files inside the repo, never the copy itself.
  const at = words.findIndex((w, i) => MOVERS.has(path.basename(w)) && words[i - 1] !== 'git');
  if (at < 0) continue;
  for (const arg of words.slice(at + 1)) {
    if (!arg || arg.startsWith('-')) continue;
    const why = isProtected(path.resolve(cwd, expand(arg)));
    if (why) deny(`${path.basename(words[at])} on ${why}`);
  }
}
process.exit(0);
