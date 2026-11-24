import { isEuCountry } from './countries';
import type { VatCells, VatLine } from './types';

// Maps one sales document line to the cells of the VAT return (see the bg-vat skill).
export function cellsFor(line: VatLine): VatCells {
  if (line.treatment === 'exempt') {
    return { base: 19 };
  }
  const otherEuState = line.clientCountry !== 'BG' && isEuCountry(line.clientCountry);
  if (line.kind === 'goods' && otherEuState && line.clientVatNumber !== null) {
    return { base: 15 };
  }
  if (line.kind === 'goods' && !isEuCountry(line.clientCountry)) {
    return { base: 14 };
  }
  if (line.kind === 'service' && otherEuState && line.clientVatNumber !== null) {
    return { base: 17 };
  }
  if (line.kind === 'service' && !isEuCountry(line.clientCountry)) {
    return { base: 18 };
  }
  return { base: 11, tax: 21 };
}
