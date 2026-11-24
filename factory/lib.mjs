// Pure helpers for the factory runner, kept apart so they can be tested without Claude.

// "You've hit your 5-hour limit · resets 3:20am (Europe/Sofia)" gives the next local time it resets.
export function parseLimitReset(text, now = new Date()) {
  const match = /hit your [^\n]*?limit[^\n]*?resets\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i.exec(text ?? '');
  if (!match) return null;
  let hour = Number(match[1]) % 12;
  if (match[3].toLowerCase() === 'pm') hour += 12;
  const reset = new Date(now);
  reset.setHours(hour, match[2] ? Number(match[2]) : 0, 0, 0);
  if (reset <= now) reset.setDate(reset.getDate() + 1);
  return reset;
}

export function findPrUrl(text) {
  const match = /https:\/\/github\.com\/[^\s)\]]+\/pull\/\d+/.exec(text ?? '');
  return match ? match[0] : null;
}

// limit: stopped by the usage limit, resume later; done: a PR was opened;
// error: the run failed; needs_answer: it stopped with a question for Yoan.
export function classify({ isError, text }) {
  if (parseLimitReset(text)) return 'limit';
  if (findPrUrl(text)) return 'done';
  if (isError) return 'error';
  return 'needs_answer';
}

// The night window may cross midnight (22 to 8).
export function inWindow(now, startHour, endHour) {
  const hour = now.getHours();
  return startHour > endHour ? hour >= startHour || hour < endHour : hour >= startHour && hour < endHour;
}

export function nextWindowStart(now, startHour) {
  const start = new Date(now);
  start.setHours(startHour, 0, 0, 0);
  if (start <= now) start.setDate(start.getDate() + 1);
  return start;
}

export function fillTemplate(template, vars) {
  return template.replace(/\{([A-Z_]+)\}/g, (whole, key) => (key in vars ? vars[key] : whole));
}

// Claude Code keeps a project's sessions in ~/.claude/projects/<path with every non-alphanumeric as ->.
export function sessionDirName(cwd) {
  return cwd.replace(/[^A-Za-z0-9]/g, '-');
}

// The JSON result of `claude -p --output-format json`; plain text when Claude stopped before it.
export function parseResult(stdout) {
  const lines = (stdout ?? '').trim().split('\n').reverse();
  for (const line of lines) {
    try {
      const json = JSON.parse(line);
      if (json && typeof json === 'object' && 'result' in json) {
        return { text: String(json.result ?? ''), isError: Boolean(json.is_error), sessionId: json.session_id ?? null, costUsd: json.total_cost_usd ?? null, turns: json.num_turns ?? null };
      }
    } catch {
      // not JSON, keep looking
    }
  }
  return { text: stdout ?? '', isError: true, sessionId: null, costUsd: null, turns: null };
}

export function minutesBetween(start, end) {
  return Math.round((end - start) / 60000);
}

// --- Feature branches (INV-43): every subtask PR goes to feature/INV-xx and is merged there when CI is green.

export function isFeatureBranch(base) {
  return /^feature\//.test(base ?? '');
}

// `gh pr checks --json name,bucket` gives pass, fail, pending, skipping or cancel per check.
// No checks yet counts as pending: the workflow may not have started.
export function checksVerdict(checks) {
  if (!Array.isArray(checks) || checks.length === 0) return 'pending';
  if (checks.some((c) => c.bucket === 'fail' || c.bucket === 'cancel')) return 'fail';
  if (checks.some((c) => c.bucket === 'pending')) return 'pending';
  return 'pass';
}

export function failedChecks(checks) {
  return (checks ?? []).filter((c) => c.bucket === 'fail' || c.bucket === 'cancel').map((c) => c.name);
}

// A task may run when every task it depends on is merged into its base.
export function blockingDeps(task, merged) {
  return (task.dependsOn ?? []).filter((dep) => !merged.has(dep));
}

