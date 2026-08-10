import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import * as schema from "@/db/schema";

/*
  Plain node-postgres over TCP, not Neon's HTTP driver.

  That's on purpose and it's the constraint that matters: the HTTP driver can't hold a transaction
  open across statements, and redemption needs SELECT … FOR UPDATE followed by an UPDATE inside one
  transaction. If we ever move this to Cloudflare Workers, this file is the thing that changes —
  everything above it stays put.

  Where the API is hosted is still undecided (AGENTS.md). Nothing outside this file depends on it.
*/
const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL is not set — copy .env.example to .env and fill it in");
}

export const pool = new Pool({
  connectionString,
  // Neon scales compute to zero; a cold start can take a couple of seconds on the first hit
  connectionTimeoutMillis: 10_000,
  // small on purpose — we're behind Neon's pooler already, so a big local pool just holds
  // connections open against a compute that would rather sleep
  max: 10,
});

export const db = drizzle(pool, { schema });

export type Db = typeof db;
