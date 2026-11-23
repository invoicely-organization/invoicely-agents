---
name: bg-vat
description: Bulgarian VAT rules for Invoicely, including which cells of the VAT return and which ledger columns each VAT treatment goes to. Use when generating, checking or explaining VAT ledgers and the VAT return.
---

# Cells of the VAT return

| Cell | Meaning |
| --- | --- |
| 11, 21 | taxable supplies at 20%: base, tax |
| 12, 22 | intra-EU acquisitions and received supplies where the recipient owes the tax (protocol under art. 117): base, tax |
| 14 | 0% supplies under chapter three (export) |
| 15 | intra-EU supplies of goods |
| 17 | services with place of supply in another EU state (art. 21(2)) |
| 18 | supplies under art. 69(2), including services with place of supply outside the EU |
| 19 | exempt supplies |
| 30 | purchases without the right to tax credit |
| 31, 41 | purchases with full tax credit: base, tax |

The cell comes from the VAT treatment of each document line: basis, the client's country and VAT status.