export function fixMessage({ pr, failed, branch, base }) {
  const conflict = failed.some((f) => f.startsWith('merge conflict'));
  return [
    `CI failed on your PR ${pr}: ${failed.join(', ') || 'a required check'}.`,
    conflict
      ? `Another task was merged into ${base} first. Run git fetch origin and git merge origin/${base}, resolve the conflicts so that both sides' changes stay (for example both agents' entries in policies/role-guard.yaml), and do not drop the other task's work.`
      : `See why with: gh pr checks ${pr}   and   gh run view <run id> --log-failed`,
    `Fix it in this worktree, run the checks from your instructions again, then commit and git push to ${branch}.`,
    'Do not open a new PR and do not change the PR base.',
    `End with what you changed, the check results and the PR URL: ${pr}`,
  ].join('\n');
}

// Pick the next task to run: the first one that is not waiting for CI and whose dependencies are merged
// into its own base. mergedByBase maps a base branch to the set of task ids merged into it.
export function nextRunnable(queue, mergedByBase) {
  return queue.find((t) => t.stage !== 'ci' && blockingDeps(t, mergedByBase.get(t.base || 'main') ?? new Set()).length === 0) ?? null;
}

// --- Spending (INV-39) ---

// The start of the night a moment belongs to: 03:00 and 10:00 belong to the night that began yesterday at 22:00.
export function nightStart(now, startHour) {
  const start = new Date(now);
  start.setHours(startHour, 0, 0, 0);
  if (start > now) start.setDate(start.getDate() - 1);
  return start;
}

// What a night has cost so far: sessions and CI evals from the ledger, in API dollars.
export function spentSince(entries, since) {
  return entries.filter((e) => e.ended && Date.parse(e.ended) >= since.getTime()).reduce((sum, e) => sum + (Number(e.costUsd) || 0), 0);
}

// The budget a session may get: its own cap, but never more than what is left of the night.
export function sessionBudget(taskBudget, nightCap, spent) {
  const left = nightCap - spent;
  return left < 2 ? 0 : Math.min(taskBudget, Math.floor(left * 100) / 100);
}

const STATUS_BG = {
  done: 'PR отворен', merged: 'слято', needs_answer: 'въпрос към теб', limit: 'спрян от лимита', error: 'грешка',
  ci_failed: 'червен CI', blocked: 'блокирана', closed: 'PR затворен', 'ci-evals': 'evals в CI',
};

// The night report for Linear: one line per task, the evals in CI, the total against the cap.
export function nightReport(entries, since, nightCap) {
  const night = entries.filter((e) => e.ended && Date.parse(e.ended) >= since.getTime());
  const byTask = new Map();
  for (const e of night) {
    const row = byTask.get(e.issue) ?? { sessions: 0, minutes: 0, session$: 0, ci$: 0, last: '', pr: null };
    if (e.status === 'ci-evals') row.ci$ += Number(e.costUsd) || 0;
    else {
      if (e.minutes != null) { row.sessions += 1; row.minutes += e.minutes; }
      row.session$ += Number(e.costUsd) || 0;
      row.last = STATUS_BG[e.status] ?? e.status;
    }
    row.pr = e.pr ?? row.pr;
    byTask.set(e.issue, row);
  }
  const total = spentSince(entries, since);
  const lines = [
    `**Нощта от ${since.toLocaleDateString('bg-BG')}**: общо $${total.toFixed(2)} от тавана $${nightCap} (цена по API; на Max това е дял от лимита, не плащане).`,
    '',
    '| Задача | Последно | Сесии | Минути | Сесии $ | Evals в CI $ | PR |',
    '| --- | --- | --- | --- | --- | --- | --- |',
  ];
  for (const [issue, r] of [...byTask].sort()) {
    lines.push(`| ${issue} | ${r.last || '-'} | ${r.sessions} | ${r.minutes} | ${r.session$.toFixed(2)} | ${r.ci$.toFixed(2)} | ${r.pr ?? '-'} |`);
  }
  if (byTask.size === 0) lines.push('| - | нищо не е пускано | 0 | 0 | 0.00 | 0.00 | - |');
  return lines.join('\n');
}
