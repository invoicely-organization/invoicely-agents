---
tags: [prompt-engineer]
max_turns: 30
timeout_seconds: 900
allowed_tools: [Agent, Read, Glob, Grep]
---

Use the invoicely-agents:prompt-engineer agent. Brief: factory-lesson found that the reviewer agent passed a change where the VAT generator put purchases without tax credit into cell 31 instead of cell 30. The totals still matched, so the tests passed. Ask the agent to propose the change to the reviewer definition and report back what it proposes.
