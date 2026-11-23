# invoicely-agents

The agents, domain skills, templates and evals that build Invoicely. The product repo `invoicely` uses this repo as a Claude Code plugin.

## Layout

- `agents/`: one definition per agent, written from `templates/agent.md`
- `skills/`: domain skills (bg-vat, kontirane, ...)
- `templates/`: `agent.md`, `brief.md` and `AUTHORING.md`
- `evals/`: eval cases per agent, run with `claude plugin eval`

## Rules

- Changes only through a PR: prompt-engineer writes, the evals pass, Yoan approves.
- Agents working on the product never edit this repo.
- Prompts are written in English; agents talk to Yoan in Bulgarian.
