# invoicely-agents

The agents, domain skills, templates and evals that build Invoicely. The product repo uses this repo as a Claude Code plugin.

- `agents/`: one definition per agent, written from `templates/agent.md`
- `skills/`: domain skills
- `evals/<agent>/<case>/`: eval cases (`case.yaml`, `fixture.sh`, optional `seed/`); see `templates/AUTHORING.md`
- `policies/role-guard.yaml`: the paths each agent may write; the role guard hook enforces it
- `templates/`: `agent.md`, `brief.md` and `AUTHORING.md`

Changes only through a PR: prompt-engineer writes, the evals pass, Yoan approves.
