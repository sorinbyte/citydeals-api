import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";

import { sql } from "drizzle-orm";

import { db, pool } from "@/db/client";
import { addFavourite, listFavouriteIds, removeFavourite } from "@/services/favourites";
import { listFavouriteVenues } from "@/services/venues";

/*
  Run with: npm test  (needs .env pointed at the seeded development branch)

  A real database, like the rest of the suite. Two of these are properties of Postgres rather than
  of our code — the ON CONFLICT that makes saving idempotent, and the CASCADE that takes favourites
  with a deleted member — and neither exists in a mocked version.
*/

const TEST_PHONE = "+40700009997";

let memberId: string;
let venueA: string;
let venueB: string;
let venueC: string;

async function scalar<T>(query: ReturnType<typeof sql>): Promise<T> {
  const result = await db.execute(query);
  const row = result.rows[0] as Record<string, unknown> | undefined;
  assert.ok(row, "expected a row — is the database seeded?");
  return Object.values(row)[0] as T;
}

before(async () => {
  memberId = await scalar(sql`
    INSERT INTO members (phone, phone_verified_at)
    VALUES (${TEST_PHONE}, now())
    ON CONFLICT (phone) DO UPDATE SET updated_at = now()
    RETURNING id
  `);

  const venues = await db.execute(sql`
    SELECT id FROM venues WHERE is_published ORDER BY slug LIMIT 3
  `);
  const [a, b, c] = venues.rows as Array<{ id: string }>;
  assert.ok(a && b && c, "need three published venues — is the database seeded?");
  venueA = a.id;
  venueB = b.id;
  venueC = c.id;
});

beforeEach(async () => {
  await db.execute(sql`DELETE FROM member_favourites WHERE member_id = ${memberId}`);
});

after(async () => {
  await db.execute(sql`DELETE FROM member_favourites WHERE member_id = ${memberId}`);
  await db.execute(sql`DELETE FROM members WHERE id = ${memberId}`);
  await pool.end();
});

describe("saving and unsaving", () => {
  test("a venue can be saved", async () => {
    assert.equal(await addFavourite(memberId, venueA), true);
    assert.deepEqual(await listFavouriteIds(memberId), [venueA]);
  });

  /*
    ⚠️ The ON CONFLICT path, and the reason the endpoint is a PUT.

    The heart is optimistic, so a double tap on bad wifi genuinely sends this twice. It has to be a
    no-op rather than a duplicate row or an error the client then has to interpret as success.
  */
  test("saving twice is a no-op, not an error", async () => {
    assert.equal(await addFavourite(memberId, venueA), true);
    assert.equal(await addFavourite(memberId, venueA), true);

    assert.equal((await listFavouriteIds(memberId)).length, 1);
  });

  test("removing twice is a no-op", async () => {
    await addFavourite(memberId, venueA);
    await removeFavourite(memberId, venueA);
    await removeFavourite(memberId, venueA);

    assert.deepEqual(await listFavouriteIds(memberId), []);
  });

  test("removing something never saved is a no-op", async () => {
    await removeFavourite(memberId, venueA);
    assert.deepEqual(await listFavouriteIds(memberId), []);
  });

  test("a venue that doesn't exist is refused", async () => {
    assert.equal(await addFavourite(memberId, "019ff0c5-0000-0000-0000-000000000000"), false);
  });

  /* An unpublished venue can't be saved in the first place — otherwise the heart fills, saves
     nothing, and stays hollow on the next load with nothing to explain it. */
  test("an unpublished venue is refused", async () => {
    await db.execute(sql`UPDATE venues SET is_published = false WHERE id = ${venueA}`);
    try {
      assert.equal(await addFavourite(memberId, venueA), false);
    } finally {
      await db.execute(sql`UPDATE venues SET is_published = true WHERE id = ${venueA}`);
    }
  });
});

