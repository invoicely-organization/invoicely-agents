import type { Cents } from '../money/money.ts';

export type PurchaseTreatment = 'full-credit' | 'no-credit';

export interface PurchaseLine {
  documentNo: string;
  supplierVat: string;
  base: Cents;
  vat: Cents;
  treatment: PurchaseTreatment;
}

export interface PurchaseCells {
  cell30: Cents;
  cell31: Cents;
  cell41: Cents;
}

export function purchaseCells(lines: readonly PurchaseLine[]): PurchaseCells {
  const cells: PurchaseCells = { cell30: 0, cell31: 0, cell41: 0 };
  for (const line of lines) {
    if (line.treatment === 'no-credit') {
      cells.cell30 += line.base;
    } else {
      cells.cell31 += line.base;
      cells.cell41 += line.vat;
    }
  }
  return cells;
}
