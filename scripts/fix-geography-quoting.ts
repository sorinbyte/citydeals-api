import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/*
  Post-processes generated migrations to unquote PostGIS geography types.

  Why this exists: drizzle-kit decides whether to quote a column type by checking it against a
  hardcoded allowlist of native Postgres types (see `parseType` in drizzle-kit's bundle). `geometry`
  is on that list; `geography` is not. So a geography column comes out as

      "location" "geography(Point, 4326)" NOT NULL

  which is invalid — Postgres goes looking for a type literally named `geography(Point, 4326)` and
  errors. There's no config flag for it, so we fix the output instead.

  Runs as part of `npm run db:generate`, not by hand, because the failure mode is "migration blows
  up at deploy time" and nobody remembers a manual step for that.

  If drizzle-kit ever adds geography to its allowlist this becomes a no-op and can be deleted —
  it only rewrites lines that actually match.
*/
const MIGRATIONS_DIR = join(process.cwd(), "drizzle");

// only ever touches a quoted geography type, nothing else in the file
const QUOTED_GEOGRAPHY = /"(geography\([^"]*\))"/g;

let patched = 0;

for (const file of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql"))) {
  const path = join(MIGRATIONS_DIR, file);
  const before = readFileSync(path, "utf8");
  const after = before.replace(QUOTED_GEOGRAPHY, "$1");

  if (after !== before) {
    writeFileSync(path, after);
    console.log(`unquoted geography type in ${file}`);
    patched += 1;
  }
}

if (patched === 0) console.log("no geography quoting to fix");
