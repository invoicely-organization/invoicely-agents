<brief>
<task id="INV-61" role="reviewer">
Review the diff of INV-61: a sales line for services to a business client in another EU state goes to the VAT return cell that bg-vat gives.
</task>

<context>
backend-engineer implemented INV-61 against the tests test-author wrote for it. The task's checks pass: pnpm --filter domain test, pnpm lint, pnpm typecheck. The diff is in diff.patch; the changed files are in this workspace as they are after the change.
</context>

<acceptance_criteria>
- Given a sales invoice for services to a client in Germany with an EU VAT number, When the cells are computed, Then the base goes to cell 17 and there is no tax cell.
- Given a service to a client in the USA, When the cells are computed, Then it stays in cell 18.
- Given a domestic service, When the cells are computed, Then it stays in cells 11 and 21.
</acceptance_criteria>

<scope>
<in>packages/domain/vat/vat-cells.ts; the new test in packages/domain/vat/vat-cells.test.ts, written by test-author for this task</in>
<out>Everything else, including the existing tests, which are locked. Services to clients in the EU without a VAT number are a separate task, INV-63.</out>
</scope>

<constraints>
Money is integer euro cents; arithmetic on money lives only in packages/domain/money.
</constraints>

<inputs>
brief.md, diff.patch, the changed files, the bg-vat skill.
</inputs>
</brief>
