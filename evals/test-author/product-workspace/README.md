# invoicely

Invoicely, a Bulgarian accounting and invoicing platform. This is a trimmed copy of the product repo that the test-author eval cases start from.

- `packages/domain`: pure domain logic (money, VAT). Tests sit next to the code as `*.test.ts` and use `node:test`; run them with `node --test` (Node 22.18 or later strips the types, so import types with `import type`).
- `fixtures/etalons`: reference results prepared by Konstantin, the accountant. Only he changes them.
- Money is integer euro cents. There is no lev anywhere.
