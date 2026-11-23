# invoicely-agents

The agents, domain skills, templates and evals that build Invoicely. The product repo `invoicely` uses this repo as a Claude Code plugin.

## Layout

- `agents/`: one definition per agent, written from `templates/agent.md`
- `skills/`: domain skills (bg-vat, kontirane, ...)
- `templates/`: `agent.md`, `brief.md` and `AUTHORING.md`
- `evals/`: eval cases per agent, run with `claude plugin eval` (see `templates/AUTHORING.md`)
- `fixtures/eval-workspace/`: the workspace every eval case starts from
- `policies/role-guard.yaml`: the paths each agent may write; the role guard hook enforces it
- `hooks/`: guards that run wherever the plugin is enabled. The role guard lets a subagent write only its paths from `policies/role-guard.yaml`. The main guard stops a push to main, force push, `--no-verify`, merging or approving a PR and changes to branch protection, for agents and the main session alike. Tests: `node --test hooks/test/*.test.mjs`

- CI (`.github/workflows/ci.yml`): `claude plugin validate` and the hook tests on every PR; the evals of the changed agents when the `CLAUDE_CODE_OAUTH_TOKEN` secret is set; the whole eval suite every Monday

## Rules

- Changes only through a PR: prompt-engineer writes, the evals pass, Yoan approves.
- Agents working on the product never edit this repo.
- Prompts are written in English; agents talk to Yoan in Bulgarian.
