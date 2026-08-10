import { sql } from "drizzle-orm";
import { timestamp, uuid } from "drizzle-orm/pg-core";

/*
  Column shapes every table in here repeats. Lived as private copies in catalogue.ts and menu.ts
  until the identity tables arrived and were about to make it four.

  Not a "utils" dump — these two are the house rules for how a row is identified and dated, and
  they belong somewhere a new table author will find them.
*/

/*
  uuidv7() is built into Postgres 18 (Neon is on 18). Time-ordered, so it indexes far better than
  v4 — random uuids scatter writes across the whole btree. If this ever runs on <18 it fails loudly
  at migration time rather than silently handing out v4s, which is what we want.
*/
export const id = () => uuid("id").primaryKey().default(sql`uuidv7()`);

/*
  timestamptz, always. AGENTS.md: store UTC, clients convert to Europe/Bucharest for display.

  Note `updatedAt` only defaults — nothing here bumps it on UPDATE. That's a trigger or an explicit
  set in the service, and it's worth knowing before you trust the column.
*/
export const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
};
