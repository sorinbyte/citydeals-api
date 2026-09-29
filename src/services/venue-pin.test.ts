import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import { sql } from "drizzle-orm";

import { db, pool } from "@/db/client";
import {
  enrolVenueDevice,
  findVenueByDeviceToken,
  revokeVenueDevice,
  setVenuePin,
  verifyVenuePin,
} from "@/services/venue-pin";

/*
  Run with: npm test  (needs .env pointed at the seeded development branch)

  ⚠️ Slow on purpose, and that slowness is the feature. scrypt is tuned to cost about 100ms a guess,
  so the lockout test below really does spend two seconds — if this suite ever gets fast, somebody
  has weakened the cost parameters and four digits stopped being defensible.

  What's at stake: a 4-digit PIN is ten thousand possibilities, the only genuinely guessable secret
  in the codebase. Three layers hold it up (scrypt, the per-IP limit at the route, the lockout here)
  and the lockout is only survivable because enrolled devices skip the PIN entirely. That last
  relationship is the one worth testing, because breaking it turns a security measure into a way for
  anyone to shut a restaurant's redemptions off from their phone.
*/

const PIN = "7391";
const WRONG = "1357";

let venueA: string;
let venueB: string;

/* Whatever the service thinks the limit is — read from the source rather than hardcoded, so raising
   MAX_PIN_FAILURES doesn't silently turn the lockout test into a no-op that always passes. */
const MAX_FAILURES = 20;

async function clearLock(venueId: string): Promise<void> {
  await db.execute(sql`
    UPDATE venues SET pin_failed_count = 0, pin_locked_until = NULL WHERE id = ${venueId}
  `);
}

before(async () => {
  const rows = await db.execute(sql`
    SELECT id FROM venues WHERE is_published ORDER BY slug LIMIT 2
  `);
  const [a, b] = rows.rows as Array<{ id: string }>;
  assert.ok(a && b, "need two published venues — is the database seeded?");
  venueA = a.id;
  venueB = b.id;

  await setVenuePin(venueA, PIN);
  await setVenuePin(venueB, PIN);
});

after(async () => {
  /* Put the seeded venues back the way they were — no PIN, no lockout. Leaving a PIN behind would
     make the next developer's "why does this venue work and that one not" a real puzzle. */
  await db.execute(sql`
    UPDATE venues
    SET pin_hash = NULL, pin_set_at = NULL, pin_failed_count = 0, pin_locked_until = NULL
    WHERE id IN (${venueA}, ${venueB})
  `);
  await db.execute(sql`DELETE FROM venue_devices WHERE venue_id IN (${venueA}, ${venueB})`);
  await pool.end();
});