describe("the list", () => {
  test("is newest first", async () => {
    await addFavourite(memberId, venueA);
    await addFavourite(memberId, venueB);
    await addFavourite(memberId, venueC);

    const page = await listFavouriteVenues({ memberId, page: 1 });
    assert.deepEqual(
      page.items.map((v) => v.id),
      [venueC, venueB, venueA],
    );
  });

  test("carries the same VenueSummary shape as every other list", async () => {
    await addFavourite(memberId, venueA);

    const page = await listFavouriteVenues({ memberId, page: 1 });
    const venue = page.items[0];
    assert.ok(venue);
    /* topDeals in particular — a favourites row renders the same card as a search result, so a
       missing field here is a card that silently loses its pills on one screen only. */
    assert.ok(Array.isArray(venue.topDeals));
    assert.equal(typeof venue.isOpen, "boolean");
    assert.ok("image" in venue && "area" in venue && "slug" in venue);
  });

  /*
    ⚠️ THE pagination trap, and the reason the count carries the same filter as the page query.

    If `total` counted rows the page query then filters out, totalPages describes a list nobody can
    see and page 2 is a gap. Exactly what `perPage` produced once already — see the note in
    listVenues.
  */
  test("an unpublished venue leaves both the page AND the total", async () => {
    await addFavourite(memberId, venueA);
    await addFavourite(memberId, venueB);

    await db.execute(sql`UPDATE venues SET is_published = false WHERE id = ${venueA}`);
    try {
      const page = await listFavouriteVenues({ memberId, page: 1 });
      assert.deepEqual(
        page.items.map((v) => v.id),
        [venueB],
      );
      assert.equal(page.total, 1);
      assert.equal(page.totalPages, 1);
    } finally {
      await db.execute(sql`UPDATE venues SET is_published = true WHERE id = ${venueA}`);
    }
  });

  /* The row survives an unpublish rather than being deleted, so pulling a venue temporarily
     doesn't quietly destroy favourites nobody can rebuild. */
  test("a favourite survives its venue being unpublished and comes back", async () => {
    await addFavourite(memberId, venueA);

    await db.execute(sql`UPDATE venues SET is_published = false WHERE id = ${venueA}`);
    assert.equal((await listFavouriteVenues({ memberId, page: 1 })).total, 0);

    await db.execute(sql`UPDATE venues SET is_published = true WHERE id = ${venueA}`);
    assert.equal((await listFavouriteVenues({ memberId, page: 1 })).total, 1);
  });

  test("pages", async () => {
    await addFavourite(memberId, venueA);
    await addFavourite(memberId, venueB);
    await addFavourite(memberId, venueC);

    const first = await listFavouriteVenues({ memberId, page: 1, perPage: 2 });
    assert.equal(first.items.length, 2);
    assert.equal(first.totalPages, 2);

    const second = await listFavouriteVenues({ memberId, page: 2, perPage: 2 });
    assert.equal(second.items.length, 1);
    /* No overlap — an OFFSET without a fully-determined ORDER BY returns the same row on two
       pages, and created_at plus the composite key is what makes this stable. */
    assert.equal(
      first.items.some((v) => v.id === second.items[0]?.id),
      false,
    );
  });

  /* The ids list is what the hearts everywhere else read, so it must NOT be a page. */
  test("ids returns everything, not just the first page", async () => {
    await addFavourite(memberId, venueA);
    await addFavourite(memberId, venueB);
    await addFavourite(memberId, venueC);

    assert.equal((await listFavouriteIds(memberId)).length, 3);
  });
});

/* ⚠️ The CASCADE, which is the opposite of what redemptions does. A favourite is a preference with
   no dispute to settle later, so deleting a member takes it along — and a redemption, being
   evidence, refuses the delete instead. */
test("deleting a member takes their favourites with them", async () => {
  const throwaway = await scalar<string>(sql`
    INSERT INTO members (phone, phone_verified_at) VALUES ('+40700009996', now())
    ON CONFLICT (phone) DO UPDATE SET updated_at = now()
    RETURNING id
  `);
  await addFavourite(throwaway, venueA);

  await db.execute(sql`DELETE FROM members WHERE id = ${throwaway}`);

  const left = await scalar<number>(sql`
    SELECT count(*)::int FROM member_favourites WHERE member_id = ${throwaway}
  `);
  assert.equal(left, 0);
});
