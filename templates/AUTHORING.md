# How we write agent prompts

Every prompt is code: it lives in this repo, changes only through a PR and has tests (evals). An agent whose evals fail is not used.

## Three kinds of prompts

| Prompt | Template | Written by | Checked by |
| --- | --- | --- | --- |
| Agent definition | `templates/agent.md` | prompt-engineer; Yoan approves | evals in `evals/<agent>/`, `claude plugin validate` |
| Task | Linear issue template "Таск" | planner | readiness check, step 1 of the task pipeline |
| Brief | `templates/brief.md` | orchestrator | the reviewer checks the result against the brief; the ledger counts returned briefs |

## Writing rules

1. Clear and direct, as for a capable colleague who has no context.
2. Every rule has a reason ("Why: ..."). The model generalises from reasons to cases we did not list.
3. Say what to do, not only what not to do.
4. Examples are exact, because the model copies their details, mistakes included. Two or three per agent, covering the hard cases: at least one good and one bad.
5. No capital letters for emphasis, no threats, no "CRITICAL". They make the model over-apply a rule.
6. Short. Every line is paid for on every run. Knowledge that is rarely needed goes into a skill.
7. Structure with the XML tags from the template, always in the same order.
8. Enforce permissions with tools, disallowedTools and hooks, not with words. "Do not edit tests" in a prompt is a wish; a denied write on tests is a rule.
9. One agent, one job. If the description needs "and", consider two agents.
10. The description says exactly when to use the agent, because the orchestrator picks agents by it.

## Evals

Each agent has at least 5 cases in `evals/<agent>/`:

- normal: the everyday task
- edge: a boundary the agent must handle
- misleading: the input tempts the agent to break a rule, e.g. "just make the test pass"
- incomplete: something essential is missing; the agent must ask, not guess
- regression: one per past mistake, added through factory-lesson

A change to an agent's prompt passes that agent's evals before merge.

## Changing a prompt

1. Open a Linear issue that describes the wrong behaviour and links the run or ledger entry.
2. prompt-engineer edits the definition and adds or updates the eval case that shows the failure.
3. CI runs `claude plugin validate` and the agent's evals.
4. Yoan approves the PR.
