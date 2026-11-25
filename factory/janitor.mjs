// The clean-up of task copies and branches (INV-48), as pure decisions so that they can be tested without git.
// The runner gathers the facts, asks planCleanup what to do, and does it. Like a reconcile loop: the queue and the
// PRs say what should exist, the disk and GitHub say what does, and the plan makes them match.
//
// A copy or a branch goes only when its PR is merged or closed and nothing in it is unsaved: its tip is exactly the
// PR's head (a closed PR keeps its head, so the branch can be restored from it) and the copy has no uncommitted
// changes. Everything else stays; a copy whose PR is over but that holds unsaved work is reported, not touched.

const KEEP_BRANCHES = /^(main|master)$/;

// The PR that decides for a branch: an open one wins, then the latest merged or closed one.
export function prForBranch(prs, branch) {
  const mine = prs.filter((p) => p.headRefName === branch);
  return mine.find((p) => p.state === 'OPEN') ?? mine.sort((a, b) => (b.number ?? 0) - (a.number ?? 0))[0] ?? null;
}

const over = (pr) => pr && (pr.state === 'MERGED' || pr.state === 'CLOSED');

// copies: [{ path, branch, head, dirty }]; branch is null for a detached copy.
// prs: [{ number, headRefName, headRefOid, baseRefName, state }] from gh pr list --state all.
// copies may carry ageDays: days since the copy was created.
// queue: the runner's queue; protectedPaths: copies the runner itself needs (the plugin's copy, its own copy).
// localBranches, remoteBranches: [{ name, head }]; a local branch checked out in a copy is never deleted.
export function planCleanup({ copies = [], prs = [], queue = [], protectedPaths = [], localBranches = [], remoteBranches = [], staleDays = 7 }) {
  const queued = new Set(queue.map((t) => t.branch));
  // A branch another open PR or a queued task builds on is never deleted, even when its own PR is over: GitHub
  // would retarget or close the PRs on top of it (on 25.11 PR #23 targets inv-30-45-linear, the head of #19).
  const bases = new Set([...prs.filter((p) => p.state === 'OPEN').map((p) => p.baseRefName), ...queue.map((t) => t.base)].filter(Boolean));
  const plan = { removeCopies: [], keepCopies: [], report: [], deleteLocal: [], deleteRemote: [] };
  const removed = new Set();
  const BG = { MERGED: 'слят', CLOSED: 'затворен' };
  for (const copy of copies) {
    // why is for the log; bg is the same in Bulgarian, for the comment in Linear.
    const keep = (why, ask = false, bg = why) => {
      plan.keepCopies.push({ path: copy.path, branch: copy.branch, why });
      if (ask) plan.report.push({ path: copy.path, branch: copy.branch, why, bg });
    };
    if (protectedPaths.includes(copy.path)) { keep('the runner needs it'); continue; }
    if (!copy.branch) { keep('detached, not a task copy'); continue; }
    if (queued.has(copy.branch)) { keep('its task is in the queue'); continue; }
    const pr = prForBranch(prs, copy.branch);
    if (!pr) {
      // Nothing stays forever unnoticed: a copy with no PR and no task for a week is reported once.
      const stale = (copy.ageDays ?? 0) >= staleDays;
      const days = Math.floor(copy.ageDays ?? 0);
      keep(stale ? `no PR and no task for ${days} days` : 'no PR yet', stale, `няма PR и задача от ${days} дни`);
      continue;
    }
    if (!over(pr)) { keep(`PR #${pr.number} is open`); continue; }
    if (copy.dirty) {
      keep(`PR #${pr.number} is ${pr.state.toLowerCase()} but the copy has uncommitted changes`, true, `PR #${pr.number} е ${BG[pr.state]}, но в копието има незаписани промени`);
      continue;
    }
    if (copy.head !== pr.headRefOid) {
      keep(`PR #${pr.number} is ${pr.state.toLowerCase()} but the copy has commits that are not in it`, true, `PR #${pr.number} е ${BG[pr.state]}, но в копието има commit-и, които не са в него`);
      continue;
    }
    plan.removeCopies.push({ path: copy.path, branch: copy.branch, why: `PR #${pr.number} is ${pr.state.toLowerCase()}` });
    removed.add(copy.branch);
  }
  const checkedOut = new Set(copies.filter((c) => c.branch && !removed.has(c.branch)).map((c) => c.branch));
  const keptWithWork = new Set(plan.report.map((r) => r.branch));
  const deletable = (b) => {
    if (KEEP_BRANCHES.test(b.name) || queued.has(b.name) || bases.has(b.name) || keptWithWork.has(b.name)) return false;
    const pr = prForBranch(prs, b.name);
    return over(pr) && b.head === pr.headRefOid;
  };
  plan.deleteLocal = localBranches.filter((b) => !checkedOut.has(b.name) && deletable(b)).map((b) => b.name);
  plan.deleteRemote = remoteBranches.filter(deletable).map((b) => b.name);
  return plan;
}

// `git worktree list --porcelain` as [{ path, head, branch }].
export function parseWorktrees(porcelain) {
  const list = [];
  let current = null;
  for (const line of (porcelain ?? '').split('\n')) {
    if (line.startsWith('worktree ')) {
      current = { path: line.slice(9), head: null, branch: null };
      list.push(current);
    } else if (current && line.startsWith('HEAD ')) current.head = line.slice(5);
    else if (current && line.startsWith('branch refs/heads/')) current.branch = line.slice(18);
  }
  return list;
}

// Logs older than the cut-off go; the runner's own logs (runner.log, queue.log) stay.
export function oldLogs(files, now, days = 30) {
  const cutoff = now.getTime() - days * 24 * 60 * 60 * 1000;
  return files.filter((f) => /^INV-\d+-.*\.log$/.test(f.name) && f.mtimeMs < cutoff).map((f) => f.name);
}

// One line for the night report.
export function cleanupSummary(plan, done) {
  const kept = plan.keepCopies.length;
  return `Чистене: махнати ${done.copies} копия, ${done.local} локални и ${done.remote} отдалечени клона, ${done.logs} стари лога; на диска остават ${kept} копия${plan.report.length ? `, ${plan.report.length} с незаписана работа (виж Linear)` : ''}.`;
}
