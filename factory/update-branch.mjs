// The runner brings a task branch up to date with its base by itself when the only conflicts are in files that git
// merges by union (.gitattributes: merge=union), such as policies/role-guard.yaml, where every agent adds its own
// entry at the end. Like GitHub's "Update branch" button, and git's union driver for changelogs. Any other conflict,
// or a merge that leaves the role guard policy unreadable (two entries for one agent), is undone and goes to the
// agent as before, so the runner never decides anything an agent or Yoan should.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { loadPolicy, parsePolicy } from '../hooks/lib/policy.mjs';

const POLICY = 'policies/role-guard.yaml';
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

// The role guard policy merged agent by agent: an entry changed on one side only takes that side, the same change on
// both sides is fine, different changes to one agent are a real conflict (null). A text union cannot be trusted by
// itself: when both sides add the same agent, git keeps one "reviewer:" line and both "allow:" lines, and the parser
// keeps the last one.
export function mergePolicies(base, ours, theirs) {
  const merged = {};
  for (const agent of new Set([...Object.keys(base), ...Object.keys(ours), ...Object.keys(theirs)])) {
    let entry;
    if (same(ours[agent], theirs[agent])) entry = ours[agent];
    else if (same(ours[agent], base[agent])) entry = theirs[agent];
    else if (same(theirs[agent], base[agent])) entry = ours[agent];
    else return null;
    if (entry) merged[agent] = entry;
  }
  return merged;
}

function runner(cwd, env) {
  return (args) => execFileSync('git', args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
}

function isAncestor(git, ancestor, of) {
  try {
    git(['merge-base', '--is-ancestor', ancestor, of]);
    return true;
  } catch {
    return false;
  }
}

// Merges ref into the branch checked out in cwd and commits; the caller pushes. The attributes come from
// attributesFile (the main checkout's .gitattributes), so a branch made before the file existed merges the same way.
// Returns { merged: true } or { merged: false, why }.
export function mergeBaseInto({ cwd, ref, attributesFile, message, env = process.env }) {
  const git = runner(cwd, env);
  if (git(['status', '--porcelain'])) return { merged: false, why: 'the copy has uncommitted changes' };
  if (isAncestor(git, ref, 'HEAD')) return { merged: false, why: `the branch already contains ${ref}` };
  const head = git(['rev-parse', 'HEAD']);
  const at = (rev) => {
    try {
      return parsePolicy(git(['show', `${rev}:${POLICY}`]));
    } catch {
      return {}; // no policy in that revision
    }
  };
  const mergeBase = git(['merge-base', 'HEAD', ref]);
  try {
    git(['-c', `core.attributesFile=${attributesFile}`, 'merge', '--no-ff', '-m', message, ref]);
  } catch {
    const files = git(['diff', '--name-only', '--diff-filter=U']).split('\n').filter(Boolean);
    git(['merge', '--abort']);
    return { merged: false, why: `conflicts in ${files.join(', ') || 'files git could not name'}` };
  }
  const file = path.join(cwd, POLICY);
  let why = null;
  try {
    const want = mergePolicies(at(mergeBase), at(head), at(ref));
    if (!want) why = `both sides changed the same agent in ${POLICY}`;
    else if (fs.existsSync(file) && !same(loadPolicy(file), want)) why = `the text merge of ${POLICY} does not give each agent its entry`;
  } catch (error) {
    why = `the merged ${POLICY} does not read (${error.message})`;
  }
  if (why) {
    git(['reset', '-q', '--hard', head]);
    return { merged: false, why };
  }
  return { merged: true };
}

// GitHub still says "conflict" for a short while after a push that fixed it: the remote branch already holds the base.
export function alreadyUpdated({ cwd, base, branch, env = process.env }) {
  return isAncestor(runner(cwd, env), `origin/${base}`, `origin/${branch}`);
}

// The copy must be exactly the PR's head, so that the runner merges what CI saw and pushes nothing else.
export function copyMatchesPr({ cwd, branch, env = process.env }) {
  const git = runner(cwd, env);
  return git(['rev-parse', 'HEAD']) === git(['rev-parse', `origin/${branch}`]);
}
