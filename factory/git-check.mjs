// The runner's check of a session's diff (INV-64): after every session, the files it changed must be ones its role may
// write (policies/role-guard.yaml), whether it wrote them through Write and Edit or through Bash.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { decideWrite, loadPolicy } from '../hooks/lib/policy.mjs';

const git = (cwd, args) => execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 }).toString().trim();
const gitZ = (cwd, args) => execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 }).toString().split('\0').filter(Boolean);

export function mergeInProgress(wt) {
  return fs.existsSync(path.resolve(wt, git(wt, ['rev-parse', '--git-dir']), 'MERGE_HEAD'));
}

// Files git still marks as conflicted.
export function unmergedFiles(wt) {
  return [...new Set(git(wt, ['diff', '--name-only', '--diff-filter=U']).split('\n').filter(Boolean))];
}

// The files a session changed: against the commit it started from, plus new files. While the runner's merge of main
// is open (a conflict the implementer resolves), a file main changed and that is now exactly as in main came from
// main; any other change, a deleted test included, is the session's.
export function touchedFiles(wt, before) {
  const files = new Set([...gitZ(wt, ['diff', '--no-renames', '--name-only', '-z', before]), ...gitZ(wt, ['ls-files', '--others', '--exclude-standard', '-z'])]);
  if (!mergeInProgress(wt)) return [...files];
  const mergeBase = git(wt, ['merge-base', before, 'MERGE_HEAD']);
  const fromMain = new Set(gitZ(wt, ['diff', '--no-renames', '--name-only', '-z', mergeBase, 'MERGE_HEAD']));
  const blob = (file) => {
    try {
      return git(wt, ['rev-parse', `MERGE_HEAD:${file}`]);
    } catch {
      return 'deleted';
    }
  };
  const working = (file) => (fs.existsSync(path.join(wt, file)) ? git(wt, ['hash-object', '--', file]) : 'deleted');
  return [...files].filter((file) => !(fromMain.has(file) && blob(file) === working(file)));
}

// Why each changed file is outside the role, or [] when the session kept to it.
export function policyViolations(wt, before, role, policyFile) {
  const policy = loadPolicy(policyFile);
  return touchedFiles(wt, before).map((file) => decideWrite(policy, role, file)).filter((d) => !d.allowed).map((d) => d.reason);
}
