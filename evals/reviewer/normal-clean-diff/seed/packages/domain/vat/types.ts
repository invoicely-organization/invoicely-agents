export type VatLine = {
  kind: 'goods' | 'service';
  treatment: 'taxable' | 'exempt';
  clientCountry: string; // ISO 3166-1 alpha-2, e.g. 'BG', 'DE', 'US'
  clientVatNumber: string | null;
  baseCents: number;
};

export type VatCells = { base: number; tax?: number };
