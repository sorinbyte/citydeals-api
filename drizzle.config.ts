import { defineConfig } from "drizzle-kit";

/*
  Migrations go through DIRECT_URL, not the pooled one. Neon's pooled endpoint is PgBouncer in
  transaction mode, which doesn't hold the session state DDL needs — schema changes through it
  fail in confusing, intermittent ways rather than cleanly.
*/
// Not asserted here on purpose: `drizzle-kit generate` diffs against the snapshot in ./drizzle and
// never opens a connection, so it has to work with no .env at all. The commands that DO connect
// (push, studio) fail loudly by themselves if this is empty.
const url = process.env.DIRECT_URL ?? "";

export default defineConfig({
  schema: "./src/db/schema/index.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: { url },
  // keeps generated SQL readable, which matters because we review migrations before they run
  verbose: true,
  strict: true,
});
