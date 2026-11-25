<brief>
<task id="INV-63" role="test-author">
packages/domain/src/vat/purchase-cells.credit-notes.test.ts has a failing test for every acceptance criterion about credit notes and empty periods in the purchase cells.
</task>

<context>
Suppliers send credit notes (кредитни известия) that reduce an earlier purchase. In the purchase ledger a credit note is a line with a negative base and VAT and the same treatment as the invoice it corrects. INV-64 (domain-engineer) makes purchaseCells handle them after your tests are committed.
Contract of the unit under test, packages/domain/src/vat/purchase-cells.ts:
  type PurchaseTreatment = 'full-credit' | 'no-credit'
  interface PurchaseLine { documentNo: string; supplierVat: string; base: Cents; vat: Cents; treatment: PurchaseTreatment }
  interface PurchaseCells { cell30: Cents; cell31: Cents; cell41: Cents }
  function purchaseCells(lines: readonly PurchaseLine[]): PurchaseCells
Cents comes from packages/domain/src/money/money.ts.
</context>

<acceptance_criteria>
1. Given a credit note for a purchase without the right to tax credit, When the cells are computed, Then it reduces cell 30 by its base plus VAT.
2. Given a credit note for a purchase with full tax credit, When the cells are computed, Then it reduces cell 31 by its base and cell 41 by its VAT.
3. Given a period without purchases, When the cells are computed, Then cells 30, 31 and 41 are 0.
4. Given the November 2026 purchase ledger in fixtures/etalons/vat/2026-11-purchases.json, When the cells are computed, Then cells 30, 31 and 41 equal the etalon's expected cells.
</acceptance_criteria>

<scope>
<in>packages/domain/src/vat/purchase-cells.credit-notes.test.ts</in>
<out>packages/domain/src/vat/purchase-cells.ts (INV-64 implements it), fixtures/etalons</out>
</scope>

<constraints>
- Money is integer euro cents; credit notes carry negative amounts.
- The tests are locked once committed.
- Tests use node:test and run with node --test.
</constraints>

<inputs>
fixtures/etalons/vat/2026-11-purchases.json; packages/domain/src/money/money.test.ts for the style of tests in this package.
</inputs>

<done_when>
node --test packages/domain/src/vat/purchase-cells.credit-notes.test.ts runs, and every test fails because purchaseCells does not handle these cases yet.
</done_when>

<stop_if>
An expected value cannot be derived from a criterion or the etalon.
</stop_if>

<report_format>
Summary in at most 10 lines; files changed; checks run with results; open questions, each with a proposed answer.
</report_format>
</brief>
