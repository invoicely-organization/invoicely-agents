# invoicely-agents

The agents, domain skills, templates and evals that build Invoicely. The product repo `invoicely` uses this repo as a Claude Code plugin.

## Layout

- `agents/`: one definition per agent, written from `templates/agent.md`
- `skills/`: domain skills (bg-vat, kontirane, ...)
- `templates/`: `agent.md`, `brief.md` and `AUTHORING.md`
- `evals/`: eval cases per agent, run with `claude plugin eval` (see `templates/AUTHORING.md`)
- `fixtures/eval-workspace/`: the workspace every eval case starts from
- `policies/role-guard.yaml`: the paths each agent may write; the role guard hook enforces it
- `hooks/`: guards that run wherever the plugin is enabled. The role guard lets a subagent write only its paths from `policies/role-guard.yaml`: through Write and Edit it is stopped before the write, through Bash it cannot finish until it puts the files back (SubagentStop). Two subagents working at the same time in one working copy cannot be told apart, so agents that write code run in separate worktrees. The main guard stops a push to main, force push, `--no-verify`, merging or approving a PR and changes to branch protection, for agents and the main session alike. Tests: `node --test hooks/test/*.test.mjs`

- CI (`.github/workflows/ci.yml`): `claude plugin validate`, the hook tests and the factory tests on every PR; the evals of the changed agents when the `CLAUDE_CODE_OAUTH_TOKEN` secret is set; the whole eval suite every Monday

- `factory/`: the runner for agent sessions on the Mac (`node factory/factory.mjs`). One queue, one session per task, a spending cap per run (`--max-budget-usd`), a night window (22:00 to 08:00) unless `--now`, automatic resume after the usage limit resets, a run ledger in `~/.invoicely/ledger/runs.jsonl` and a summary comment in Linear when `LINEAR_API_KEY` is in `~/.invoicely/.env`. The plugin loads from a separate copy (`plugin-runtime`), because Claude Code refuses edits to a loaded plugin's files. Tests: `node --test factory/test/*.test.mjs`
- GitHub identity of the agents: the sessions commit, push and open PRs as `invoicely-agent-bot[bot]`, a GitHub App installed on `invoicely` and `invoicely-agents` (Contents and Pull requests write; Checks, Commit statuses and Actions read; no Workflows, no Administration). The runner needs `githubApp` (`appId`, `installationId`, `slug`, `botUserId`) in `~/.invoicely/config.json` and the key in `~/.invoicely/github-app.pem`; tokens live one hour and are renewed while a session runs (`factory/github-app.mjs`). Without them the sessions act as Yoan. Check on the Mac: `node factory/smoke-github-app.mjs`.
- `.github/CODEOWNERS`: Yoan owns everything, so a PR from the bot needs his review.

## Rules

- Changes only through a PR: prompt-engineer writes, the evals pass, Yoan approves.
- Agents working on the product never edit this repo.
- Prompts are written in English; agents talk to Yoan in Bulgarian.