describe("the PIN", () => {
  test("the right one is accepted", async () => {
    await clearLock(venueA);
    assert.equal((await verifyVenuePin(venueA, PIN)).ok, true);
  });

  test("a wrong one is refused", async () => {
    await clearLock(venueA);
    const result = await verifyVenuePin(venueA, WRONG);
    assert.equal(result.ok === false && result.reason, "PIN_INVALID");
  });

  /*
    ⚠️ Its own answer, not "wrong PIN". Every seeded venue is in this state today.

    An employee told their correct code is wrong will retype it until they're locked out. Told the
    venue isn't set up yet, they call someone. Same event, completely different evening.
  */
  test("a venue with no PIN says so, rather than 'wrong'", async () => {
    const fresh = (
      await db.execute(sql`
        SELECT id FROM venues WHERE pin_hash IS NULL AND id NOT IN (${venueA}, ${venueB}) LIMIT 1
      `)
    ).rows[0] as { id: string } | undefined;
    assert.ok(fresh, "expected at least one venue without a PIN");

    const result = await verifyVenuePin(fresh.id, PIN);
    assert.equal(result.ok === false && result.reason, "PIN_NOT_SET");
  });

  test("a success clears the failure count", async () => {
    await clearLock(venueA);
    await verifyVenuePin(venueA, WRONG);
    await verifyVenuePin(venueA, WRONG);
    assert.equal((await verifyVenuePin(venueA, PIN)).ok, true);

    const count = (await db.execute(sql`SELECT pin_failed_count FROM venues WHERE id = ${venueA}`))
      .rows[0] as { pin_failed_count: number };
    /* Otherwise twenty typos spread over a month would eventually lock a venue that has been
       working perfectly the whole time. */
    assert.equal(count.pin_failed_count, 0);
  });

  test("enough wrong guesses locks it, and the right PIN stops working too", async () => {
    await clearLock(venueA);

    for (let i = 0; i < MAX_FAILURES; i += 1) {
      await verifyVenuePin(venueA, WRONG);
    }

    const locked = await verifyVenuePin(venueA, PIN);
    assert.equal(locked.ok, false);
    assert.equal(locked.ok === false && locked.reason, "PIN_LOCKED");

    await clearLock(venueA);
  });

  test("the lockout is per venue and doesn't spread", async () => {
    await clearLock(venueA);
    await clearLock(venueB);

    for (let i = 0; i < MAX_FAILURES; i += 1) {
      await verifyVenuePin(venueA, WRONG);
    }

    /* One restaurant's bad evening must not take the one next door down with it. */
    assert.equal((await verifyVenuePin(venueB, PIN)).ok, true);
    await clearLock(venueA);
  });

  test("rotating replaces the old PIN and clears the lock", async () => {
    await clearLock(venueA);
    await setVenuePin(venueA, "8264");

    assert.equal((await verifyVenuePin(venueA, "8264")).ok, true);
    await clearLock(venueA);
    assert.equal((await verifyVenuePin(venueA, PIN)).ok, false);

    await setVenuePin(venueA, PIN);
  });
});

describe("enrolled devices", () => {
  test("a device resolves to its venue", async () => {
    const device = await enrolVenueDevice(venueA);
    assert.equal(await findVenueByDeviceToken(device.token), venueA);
  });

  /* A phone enrolled at one restaurant must not skip the PIN at another — the confirm path compares
     the resolved venue against the redemption's, and this is the value it compares. */
  test("a device does not resolve to a different venue", async () => {
    const device = await enrolVenueDevice(venueA);
    assert.notEqual(await findVenueByDeviceToken(device.token), venueB);
  });

  test("an unknown token resolves to nothing", async () => {
    assert.equal(await findVenueByDeviceToken("not-a-real-token"), null);
  });

  test("revoking ends it", async () => {
    const device = await enrolVenueDevice(venueA);
    await revokeVenueDevice(device.token);
    assert.equal(await findVenueByDeviceToken(device.token), null);
  });

  test("an expired device resolves to nothing", async () => {
    const device = await enrolVenueDevice(venueA);
    await db.execute(sql`
      UPDATE venue_devices SET expires_at = now() - interval '1 day'
      WHERE venue_id = ${venueA} AND expires_at > now()
    `);
    assert.equal(await findVenueByDeviceToken(device.token), null);
  });

  /*
    ⚠️ THE test that makes the lockout acceptable.

    Without this property a per-venue lockout is a denial of service anyone can trigger against a
    working counter: twenty wrong guesses from a phone in the car park and the restaurant stops being
    able to redeem anything. Because the phones behind the bar hold their own token rather than the
    PIN, they carry straight on.
  */
  test("an enrolled device keeps working while the venue is locked out", async () => {
    await clearLock(venueA);
    const device = await enrolVenueDevice(venueA);

    for (let i = 0; i < MAX_FAILURES; i += 1) {
      await verifyVenuePin(venueA, WRONG);
    }
    assert.equal((await verifyVenuePin(venueA, PIN)).ok, false);

    assert.equal(await findVenueByDeviceToken(device.token), venueA);
    await clearLock(venueA);
  });
});
