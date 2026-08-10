import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";

/*
  Run with `npm run db:migrate`. Uses DIRECT_URL for the same reason drizzle.config.ts does —
  DDL through PgBouncer's transaction pooling misbehaves.

  Forward-only. Never edit a migration that's already run anywhere; write a new one.
*/
const connectionString = process.env.DIRECT_URL;
if (!connectionString) {
  throw new Error("DIRECT_URL is not set — copy .env.example to .env and fill it in");
}

const pool = new Pool({ connectionString, connectionTimeoutMillis: 30_000, max: 1 });

try {
  // PostGIS has to exist before the venues table can declare a geography column. Idempotent, and
  // cheaper than remembering to click it in the Neon console for every new branch.
  await pool.query("CREATE EXTENSION IF NOT EXISTS postgis");

  /*
    unaccent is what makes venue search usable in Romanian. Without it, typing "bucuresteana"
    doesn't find "Trattoria Bucuresteană" — nobody hunts for ă/ș/ț on a phone keyboard, so folding
    diacritics is the difference between search working and search looking broken.

    Here rather than in a .sql migration for the same reason postgis is: extensions aren't schema
    objects drizzle tracks, and IF NOT EXISTS makes it safe to re-run on every branch.
  */
  await pool.query("CREATE EXTENSION IF NOT EXISTS unaccent");

  await migrate(drizzle(pool), { migrationsFolder: "./drizzle" });
  console.log("migrations applied");
} finally {
  await pool.end();
}
