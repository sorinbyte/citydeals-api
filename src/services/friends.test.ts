import assert from "node:assert/strict";
import { after, beforeEach, describe, test } from "node:test";

import { sql } from "drizzle-orm";

import { db, pool } from "@/db/client";
import { follow, listFollowing, matchContacts, unfollow } from "@/services/friends";

/*
  Run with: npm test  (needs .env pointed at the seeded development branch, migrated to 0014)

  Real database, same as referrals.test.ts. Three members on 0700 numbers (not an allocated mobile
  prefix); follows cascade with the members, so deleting the members is the whole reset.
*/

const ME = "+40700008881";
const BOBBY = "+40700008882";
const TEO = "+40700008883";
const PHONES = [ME, BOBBY, TEO];

async function reset(): Promise<void> {
  await db.execute(sql`DELETE FROM members WHERE phone IN (${sql.join(PHONES, sql`, `)})`);
}

async function member(phone: string, name: string | null = null): Promise<string> {
  const result = await db.execute(sql`
    INSERT INTO members (phone, phone_verified_at, name) VALUES (${phone}, now(), ${name})
    RETURNING id
  `);
  return (result.rows[0] as { id: string }).id;
}

beforeEach(reset);

after(async () => {
  await reset();
  await pool.end();
});

describe("matching contacts", () => {
  test("any way the number is written, echoed back exactly as sent", async () => {
    const me = await member(ME);
    const bobby = await member(BOBBY);

    const matches = await matchContacts(me, ["0700 008 882", "+40 700 008 882", "0040700008882"]);
    assert.deepEqual(
      matches.map((m) => m.phone).sort(),
      ["+40 700 008 882", "0040700008882", "0700 008 882"].sort(),
    );
    assert.ok(matches.every((m) => m.memberId === bobby && !m.following));
  });

  test("never matches yourself, skips non-members and junk", async () => {
    const me = await member(ME);
    const matches = await matchContacts(me, [ME, "0700008889", "112", "not a number"]);
    assert.deepEqual(matches, []);
  });

  test("says when you already follow them", async () => {
    const me = await member(ME);
    const bobby = await member(BOBBY);
    await follow(me, [bobby]);

    const [match] = await matchContacts(me, [BOBBY]);
    assert.equal(match?.following, true);
  });
});

describe("following", () => {
  test("idempotent, never yourself, newest first, names shortened", async () => {
    const me = await member(ME);
    const bobby = await member(BOBBY, "Bobby Ionescu");
    const teo = await member(TEO, "Teo");

    await follow(me, [bobby, me]);
    await follow(me, [bobby, teo]);

    const following = await listFollowing(me);
    assert.equal(following.length, 2);
    assert.deepEqual(following.map((f) => f.name).sort(), ["Bobby I.", "Teo"]);
  });

  test("unfollow removes it, twice is fine", async () => {
    const me = await member(ME);
    const bobby = await member(BOBBY);
    await follow(me, [bobby]);

    await unfollow(me, bobby);
    await unfollow(me, bobby);
    assert.deepEqual(await listFollowing(me), []);
  });
});
