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
