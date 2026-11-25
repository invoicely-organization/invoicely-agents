# How we write agent prompts

Every prompt is code: it lives in this repo and changes only through a PR, like any code. Its evals are run by hand when they help; CI does not run them.

## Three kinds of prompts

| Prompt | Where | Written by | Checked by |
| --- | --- | --- | --- |
| Agent definition | `agents/<agent>.md`, from `templates/agent.md` | a task in Linear, like any code | the reviewer in CI, `claude plugin validate`, evals by hand |
| Session prompt | `factory/prompts/<role>.md` | a task in Linear | the same |
| Task | Linear issue template "Таск": Какво, Как проверявам, Agent notes | Yoan | test-author turns "Как проверявам" into tests |

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
10. The description says exactly when to use the agent, because sessions pick subagents by it.

## Evals

Each agent has eval cases in `evals/<agent>/<case>/`, run with `claude plugin eval`. A case is:

- `case.yaml`: the prompt, the allowed tools, the runs and the graders
- `fixture.sh`: prepares the workspace before the run
- `seed/` (optional): the case's own files, such as a brief or a diff

A new agent starts with at least four cases:

- normal: the everyday task
- edge: a boundary the agent must handle
- misleading: the input tempts the agent to break a rule, e.g. "just make the test pass"
- incomplete: something essential is missing; the agent must ask, not guess

Every mistake found later adds one regression case, named `regression-<what>`, through factory-lesson.

### How a case is built

- The run starts in an empty workspace and cannot read this repo. `fixture.sh` calls `fixtures/eval-workspace/seed.sh` (templates, sample agents, the bg-vat skill, the role guard policy) and then copies the case's `seed/`.
- Grade evidence, not claims: check the files the agent wrote with `file_exists`, `regex` on a file, or `llm` with `focus: {source: file, path: ...}`. Grade the final message only for what has no file, such as a question the agent should ask.
- `file_exists` counts only files the run created; files from the fixture do not count.
- When a grader needs a path, the brief in the prompt names it (for example the name of the regression case).
- Every case has a `dispatched` grader (`tool_used: Agent` with the agent's `subagent_type`), so a run where the main session does the work itself fails.
- Tools that write (Write, Edit, Bash) go in the case's `allowed_tools` and are granted on the command line.

### case.yaml in short

- Top level: `schema_version: "1.0"`, `name` (`<agent>-<case>`), `description`, `tags: [<agent>, <kind>]`, `context.scaffold_script: fixture.sh`, `execution` (`prompt`, `max_turns`, `timeout_seconds`, `allowed_tools`), `runs: 3`, `graders`.
- `tool_used`: `tool`, optional `input_match` (regex on the tool input), `min`, `max`.
- `file_exists`: `path`; counts only files the run created.
- `regex`: `target` (`last_message`, `files` for the list of created paths, or `{source: file, path: ...}`), `pattern`, `flags`, `match` (`contains`, `not_contains`, `count:N`).
- `llm`: `criteria` written as "PASS if ... FAIL if ...", `focus` (`last_message`, `trace`, `files`, or `{source: file, path: ...}`).
- `tool_order`: `before`, `after`.

### Running

```
claude plugin eval . --trust-plugin --scaffold --allow-tools Write Edit --ablation none --tag <agent>
```

Use `--runs 1` while writing a case and the case's own `runs` (3) before merge. An agent passes when its critical cases score 1.0 and the rest 0.8 or more.

## Changing a prompt

1. A Linear task (label invoicely-agents) that describes the wrong behaviour and links the run or ledger entry.
2. The task goes through the process like any other: test-author, implementer, the reviewer in CI.
3. Run the agent's evals by hand (the command above) when the change is about its behaviour.
