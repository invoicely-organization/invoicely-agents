<brief>
<task id="INV-62" role="reviewer">
Review the diff of INV-62: a sales line for services to a client outside the EU goes to the VAT return cell that bg-vat gives, without Bulgarian VAT.
</task>

<context>
Until now, services to clients outside the EU went to cells 11 and 21 with 20% VAT. backend-engineer implemented INV-62 against the tests test-author wrote for it. The task's checks pass: pnpm --filter domain test, pnpm lint, pnpm typecheck. The diff is in diff.patch; the changed files are in this workspace as they are after the change.
</context>

<acceptance_criteria>
- Given a sales invoice for consulting services to a client in the USA, When the cells are computed, Then the base goes to the cell bg-vat gives for services with place of supply outside the EU, and there is no tax cell.
- Given a service to a client in Germany with an EU VAT number, When the cells are computed, Then it stays in cell 17.
- Given a domestic service, When the cells are computed, Then it stays in cells 11 and 21.
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
