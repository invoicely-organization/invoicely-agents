// Pure helpers for the runner, kept apart so they can be tested without Claude, git or GitHub.

// --- Sessions ---

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

// The Max limit, said in any of the ways Claude Code says it (on 25.11 CI said "Credit balance is too low"), or an
// overloaded API: none of these is the agent's fault, so the step waits and runs again instead of failing.
export function isLimitText(text) {
  return /hit your [^\n]*limit|usage limit|credit balance is too low|rate.?limit|overloaded/i.test(text ?? '');
}

// When to try again after a limit: the reset Claude gave, or in an hour when it gave none.
export function retryAt(text, now = new Date()) {
  return parseLimitReset(text, now) ?? new Date(now.getTime() + 60 * 60 * 1000);
}

export function findPrUrl(text) {
  const match = /https:\/\/github\.com\/[^\s)\]]+\/pull\/\d+/.exec(text ?? '');
  return match ? match[0] : null;
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

// Every session ends its last message with one line "RESULT: <kind>"; what comes before it is the report.
// DONE: the step is done. QUESTION: a question for Yoan. TEST_WRONG: the implementer says a test is wrong.
// KEEP: test-author keeps a test the implementer called wrong, and says why.
const KINDS = ['DONE', 'QUESTION', 'TEST_WRONG', 'KEEP'];
export function parseOutcome(text) {
  const lines = (text ?? '').trimEnd().split('\n');
  for (let i = lines.length - 1; i >= 0 && i >= lines.length - 5; i -= 1) {
    const match = /^\s*\**RESULT:?\**\s*:?\s*([A-Z_]+)\b/.exec(lines[i]);
    if (match && KINDS.includes(match[1])) return { kind: match[1], report: lines.slice(0, i).join('\n').trim() };
  }
  return { kind: null, report: (text ?? '').trim() };
}

// limit: wait and resume the same session; error: Claude failed; question: a question for Yoan (also a session that
// ended without a RESULT line, so nothing is lost); done, test_wrong, keep: the step's outcome.
export function classify({ isError, text }) {
  if (isLimitText(text)) return 'limit';
  if (isError) return 'error';
  const { kind } = parseOutcome(text);
  return kind ? kind.toLowerCase() : 'question';
}

export function minutesBetween(start, end) {
  return Math.round((end - start) / 60000);
}

// --- GitHub ---

// The review check, also when it comes from the shared workflow ("review / review").
export function isReviewCheck(name) {
  return /(^|\/\s*)review$/i.test((name ?? '').trim());
}

// `gh pr checks --json name,bucket` gives pass, fail, pending, skipping or cancel per check. The review check is
// left out: its verdict is read from the review itself. No checks yet counts as pending.
export function checksVerdict(checks) {
  const own = (checks ?? []).filter((c) => !isReviewCheck(c.name));
  if (own.length === 0) return 'pending';
  if (own.some((c) => c.bucket === 'fail' || c.bucket === 'cancel')) return 'fail';
  if (own.some((c) => c.bucket === 'pending')) return 'pending';
  return 'pass';
}

export function failedChecks(checks) {
  return (checks ?? []).filter((c) => !isReviewCheck(c.name) && (c.bucket === 'fail' || c.bucket === 'cancel')).map((c) => c.name);
}

// The hidden line the review job writes into every review: <!-- invoicely-review verdict=PASS sha=abc cost=0.42 -->
export function reviewMarker(body) {
  const match = /<!--\s*invoicely-review\s+([^>]*?)\s*-->/.exec(body ?? '');
  if (!match) return null;
  const fields = Object.fromEntries(match[1].split(/\s+/).map((pair) => pair.split('=')).filter((p) => p.length === 2));
  if (!fields.verdict) return null;
  return { verdict: fields.verdict, sha: fields.sha ?? null, costUsd: Number(fields.cost) || 0 };
}

// The review of the PR's head: the newest one by the review job whose marker names that commit. Anyone may comment
// on a public repo's PR, so only reviews by the job's own account count.
export function reviewOfHead(reviews, headSha, author = 'github-actions[bot]') {
  const ofHead = (reviews ?? [])
    .filter((r) => r.user?.login === author)
    .map((r) => ({ ...r, marker: reviewMarker(r.body) }))
    .filter((r) => r.marker && r.marker.sha === headSha);
  return ofHead.at(-1) ?? null;
}

// The review's text for the implementer and for Linear: the body without the marker and the cost line.
export function reviewText(body) {
  return (body ?? '').replace(/<!--[\s\S]*?-->/g, '').replace(/\n<sub>[^\n]*<\/sub>\s*$/, '').trim();
}

// The finding lines of a review ("- critical path:12 - ..."), for the summary in Linear.
export function findingLines(text) {
  return (text ?? '').split('\n').map((l) => l.trim()).filter((l) => /^- (blocking|critical|warning|info)\b/i.test(l));
}

