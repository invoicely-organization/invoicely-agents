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

// A PR whose one problem is a conflict with its base: the runner tries its own merge before an agent is woken up
// (factory/update-branch.mjs).
export function conflictOnly(failed) {
  return Array.isArray(failed) && failed.length > 0 && failed.every((f) => f.startsWith('merge conflict'));
}

export function fixMessage({ pr, failed, branch, base }) {
  const conflict = failed.some((f) => f.startsWith('merge conflict'));
  const review = failed.includes('review');
  return [
    `CI failed on your PR ${pr}: ${failed.join(', ') || 'a required check'}.`,
    conflict
      ? `Another task was merged into ${base} first. Run git fetch origin and git merge origin/${base}, resolve the conflicts so that both sides' changes stay (for example both agents' entries in policies/role-guard.yaml), and do not drop the other task's work.`
      : `See why with: gh pr checks ${pr}   and   gh run view <run id> --log-failed`,
    ...(review ? [`The reviewer agent did not pass it: read its findings with gh pr view ${pr} --comments and fix every blocking and critical one. A QUESTION you cannot answer from the brief: stop and end with the question.`] : []),
    'Fix only what this task changed. If a failing eval case is about another agent that this task did not change, do not change that agent or its cases: name the case and say so in your answer (INV-53).',
    `Fix it in this worktree, run the checks from your instructions again, then commit and git push to ${branch}.`,
    'Do not open a new PR and do not change the PR base.',
    `End with what you changed, the check results and the PR URL: ${pr}`,
  ].join('\n');
}

// The judges of an eval case can change their mind from one run to the next (on 25.11 PR #20 failed two cases of
// prompt-engineer and passed them on a rerun). So when only the evals failed, CI runs them once more before an agent
// is woken up for a fix round (INV-53).
export function shouldRerunEvals(failed, item) {
  return Array.isArray(failed) && failed.length === 1 && failed[0] === 'evals' && !item.evalReruns;
}

