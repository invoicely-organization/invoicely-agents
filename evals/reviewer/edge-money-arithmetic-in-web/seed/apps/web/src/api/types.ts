export type InvoiceLine = { description: string; baseCents: number; vatRateBp: number };

export type Invoice = {
  id: string;
  number: string;
  totalCents: number; // base plus VAT, from the API
  vatCents: number;
  lines: InvoiceLine[];
};
