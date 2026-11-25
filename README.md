# invoicely-agents

The agents, hooks, review workflow and runner that build Invoicely. How we work is the Linear document "Процесът" (project M0); the map and the rules for Claude are in `CLAUDE.md`; the idea is in `HANDOFF.md`.

## The process (INV-64)

1. Yoan moves a task to Ready in Linear. The runner takes it, unless a task that blocks it is still open.
2. test-author writes the tests from the task's "Как проверявам" in its own session; the runner commits them. The implementer, in another session, writes the code until they pass; the runner commits, pushes and opens the PR to main as the bot. A test the implementer calls wrong goes back to test-author with the reason.
3. The review job in CI runs the reviewer agent, which writes a GitHub review, inline where it can.
4. Findings or a red CI: the implementer fixes them in the same PR and the reviewer looks again; after 3 rounds the task goes to "Чака Йоан" with the question.
5. Reviewer PASS and green CI: the runner merges.
6. The runner writes the summary into the task (what was done, the PR, what the review caught, the cost). A task labelled `UI` goes to "Чака Йоан" for Yoan's check, the others to Done.

A task labelled `invoicely-agents` is worked on in this repo, any other in `invoicely`. An exhausted Max limit is not a failure anywhere: the step waits and runs again after the reset.

## Layout

- `agents/`: `test-author`, `implementer`, `reviewer`, written from `templates/agent.md`
- `factory/`: the runner (`node factory/factory.mjs`), its session prompts in `factory/prompts/`, its tests in `factory/test/`
- `policies/role-guard.yaml`: what each agent may write. test-author writes tests only, the implementer everything but tests, the reviewer nothing; `fixtures/etalons/` is locked for all
- `hooks/`: secret-guard (no agent reads secrets), role-guard and change-audit (the policy, by the runner's `INVOICELY_ROLE` or a subagent's type), main-guard (no push to main, force push, merge or approval by an agent), copy-guard (task copies are the runner's), action-log. The runner also checks every session's diff against the policy
- `scripts/review-pr.mjs`: the review job; `scripts/run-evals.mjs` and `scripts/eval-cost.mjs`: evals by hand
- `.github/workflows/ci.yml`: plugin validation and the hook and factory tests, a secret scan, and the review; `review.yml`: the shared review job, which `invoicely` calls too
- `skills/bg-vat/`: the VAT return cells, for the reviewer
- `evals/`, `fixtures/eval-workspace/`: eval cases per agent, run by hand (see `templates/AUTHORING.md`); CI does not run them
- `templates/`: `agent.md` and `AUTHORING.md`

## On the Mac

- State in `~/.invoicely`: `queue.json`, `ledger/runs.jsonl`, `logs/`, `briefs/` (the task text the agents got), `plugin/` (the plugin's own copy at origin/main, because Claude Code refuses edits to a loaded plugin's files). Secrets: `.env` (Linear app), `github-app.pem`, `cache/`, `gh-bot/`.
- `config.json`: `githubApp` (`appId`, `installationId`, `slug`, `botUserId`), optional `budgetUsd` (the cap per task, default 15) and `nodeBin`.
- The service: `node factory/factory.mjs service install` (launchd, `com.invoicely.runner`, log in `~/.invoicely/logs/runner.log`). `factory status`, `factory pause [--wait]`, `factory resume`.
- The sessions run in Claude Code's sandbox (`factory/sandbox.json`) with no GitHub identity; the runner pushes, opens PRs and merges as `invoicely-agent-bot[bot]`.

## GitHub

- Both repos: main needs a PR and no approval. invoicely-agents requires "validate and hook tests" and "secret scan".
- The review job needs the `CLAUDE_CODE_OAUTH_TOKEN` secret (the Max token) in each repo.
- Changes to `.github/workflows` are pushed from Yoan's account: the bot has no Workflows permission.
