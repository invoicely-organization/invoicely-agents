// Linear as the "go" button (INV-45): what the runner takes from Linear, as pure functions.
// A task in Ready with a brief goes into the queue; a feature in Ready brings all its open subtasks, each with the
// feature branch as base and its blockers among them as dependencies. Yoan's answer to a question resumes the session.

// The <brief> block from the "Agent notes" of a Linear description, with Linear's markup turned back into plain text.
export function extractBrief(description) {
  const match = /<brief>[\s\S]*?<\/brief>/.exec(description ?? '');
  if (!match) return null;
  return match[0]
    .replace(/<issue [^>]*label="([^"]+)"[^>]*\/>/g, '$1')
    .replace(/<user [^>]*label="([^"]+)"[^>]*\/>/g, '$1')
    .replace(/\\([*_[\]()#>`~-])/g, '$1')
    .replace(/\n {2}<\//g, '\n</');
}

export function briefRole(brief) {
  return /<task[^>]*\brole="([^"]+)"/.exec(brief ?? '')?.[1] ?? null;
}

// Linear's branch name without the user prefix: "yoansvdimitrov/inv-45-runner-t-vzima" becomes "inv-45-runner-t-vzima".
export function branchName(issue) {
  const fromLinear = (issue.gitBranchName ?? '').split('/').pop();
  return (fromLinear || issue.identifier.toLowerCase()).slice(0, 60).replace(/-+$/, '');
}

const OPEN = (state) => !['completed', 'canceled', 'duplicate'].includes(state?.type);

// Blockers of an issue: the issues that "block" it, still open.
export function openBlockers(issue) {
  return (issue.inverseRelations?.nodes ?? [])
    .filter((r) => r.type === 'blocks' && OPEN(r.issue?.state))
    .map((r) => r.issue.identifier);
}

// What to queue for the issues Yoan put in Ready. Returns { add: [...tasks], ask: [...{ issue, why }] }.
// known: task ids already in the queue or already running, which are left alone.
export function planFromReady(readyIssues, known, briefPath) {
  const add = [];
  const ask = [];
  const take = (issue, base, siblings) => {
    if (known.has(issue.identifier) || add.some((t) => t.issue === issue.identifier)) return;
    const brief = extractBrief(issue.description);
    if (!brief) return ask.push({ issue: issue.identifier, why: 'няма бриф (Agent notes с <brief>)' });
    if (briefRole(brief) !== 'prompt-engineer') {
      return ask.push({ issue: issue.identifier, why: `ролята "${briefRole(brief) ?? 'няма'}" още не се пуска от runner-а; засега само prompt-engineer задачи в invoicely-agents` });
    }
    const deps = openBlockers(issue).filter((id) => siblings.has(id));
    add.push({ issue: issue.identifier, branch: branchName(issue), brief: briefPath(issue.identifier), briefText: brief, base, ...(deps.length ? { dependsOn: deps } : {}) });
  };
  for (const issue of readyIssues) {
    const children = (issue.children?.nodes ?? []).filter((c) => OPEN(c.state));
    if (children.length) {
      const siblings = new Set(children.map((c) => c.identifier));
      for (const child of children) take(child, `feature/${issue.identifier}`, siblings);
    } else {
      take(issue, issue.parent ? `feature/${issue.parent.identifier}` : 'main', new Set());
    }
  }
  return { add, ask };
}

// Yoan's answer after the agent's question: his comments newer than the question, not written by the runner.
export function answerAfter(comments, yoanId, since) {
  const runner = /^(\[@[^\]]*\]\([^)]*\)\s*)?\*\*(Чака|Готово|Слято|Грешка|Спрян)/;
  const answers = (comments ?? [])
    .filter((c) => c.user?.id === yoanId && Date.parse(c.createdAt) > Date.parse(since) && !runner.test(c.body ?? ''))
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  return answers.length ? answers.map((c) => c.body.trim()).join('\n\n') : null;
}
