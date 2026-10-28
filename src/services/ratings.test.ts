import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, describe, test } from "node:test";

import { sql } from "drizzle-orm";

import { db, pool } from "@/db/client";
import { getPendingRating, rateRedemption, skipRating } from "@/services/ratings";

/*
  Run with: npm test  (needs .env pointed at the seeded development branch, migrated to 0015)

  Real database, like the other service tests. Redemptions are inserted directly rather than issued
  and confirmed — the issue/confirm path has its own tests, and here only consumed_at matters.
  Uses a seeded deal, so it can't drift from real shapes.
*/

const ME = "+40700007771";
const OTHER = "+40700007772";

let me: string;
let other: string;
let dealId: string;
let venueId: string;

async function reset(): Promise<void> {
  await db.execute(sql`
    DELETE FROM redemption_ratings WHERE member_id IN (SELECT id FROM members WHERE phone IN (${ME}, ${OTHER}))
  `);
  await db.execute(sql`
    DELETE FROM redemptions WHERE member_id IN (SELECT id FROM members WHERE phone IN (${ME}, ${OTHER}))
  `);
}

async function member(phone: string): Promise<string> {
  const result = await db.execute(sql`
    INSERT INTO members (phone, phone_verified_at) VALUES (${phone}, now())
    ON CONFLICT (phone) DO UPDATE SET updated_at = now()
    RETURNING id
  `);
  return (result.rows[0] as { id: string }).id;
}

/* A redemption, consumed `daysAgo` days ago — or never, with null. */
async function redemption(memberId: string, daysAgo: number | null): Promise<string> {
  const consumed = daysAgo === null ? null : sql`now() - ${daysAgo} * interval '1 day'`;
  const result = await db.execute(sql`
    INSERT INTO redemptions
      (member_id, venue_id, deal_id, token_hash, short_code_hash, expires_at, consumed_at, voided_at)
    VALUES (
      ${memberId}, ${venueId}, ${dealId}, ${randomUUID()}, ${randomUUID()},
      now() + interval '15 minutes',
      ${consumed ?? sql`NULL`},
      ${daysAgo === null ? sql`now()` : sql`NULL`}
    )
    RETURNING id
  `);
  return (result.rows[0] as { id: string }).id;
}

before(async () => {
  me = await member(ME);
  other = await member(OTHER);
  const deals = await db.execute(sql`
    SELECT d.id, d.venue_id FROM deals d JOIN venues v ON v.id = d.venue_id
    WHERE d.is_active AND v.is_published LIMIT 1
  `);
  const row = deals.rows[0] as { id: string; venue_id: string } | undefined;
  assert.ok(row, "no active deals — is the database seeded?");
  dealId = row.id;
  venueId = row.venue_id;
});

beforeEach(reset);

after(async () => {
  await reset();
  await db.execute(sql`DELETE FROM members WHERE phone IN (${ME}, ${OTHER})`);
  await pool.end();
});

describe("rating", () => {
  test("a used offer can be rated, and re-rating corrects it", async () => {
    const id = await redemption(me, 0);
    assert.equal(await rateRedemption(me, id, 4, null), "ok");
    assert.equal(await rateRedemption(me, id, 5, "Foarte bun"), "ok");

    const rows = await db.execute(
      sql`SELECT stars, comment FROM redemption_ratings WHERE redemption_id = ${id}`,
    );
    assert.deepEqual(rows.rows, [{ stars: 5, comment: "Foarte bun" }]);
  });

  test("not someone else's, and not a code that was never used", async () => {
    const theirs = await redemption(other, 0);
    const voided = await redemption(me, null);
    assert.equal(await rateRedemption(me, theirs, 5, null), "not_found");
    assert.equal(await rateRedemption(me, voided, 5, null), "not_found");
  });

  test("skipping never overwrites a real rating", async () => {
    const id = await redemption(me, 0);
    await rateRedemption(me, id, 3, null);
    assert.equal(await skipRating(me, id), "ok");

    const rows = await db.execute(
      sql`SELECT stars FROM redemption_ratings WHERE redemption_id = ${id}`,
    );
    assert.deepEqual(rows.rows, [{ stars: 3 }]);
  });
});

describe("the second ask", () => {
  test("the latest unrated visit is pending, until it's rated or skipped", async () => {
    const id = await redemption(me, 1);
    assert.equal((await getPendingRating(me))?.redemptionId, id);

    await skipRating(me, id);
    assert.equal(await getPendingRating(me), null);
  });

  test("only the latest — an older unrated visit isn't dug up", async () => {
    await redemption(me, 3);
    const latest = await redemption(me, 1);
    await rateRedemption(me, latest, 5, null);
    assert.equal(await getPendingRating(me), null);
  });

  test("too old to ask about", async () => {
    await redemption(me, 8);
    assert.equal(await getPendingRating(me), null);
  });
});
