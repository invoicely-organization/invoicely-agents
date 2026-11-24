import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { Invoice } from '@/api/types';
import { InvoicePreview } from './invoice-preview';

const invoice: Invoice = {
  id: 'inv_01JD7Q',
  number: '0000000412',
  totalCents: 150060,
  vatCents: 25010,
  lines: [
    { description: 'Счетоводно обслужване, октомври 2026', baseCents: 100000, vatRateBp: 2000 },
    { description: 'Подаване на справка-декларация по ЗДДС', baseCents: 25050, vatRateBp: 2000 },
  ],
};

describe('InvoicePreview', () => {
  it('shows the invoice total', () => {
    render(<InvoicePreview invoice={invoice} />);
    expect(screen.getByText('1 500,60 €')).toBeInTheDocument();
  });
});