// What the implementer gets in a fix round: the review's findings, the red checks, or a conflict with main.
export function fixMessage({ round, maxRounds, review, failed = [], conflict = false }) {
  return [
    `Fix round ${round} of ${maxRounds} on your PR.`,
    ...(review ? [`The reviewer did not pass it. Its review:\n\n${review}`] : []),
    ...(failed.length ? [`These CI checks failed: ${failed.join(', ')}. Run the same checks here to see why.`] : []),
    ...(conflict ? ['The PR conflicts with main: run git fetch origin and git merge origin/main, and resolve the conflicts so that both sides\' changes stay.'] : []),
    'Fix every blocking and critical finding and every failed check, in this worktree, under the same rules as before: do not change the tests. If a finding says a test is wrong, or you think so, end with RESULT: TEST_WRONG and the reason. If a finding needs Yoan, end with RESULT: QUESTION.',
    'Do not commit or push: the runner does that. End with what you changed (in Bulgarian, at most 5 lines) and RESULT: DONE.',
  ].join('\n\n');
}

// --- Money ---

// Claude's total_cost_usd is what the whole session has cost so far, also after --resume. So the entry of a resumed
// run holds the session's running total in sessionCostUsd. entryCosts turns the ledger into what each entry itself
// cost, in ledger order. A review's cost is its own. Old entries (before INV-47) have only costUsd.
export function entryCosts(entries) {
  const totals = new Map();
  return entries.map((e) => {
    if (e.status === 'review') return Number(e.costUsd) || 0;
    const value = e.sessionCostUsd ?? e.costUsd;
    if (value == null || !Number.isFinite(Number(value))) return 0;
    const total = Number(value);
    if (!e.session) return total;
    const before = totals.get(e.session);
    totals.set(e.session, total);
    return before !== undefined && total >= before ? Math.round((total - before) * 1e6) / 1e6 : total;
  });
}

// What a task has cost since it was taken from Ready: { sessions, reviews, total } in API dollars.
export function taskCost(entries, issue, since) {
  const costs = entryCosts(entries);
  const sum = { sessions: 0, reviews: 0 };
  entries.forEach((e, i) => {
    if (e.issue !== issue || (since && (!e.ended || Date.parse(e.ended) < Date.parse(since)))) return;
    if (e.status === 'review') sum.reviews += costs[i];
    else sum.sessions += costs[i];
  });
  return { ...sum, total: sum.sessions + sum.reviews };
}

// Yoan's answer to a task over its cap: "спри" stops it, a bare "продължи" goes on, anything else goes on with his
// words passed to the agent. The u flag makes the word boundaries work for Cyrillic ("спринт" is not "спри").
export function budgetAnswer(text) {
  const t = (text ?? '').trim();
  if (/(^|[^\p{L}])спри([^\p{L}]|$)/iu.test(t)) return 'stop';
  return /^продължи[\s.!]*$/iu.test(t) ? 'continue' : 'continue-with-note';
}

// --- The queue ---

// The next step to run: the first task that is not waiting for its review and not waiting for a limit to reset.
export function nextRunnable(queue, now = new Date()) {
  return queue.find((t) => t.stage !== 'review' && !(t.waitUntil && Date.parse(t.waitUntil) > now.getTime())) ?? null;
}

// --- The summary in Linear ---

const usd = (n) => `$${n.toFixed(2)}`;

// The comment when the PR is merged: what was done, the PR, what the review caught, what it cost.
export function summaryBody({ pr, report, reviews, cost, minutes }) {
  const caught = reviews.filter((r) => r.verdict !== 'PASS');
  const reviewLines = caught.length === 0
    ? ['Ревюто мина от първия път, без забележки.']
    : caught.flatMap((r) => [`Кръг ${r.round}: ${r.verdict}`, ...r.findings.slice(0, 5).map((f) => `  ${f}`)]);
  return [
    `**Готово и слято.** PR: ${pr}`,
    '',
    '**Какво е направено**',
    report || '(агентът не даде резюме; виж PR-а)',
    '',
    '**Какво хвана ревюто**',
    ...reviewLines,
    '',
    `**Цена:** ${usd(cost.total)} (сесии ${usd(cost.sessions)}, ревю ${usd(cost.reviews)}), по API цена; на Max е дял от лимита.${minutes ? ` Време: ${minutes} мин.` : ''}`,
  ].join('\n');
}

// --- One writer for the status of the runner's tasks ---

// What the runner does with the Linear status of a task in its queue. In the queue means In Progress, or In Review
// while its PR is with the reviewer. Backlog or Canceled means Yoan stopped it. A "Чака Йоан" left over from a
// question that is gone is replaced, with a note. Done is left as it is.
export function statusAction(task, state) {
  const want = task.stage === 'review' ? 'In Review' : 'In Progress';
  if (state.type === 'backlog' || state.type === 'canceled') return { action: 'remove' };
  if (state.name === 'Чака Йоан') return { action: 'set', want, note: true };
  if (state.name === 'Ready' || (state.name !== want && ['In Progress', 'In Review'].includes(state.name))) return { action: 'set', want, note: false };
  return { action: 'none' };
}

// --- The runner as a launchd service (INV-49) ---

const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// A LaunchAgent that keeps the runner going: at login, after a crash and after it exits for new code. caffeinate
// keeps the Mac awake while the runner runs.
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
