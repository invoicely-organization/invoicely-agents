import { MoneyCell } from '@/components/money-cell';
import { texts } from '@/texts';
import type { Invoice } from '@/api/types';
import { InvoiceLines } from './invoice-lines';

type Props = { invoice: Invoice };

export function InvoicePreview({ invoice }: Props) {
  const totalCents = invoice.lines.reduce(
    (sum, line) => sum + line.baseCents + Math.round((line.baseCents * line.vatRateBp) / 10000),
    0,
  );

  return (
    <section>
      <h2>
        {texts.invoice} № {invoice.number}
      </h2>
      <InvoiceLines lines={invoice.lines} />
      <p>
        {texts.total}: <MoneyCell amountCents={totalCents} currency="EUR" />
      </p>
    </section>
  );
}
