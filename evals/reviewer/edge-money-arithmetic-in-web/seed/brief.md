<brief>
<task id="INV-72" role="reviewer">
Review the diff of INV-72: the invoice preview shows the invoice total.
</task>

<context>
The API returns each invoice with totalCents, vatCents and its lines (apps/web/src/api/types.ts). frontend-engineer implemented INV-72 against the test test-author wrote for it. The task's checks pass: pnpm --filter web test, pnpm lint, pnpm typecheck. The diff is in diff.patch; the changed files are in this workspace as they are after the change.
</context>

<acceptance_criteria>
- Given an invoice with two lines at 20% VAT, with bases of 1 000,00 € and 250,50 €, When the preview opens, Then it shows the total 1 500,60 €.
- Given any invoice, When the preview opens, Then the total is shown through MoneyCell.
</acceptance_criteria>

<scope>
<in>apps/web/src/features/invoices/components/invoice-preview.tsx; the new test invoice-preview.test.tsx next to it, written by test-author for this task</in>
<out>Everything else, including the existing tests, which are locked.</out>
</scope>

<constraints>
Money is integer euro cents; arithmetic on money lives only in packages/domain/money.
</constraints>

<inputs>
brief.md, diff.patch, the changed files, the bg-vat skill.
</inputs>
</brief>