// What a queued fix round does when the runner looks at its PR again just before the session (INV-60): 'ci' when
// the PR no longer fails (fixed meanwhile, or CI runs again), 'rerun-evals' when only the evals fail and they were
// not run again yet, otherwise 'run' with the failures as they are now.
export function fixPrecheck(result, item) {
  if (result?.verdict !== 'fail') return 'ci';
  if (shouldRerunEvals(result.failed, item)) return 'rerun-evals';
  return 'run';
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

// The spending period a moment belongs to: the night window, or the day between two nights. Each has its own cap,
// so a run started by day with --now is capped too.
export function spendingPeriod(now, { windowStart, windowEnd, nightBudgetUsd, dayBudgetUsd }) {
  if (inWindow(now, windowStart, windowEnd)) return { kind: 'night', start: nightStart(now, windowStart), cap: nightBudgetUsd };
  const start = new Date(now);
  start.setHours(windowEnd, 0, 0, 0);
  if (start > now) start.setDate(start.getDate() - 1);
  return { kind: 'day', start, cap: dayBudgetUsd };
}

// Claude's total_cost_usd is what the whole session has cost so far, also after --resume. So the entry of a resumed
// run holds the session's running total: in sessionCostUsd since INV-47, in costUsd before. entryCosts turns the
// ledger into what each entry itself cost, in ledger order: the running total minus the session's previous total.
// A session first seen with a total (it began before the ledger) counts that total once. CI evals count as they are.
export function entryCosts(entries) {
  const totals = new Map();
  return entries.map((e) => {
    if (e.status === 'ci-evals') return Number(e.costUsd) || 0;
    const value = e.sessionCostUsd ?? e.costUsd;
    if (value == null || !Number.isFinite(Number(value))) return 0;
    const total = Number(value);
    if (!e.session) return total;
    const before = totals.get(e.session);
    totals.set(e.session, total);
    return before !== undefined && total >= before ? Math.round((total - before) * 1e6) / 1e6 : total;
  });
}

// What was spent since a moment: sessions and CI evals, in API dollars. Pass the whole ledger, so that a session
// resumed tonight is counted from where it stopped before.
export function spentSince(entries, since) {
  const costs = entryCosts(entries);
  return entries.reduce((sum, e, i) => (e.ended && Date.parse(e.ended) >= since.getTime() ? sum + costs[i] : sum), 0);
}

// What a task's sessions have cost over all its runs. CI evals are left out: the task cap limits what the agent
// spends, and the evals count against the period cap.
export function taskSpent(entries, issue) {
  const costs = entryCosts(entries);
  return entries.reduce((sum, e, i) => (e.issue === issue && e.status !== 'ci-evals' ? sum + costs[i] : sum), 0);
}

// Yoan's answer to a task over its cap: "спри" stops it, a bare "продължи" goes on, anything else goes on with his
// words passed to the agent. The u flag makes the word boundaries work for Cyrillic ("спринт" is not "спри").
export function budgetAnswer(text) {
  const t = (text ?? '').trim();
  if (/(^|[^\p{L}])спри([^\p{L}]|$)/iu.test(t)) return 'stop';
  return /^продължи[\s.!]*$/iu.test(t) ? 'continue' : 'continue-with-note';
}

// The budget of the next session: what is left of the task's cap and of the period's cap, whichever is smaller.
// Under $2 left is not worth a session; stoppedBy says which cap stops it.
export function sessionBudget({ taskCap, taskSpent: spentOnTask = 0, periodCap, periodSpent = 0 }) {
  const taskLeft = taskCap - spentOnTask;
  const periodLeft = periodCap - periodSpent;
  const left = Math.min(taskLeft, periodLeft);
  if (left < 2) return { budget: 0, stoppedBy: taskLeft <= periodLeft ? 'task' : 'period' };
  return { budget: Math.floor(left * 100) / 100, stoppedBy: null };
}

const STATUS_BG = {
  done: 'PR отворен', merged: 'слято', needs_answer: 'въпрос към теб', limit: 'спрян от лимита', error: 'грешка',
  ci_failed: 'червен CI', blocked: 'блокирана', closed: 'PR затворен', 'ci-evals': 'evals в CI', over_budget: 'над тавана',
  answered: 'отговорено', stopped: 'спряна от теб', feature_pr: 'PR на функционалността',
};

// The night report for Linear: one line per task, the evals in CI, the total against the cap.
export function nightReport(entries, since, nightCap) {
  const costs = entryCosts(entries);
  const byTask = new Map();
  entries.forEach((e, i) => {
    if (!e.ended || Date.parse(e.ended) < since.getTime()) return;
    const row = byTask.get(e.issue) ?? { sessions: 0, minutes: 0, session$: 0, ci$: 0, last: '', pr: null };
    if (e.status === 'ci-evals') row.ci$ += costs[i];
    else {
      if (e.minutes != null) { row.sessions += 1; row.minutes += e.minutes; }
      row.session$ += costs[i];
      row.last = STATUS_BG[e.status] ?? e.status;
    }
    row.pr = e.pr ?? row.pr;
    byTask.set(e.issue, row);
  });
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

// --- Delivery (INV-54): one PR per feature ---

// A feature is ready for its PR to main when it has subtasks, each of them is done or canceled, and none is still
// in the runner's queue.
export function featureReady(children, queue, base) {
  return children.length > 0 && children.every((c) => ['completed', 'canceled'].includes(c.state?.type)) && !queue.some((t) => t.base === base);
}

// The PR of a feature, for Yoan: what changes (the subtasks and their PRs), the risks and what to test. The reviewer
// adds its own summary on PRs to main once it runs in CI (INV-44).
export function featurePrBody({ feature, children, merged, repo }) {
  const prFor = (id) => merged.find((p) => p.title.startsWith(`${id}:`));
  const lines = [
    '## Какво се променя', '',
    `${feature.title} (Linear: ${feature.identifier}).`, '',
    ...children.map((c) => {
      const pr = prFor(c.identifier);
      return `- ${c.identifier}: ${c.title}${c.state?.type === 'canceled' ? ' (отменена)' : pr ? ` (#${pr.number})` : ''}`;
    }),
    '',
    '## Рискове', '',
    'Всяка подзадача е минала CI поотделно и е слята във feature клона, когато е била зелена. Рисковете за целия набор ги пише reviewer-ът в CI (INV-44), щом влезе в main; дотогава ги виж в описанията на PR-ите на подзадачите.',
    '',
    '## Какво да тестваш', '',
    repo === 'invoicely-agents'
      ? '- Отчетът на evals в CI на този PR: всички агенти, които функционалността променя, минават.'
      : '- Средата на този PR в staging (INV-19): сценариите от критериите за приемане на подзадачите.',
    '- Зелен CI на този PR.',
    '',
    `Linear: ${feature.identifier}`,
  ];
  return `${lines.join('\n')}\n`;
}

// --- One writer for the status of the runner's tasks (INV-50) ---

// What the runner does with the Linear status of a task in its queue. In the queue means In Progress, or In Review
// while the PR waits for CI. Backlog or Canceled means Yoan stopped it. A "Чака Йоан" left over from a question that
// is gone is replaced, with a note. Other statuses (Done, In Review on a fix round) are left as they are.
export function statusAction(task, state) {
  const want = task.stage === 'ci' ? 'In Review' : 'In Progress';
  if (state.type === 'backlog' || state.type === 'canceled') return { action: 'remove' };
  if (state.name === 'Чака Йоан') return { action: 'set', want, note: true };
  if (state.name === 'Ready' || (state.name === 'In Progress' && want === 'In Review')) return { action: 'set', want, note: false };
  return { action: 'none' };
}

// --- The runner as a launchd service (INV-49) ---

const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// A LaunchAgent that keeps the runner going: at login, after a crash and after it exits for new code. caffeinate
// keeps the Mac awake while the runner runs, as when it was started by hand.
export function servicePlist({ label, node, script, cwd, logFile, pathEnv, home }) {
  const args = ['/usr/bin/caffeinate', '-i', node, script, 'queue', 'run'].map((a) => `      <string>${xml(a)}</string>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${xml(label)}</string>
    <key>ProgramArguments</key>
    <array>
${args}
    </array>
    <key>WorkingDirectory</key>
    <string>${xml(cwd)}</string>
    <key>EnvironmentVariables</key>
    <dict>
      <key>PATH</key>
      <string>${xml(pathEnv)}</string>
      <key>HOME</key>
      <string>${xml(home)}</string>
      <key>INVOICELY_SERVICE</key>
      <string>1</string>
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ThrottleInterval</key>
    <integer>60</integer>
    <key>StandardOutPath</key>
    <string>${xml(logFile)}</string>
    <key>StandardErrorPath</key>
    <string>${xml(logFile)}</string>
  </dict>
</plist>
`;
}
