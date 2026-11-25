// What the runner takes from Linear, as pure functions. A task Yoan moves to Ready is the "go": it goes into the queue
// as it is (Какво, Как проверявам, Agent notes), unless a task that blocks it is still open. Its labels say the repo
// (invoicely-agents, otherwise invoicely) and whether it ends with Yoan's check of the UI (UI).

// Linear's branch name without the user prefix: "yoansvdimitrov/inv-45-runner-t-vzima" becomes "inv-45-runner-t-vzima".
export function branchName(issue) {
  const fromLinear = (issue.branchName ?? issue.gitBranchName ?? '').split('/').pop();
  return (fromLinear || issue.identifier.toLowerCase()).slice(0, 60).replace(/-+$/, '');
}

const OPEN = (state) => !['completed', 'canceled', 'duplicate'].includes(state?.type);

// The tasks that block an issue ("blocked by" in Linear) and are still open.
export function openBlockers(issue) {
  return (issue.inverseRelations?.nodes ?? [])
    .filter((r) => r.type === 'blocks' && OPEN(r.issue?.state))
    .map((r) => r.issue.identifier);
}

const labels = (issue) => (issue.labels?.nodes ?? []).map((l) => l.name.toLowerCase());

export function taskRepo(issue) {
  return labels(issue).includes('invoicely-agents') ? 'invoicely-agents' : 'invoicely';
}

export function needsUiCheck(issue) {
  return labels(issue).includes('ui');
}

// The task for the agents: its title and description, with Linear's markup turned back into plain text.
export function taskText(issue) {
  const description = (issue.description ?? '')
    .replace(/<issue [^>]*label="([^"]+)"[^>]*\/>/g, '$1')
    .replace(/<user [^>]*label="([^"]+)"[^>]*\/>/g, '$1')
    .replace(/<pull-request [^>]*label="([^"]+)"[^>]*\/>/g, 'PR "$1"')
    .replace(/^>>>\s*/gm, '')
    .replace(/\\([*_[\]()#>`~-])/g, '$1');
  return `# ${issue.identifier}: ${issue.title}\n\n${description.trim()}\n`;
}

// What to queue for the issues in Ready. Returns { add: [...tasks], wait: [...{ issue, why }] }.
// known: ids already queued or running.
export function planFromReady(readyIssues, known) {
  const add = [];
  const wait = [];
  for (const issue of readyIssues) {
    if (known.has(issue.identifier)) continue;
    const blockers = openBlockers(issue);
    if (blockers.length) {
      wait.push({ issue: issue.identifier, why: `blocked by ${blockers.join(', ')}` });
      continue;
    }
    add.push({
      issue: issue.identifier, title: issue.title, repo: taskRepo(issue), ui: needsUiCheck(issue),
      branch: branchName(issue), text: taskText(issue),
    });
  }
  return { add, wait };
}

// Yoan's answer after the runner's question: his comments newer than the question.
export function answerAfter(comments, yoanId, since) {
  const runner = /^(\[@[^\]]*\]\([^)]*\)\s*)?\*\*(Чака|Готово|Слято|Грешка|Спрян)/;
  const answers = (comments ?? [])
    .filter((c) => c.user?.id === yoanId && Date.parse(c.createdAt) > Date.parse(since) && !runner.test(c.body ?? ''))
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  return answers.length ? answers.map((c) => c.body.trim()).join('\n\n') : null;
}
