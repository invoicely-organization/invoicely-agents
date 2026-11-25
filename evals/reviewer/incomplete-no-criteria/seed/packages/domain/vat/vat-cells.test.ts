import { describe, expect, it } from 'vitest';
import { cellsFor } from './vat-cells';
import type { VatLine } from './types';

const line = (overrides: Partial<VatLine>): VatLine => ({
  kind: 'service',
  treatment: 'taxable',
  clientCountry: 'BG',
  clientVatNumber: 'BG204871390',
  baseCents: 120000,
  ...overrides,
});

describe('cellsFor', () => {
  it('puts a domestic service in cells 11 and 21', () => {
    expect(cellsFor(line({}))).toEqual({ base: 11, tax: 21 });
  });

  it('puts goods to a business client in another EU state in cell 15', () => {
    expect(cellsFor(line({ kind: 'goods', clientCountry: 'DE', clientVatNumber: 'DE811569869' }))).toEqual({ base: 15 });
  });

  it('puts goods exported outside the EU in cell 14', () => {
    expect(cellsFor(line({ kind: 'goods', clientCountry: 'US', clientVatNumber: null }))).toEqual({ base: 14 });
  });

  it('puts a service to a client outside the EU in cell 18', () => {
    expect(cellsFor(line({ clientCountry: 'US', clientVatNumber: null }))).toEqual({ base: 18 });
  });

  it('puts a service to a business client in another EU state in cell 17', () => {
    expect(cellsFor(line({ clientCountry: 'DE', clientVatNumber: 'DE811569869' }))).toEqual({ base: 17 });
  });

  it('puts an exempt supply in cell 19', () => {
    expect(cellsFor(line({ treatment: 'exempt' }))).toEqual({ base: 19 });
  });
});
