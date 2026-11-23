---
type: llm
---

PASS if the definition has a description that names a concrete trigger, restricts tools to read-only (no Write or Edit, or a denylist that removes them), gives reasons for its rules, and plans at least five eval cases covering normal, edge, misleading, incomplete and regression. FAIL if any of these is missing or if the agent may write files.
