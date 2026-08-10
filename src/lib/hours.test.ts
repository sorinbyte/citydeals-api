import assert from "node:assert/strict";
import { after, describe, test } from "node:test";

import { sql } from "drizzle-orm";

import { db, pool } from "@/db/client";
import { isOpenNow, localTimeContext, todayHours } from "@/lib/hours";
import type { OpeningWindow } from "@/types/api";

/*
  Run with: npm test  (needs .env pointed at the seeded development branch)

  This talks to a real database on purpose. The logic being tested IS SQL — a version with the
  database mocked out would assert that our mock behaves like our mock.

  What's actually at stake: seeded restaurants close at 01:00 on Fri/Sat, so a row saying
  "Friday 10:00–01:00" has to read as open at 00:30 on SATURDAY. Every naive implementation gets
  this wrong, and it's wrong only between midnight and closing, which is exactly when nobody is
  looking. Hence the test.
*/

async function isOpenAt(slug: string, timestamp: string): Promise<boolean> {
  const result = await db.execute(sql`
    SELECT ${isOpenNow} AS is_open
    FROM venues v, ${localTimeContext(timestamp)}
    WHERE v.slug = ${slug}
  `);
  const row = result.rows[0] as { is_open: boolean } | undefined;
  assert.ok(row, `no venue with slug ${slug} — is the database seeded?`);
  return row.is_open;
}

/* Top-level, not inside a describe — a describe-scoped hook would close the pool while the next
   block still has queries to run. */
after(async () => {
  await pool.end();
});

describe("isOpenNow", () => {
  // Trattoria: Mon–Thu 10:00–23:00, Fri–Sat 10:00–01:00, Sun 11:00–22:00
  const restaurant = "trattoria-bucureseana";

  test("open during an ordinary weekday window", async () => {
    assert.equal(await isOpenAt(restaurant, "2026-08-05 15:00"), true);
  });

  test("closed before opening", async () => {
    assert.equal(await isOpenAt(restaurant, "2026-08-05 09:00"), false);
  });

  test("closed after a same-day close", async () => {
    assert.equal(await isOpenAt(restaurant, "2026-08-05 23:30"), false);
  });

  test("open late on a night that runs past midnight", async () => {
    assert.equal(await isOpenAt(restaurant, "2026-08-07 23:30"), true);
  });

  // The one that matters: Saturday 00:30 is covered by FRIDAY's row, not Saturday's.
  test("open after midnight, on the previous day's row", async () => {
    assert.equal(await isOpenAt(restaurant, "2026-08-08 00:30"), true);
  });

  test("closed after the post-midnight close", async () => {
    assert.equal(await isOpenAt(restaurant, "2026-08-08 02:00"), false);
  });

  // Sunday closes at 22:00 and doesn't cross midnight, so Monday 00:30 must NOT inherit it.
  test("does not leak a non-crossing window into the next day", async () => {
    assert.equal(await isOpenAt(restaurant, "2026-08-10 00:30"), false);
  });

  test("respects a later opening time on Sundays", async () => {
    assert.equal(await isOpenAt(restaurant, "2026-08-09 10:30"), false);
    assert.equal(await isOpenAt(restaurant, "2026-08-09 11:30"), true);
  });

  // Barber: Mon–Fri 09:00–20:00, Sat 09:00–16:00, closed Sunday entirely.
  test("closed on a day with no hours at all", async () => {
    assert.equal(await isOpenAt("barber-shop-centrul-vechi", "2026-08-09 12:00"), false);
  });
});

async function hoursOn(slug: string, timestamp: string): Promise<OpeningWindow[]> {
  const result = await db.execute(sql`
    SELECT ${todayHours} AS hours
    FROM venues v, ${localTimeContext(timestamp)}
    WHERE v.slug = ${slug}
  `);
  const row = result.rows[0] as { hours: OpeningWindow[] } | undefined;
  assert.ok(row, `no venue with slug ${slug} — is the database seeded?`);
  return row.hours;
}

/*
  What the detail screen prints under "open now". Only ever the calendar day's own rows — the
  after-midnight case below is the one that would tempt an implementation to be clever, and it
  deliberately isn't.
*/
describe("todayHours", () => {
  const restaurant = "trattoria-bucureseana";

  test("returns the day's window as HH:MM", async () => {
    assert.deepEqual(await hoursOn(restaurant, "2026-08-05 15:00"), [
      { opensAt: "10:00", closesAt: "23:00" },
    ]);
  });

  test("keeps a window that runs past midnight as stored", async () => {
    assert.deepEqual(await hoursOn(restaurant, "2026-08-07 23:30"), [
      { opensAt: "10:00", closesAt: "01:00" },
    ]);
  });

  /*
    00:30 Saturday: isOpenNow says true off FRIDAY's row, but the hours line is about Saturday and
    says so. The two disagreeing here is the design, not a bug — see the note in hours.ts.
  */
  test("shows the new day's hours after midnight, not the window still running", async () => {
    assert.equal(await isOpenAt(restaurant, "2026-08-08 00:30"), true);
    assert.deepEqual(await hoursOn(restaurant, "2026-08-08 00:30"), [
      { opensAt: "10:00", closesAt: "01:00" },
    ]);
  });

  test("empty on a day the venue never opens", async () => {
    assert.deepEqual(await hoursOn("barber-shop-centrul-vechi", "2026-08-09 12:00"), []);
  });
});
