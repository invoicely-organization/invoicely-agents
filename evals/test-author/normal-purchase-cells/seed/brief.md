<brief>
<task id="INV-58" role="test-author">
packages/domain/src/vat/purchase-cells.test.ts has a failing test for every acceptance criterion of the purchase cells of the VAT return.
</task>

<context>
The VAT return (справка-декларация по ЗДДС) needs cells 30, 31 and 41 from the purchase ledger. INV-59 (domain-engineer) implements purchaseCells after your tests are committed.
Contract of the unit under test, packages/domain/src/vat/purchase-cells.ts:
  type PurchaseTreatment = 'full-credit' | 'no-credit'
  interface PurchaseLine { documentNo: string; supplierVat: string; base: Cents; vat: Cents; treatment: PurchaseTreatment }
  interface PurchaseCells { cell30: Cents; cell31: Cents; cell41: Cents }
  function purchaseCells(lines: readonly PurchaseLine[]): PurchaseCells
Cents comes from packages/domain/src/money/money.ts.
</context>

<acceptance_criteria>
1. Given a purchase without the right to tax credit with a base of 40000 and VAT of 8000, When the cells are computed, Then cell 30 is 48000 and cells 31 and 41 are 0.
2. Given a purchase with full tax credit, When the cells are computed, Then its base goes to cell 31 and its VAT to cell 41.
3. Given the October 2026 purchase ledger in fixtures/etalons/vat/2026-10-purchases.json, When the cells are computed, Then cells 30, 31 and 41 equal the etalon's expected cells.
</acceptance_criteria>

<scope>
<in>packages/domain/src/vat/purchase-cells.test.ts</in>
<out>packages/domain/src/vat/purchase-cells.ts (INV-59 implements it), fixtures/etalons</out>
</scope>

<constraints>
- Money is integer euro cents.
- The tests are locked once committed.
- Tests use node:test and run with node --test.
</constraints>

<inputs>
fixtures/etalons/vat/2026-10-purchases.json; packages/domain/src/money/money.test.ts for the style of tests in this package.
</inputs>

<done_when>
node --test packages/domain/src/vat/purchase-cells.test.ts runs, and every test fails because purchaseCells is not implemented yet.
</done_when>

<stop_if>
An expected value cannot be derived from a criterion or the etalon.
</stop_if>

<report_format>
Summary in at most 10 lines; files changed; checks run with results; open questions, each with a proposed answer.
</report_format>
</brief>
