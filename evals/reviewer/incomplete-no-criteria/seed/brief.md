<brief>
<task id="INV-70" role="reviewer">
Review the diff of INV-70: intra-EU supplies of goods in the VAT return.
</task>

<context>
backend-engineer implemented INV-70 against the tests test-author wrote for it. The task's checks pass: pnpm --filter domain test, pnpm lint, pnpm typecheck. The diff is in diff.patch; the changed files are in this workspace as they are after the change.
</context>

<acceptance_criteria>
See the Linear task INV-70.
</acceptance_criteria>

<scope>
<in>packages/domain/vat/vat-cells.ts; the new test in packages/domain/vat/vat-cells.test.ts, written by test-author for this task</in>
<out>Everything else, including the existing tests, which are locked.</out>
</scope>

<constraints>
Money is integer euro cents; arithmetic on money lives only in packages/domain/money.
</constraints>

<inputs>
brief.md, diff.patch, the changed files, the bg-vat skill.
</inputs>
</brief>
