import { describe, expect, it } from 'vitest';
import etalon from '../../../fixtures/etalons/vat/2026-10/vat-return.json';
import { buildVatReturn } from './vat-return';
import { october2026Documents } from './test-data/october-2026';

describe('buildVatReturn for October 2026', () => {
  it('matches the etalon in every cell', () => {
    expect(buildVatReturn(october2026Documents).cells).toEqual(etalon.cells);
  });

  it('puts the VAT of the 20% supplies in cell 21', () => {
    expect(buildVatReturn(october2026Documents).cells['21']).toBe(248917);
  });
});
