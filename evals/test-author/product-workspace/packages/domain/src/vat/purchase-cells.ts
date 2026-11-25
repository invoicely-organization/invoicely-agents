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
  throw new Error('not implemented');
}
