<!--
Template for a brief from the orchestrator to a subagent.
The subagent sees only this brief and nothing from the orchestrator's conversation, so the brief must stand on its own.
Copy the acceptance criteria verbatim from the Linear task; never paraphrase them.
-->
<brief>
<task id="<INV-123>" role="<agent name>">
<One sentence: what must be true when this is done.>
</task>

<context>
<Why this task exists, in 2 to 4 sentences. Link the spec section and the ADRs (Linear documents). What earlier tasks produced that this one builds on.>
</context>

<acceptance_criteria>
<Given, When, Then lines, copied verbatim from the task.>
</acceptance_criteria>

<scope>
<in><Files and modules this task may change.></in>
<out><What must not change, even if it looks wrong; report it instead.></out>
</scope>

<constraints>
<The rules that matter for this task, e.g. tests are locked; money is integer cents; no new dependency without an ADR.>
</constraints>

<inputs>
<Exact files and Linear documents to read first.>
</inputs>

<done_when>
<Commands that must pass, e.g. pnpm --filter api test; pnpm lint; pnpm typecheck.>
</done_when>

<stop_if>
<When to stop and report instead of guessing, e.g. a criterion contradicts the spec; a locked test looks wrong.>
</stop_if>

<report_format>
Summary in at most 10 lines; files changed; checks run with results; open questions, each with a proposed answer.
</report_format>
</brief>
