/*
  Helpers for reading the raw rows `db.execute` hands back.

  ⚠️ These queries bypass drizzle's typed query builder — services/venues.ts explains why — which
  also means they bypass its type conversion. What comes back is whatever node-postgres made of the
  wire format, and for timestamps that is a STRING.
*/

/*
  A timestamptz out of `db.execute`, as a Date.

  Worth a helper rather than a cast because the cast is what bit: annotating a row as
  `{ expires_at: Date }` compiles perfectly and then throws "toISOString is not a function" at
  runtime, in the caller, well away from the query that produced it.
*/
export function toDate(value: unknown): Date {
  if (value instanceof Date) return value;
  if (typeof value === "string") return new Date(value);
  throw new Error(`expected a timestamp, got ${typeof value}`);
}
