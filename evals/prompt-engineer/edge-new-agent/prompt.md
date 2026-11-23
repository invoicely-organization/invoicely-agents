---
tags: [prompt-engineer]
max_turns: 30
timeout_seconds: 900
allowed_tools: [Agent, Read, Glob, Grep]
---

Use the invoicely-agents:prompt-engineer agent. Brief: we need a new agent, vat-explainer, that answers accountants' questions about how a document is treated for VAT, citing the bg-vat skill. It must not change any data. Ask the agent for the definition and the eval plan, and report back.
