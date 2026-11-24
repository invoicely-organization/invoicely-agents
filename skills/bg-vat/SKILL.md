---
name: bg-vat
description: The cells of the Bulgarian VAT return and which VAT treatment goes to each. Use when writing, testing or reviewing code, tests or etalons that put a document line into a VAT return cell. First version (cells only).
---

# bg-vat, first version

This is a first version, made from Konstantin's table of 18.11.2026 (section 2). It covers only the cells of the VAT return listed below. INV-17 completes it with the rest of the VAT rules.

## Cells of the VAT return

| Cell | Meaning |
| --- | --- |
| 11, 21 | taxable supplies at 20%: base, tax |
| 12, 22 | intra-EU acquisitions and received supplies where the recipient owes the tax (protocol under art. 117): base, tax |
| 14 | 0% supplies under chapter three (export) |
| 15 | intra-EU supplies of goods |
| 17 | services with place of supply in another EU state (art. 21(2)), to a business client in the EU |
| 18 | supplies under art. 69(2), including services with place of supply outside the EU (client outside the EU) |
| 19 | exempt supplies |
| 30 | purchases without the right to tax credit (base plus tax) |
| 31, 41 | purchases with full tax credit: base, tax |

## Using the table

- Pick the row from the VAT treatment of each document line: goods or services, the client's country, and whether the client is a business in the EU. Why: the same amount goes to different cells for a client in Germany and a client in the USA.
- Cite a cell as the row it comes from, for example "cell 18: services with place of supply outside the EU (client outside the EU)". Why: the row is the rule a finding or a test refers to.
- When no row fits a line, or two rows seem to fit, ask through the orchestrator instead of picking a cell; Yoan decides and Konstantin confirms. Why: this version is incomplete, and a guessed cell goes into the VAT return.
