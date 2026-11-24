/** Money is integer euro cents everywhere in Invoicely. */
export type Cents = number;

export function assertCents(value: number): Cents {
  if (!Number.isInteger(value)) throw new Error(`not integer cents: ${value}`);
  return value;
}

export function sumCents(values: readonly Cents[]): Cents {
  return values.reduce((total, value) => total + assertCents(value), 0);
}
