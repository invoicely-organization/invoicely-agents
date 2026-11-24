#!/usr/bin/env node
// PreToolUse hook for Bash, for every session and every agent.
// Blocks what only Yoan does: pushing to main, force pushing, skipping git hooks,
// merging or approving PRs, and changing branch protection.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

function deny(reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: `main guard: ${reason}. Only Yoan does this; report it instead.`,
    },
  }));
  process.exit(0);
}

let input;
try {
  input = JSON.parse(readFileSync(0, 'utf8'));
} catch {
  deny('the hook input could not be read');
}

const command = input.tool_input?.command;
if (typeof command !== 'string') process.exit(0);

function currentBranch(cwd) {
  try {
    return execFileSync('git', ['symbolic-ref', '--short', 'HEAD'], { cwd, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return '';
  }
}

// Each part of a chained command is checked on its own.
const parts = command.split(/&&|\|\||;|\||\n/).map((part) => part.trim()).filter(Boolean);
const protectedBranch = /(^|[\s:/])(main|master)(\s|$)/;

for (const part of parts) {
  const words = part.split(/\s+/);
  const git = words.indexOf('git');
  const sub = git >= 0 ? words.slice(git + 1).find((word) => !word.startsWith('-')) : undefined;

  if (git >= 0 && /(^|\s)--no-verify(\s|$)/.test(part)) deny('--no-verify skips the checks every commit must pass');

  if (git >= 0 && sub === 'push') {
    if (/(^|\s)(-f|--force|--force-with-lease|--force-if-includes)(=|\s|$)/.test(part) || /\s\+\S+/.test(part)) {
      deny('force push rewrites history that others may have built on');
    }
    if (protectedBranch.test(part)) deny('pushing to main bypasses review');
    // "git push", "git push origin" and "git push origin HEAD" push the current branch.
    const targets = words.slice(words.indexOf('push') + 1).filter((word) => !word.startsWith('-')).slice(1);
    const pushesCurrent = targets.length === 0 || targets.some((target) => target === 'HEAD' || target === '@');
    if (pushesCurrent && ['main', 'master'].includes(currentBranch(input.cwd))) {
      deny('this push would go to main, because main is the current branch');
    }
  }

  if (/(^|\s)gh\s+pr\s+merge(\s|$)/.test(part)) deny('merging a PR is Yoan\'s decision');
  if (/(^|\s)gh\s+pr\s+review(\s|$)/.test(part) && /(^|\s)(-a|--approve)(\s|$)/.test(part)) deny('an agent does not approve PRs');
  if (/(^|\s)gh\s+api(\s|$)/.test(part)) {
    if (/pulls\/\d+\/merge/.test(part)) deny('merging a PR is Yoan\'s decision');
    const writes = /(^|\s)(-X|--method)\s*(PUT|POST|PATCH|DELETE)/i.test(part) || /(^|\s)(-f|-F|--field|--raw-field|--input)(\s|=)/.test(part);
    if (writes && /(\/protection|\/rulesets)/.test(part)) deny('branch protection and rulesets are not changed by agents');
  }
}

process.exit(0);
