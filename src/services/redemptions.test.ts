import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import { sql } from "drizzle-orm";

import { db, pool } from "@/db/client";
import { generateToken, hashToken } from "@/lib/tokens";
import {
  confirmRedemption,
  findRedemptionByShortCode,
  findRedemptionByToken,
  getRedemptionStatus,
  getRedemptionStatusForSession,
  issueRedemption,
  voidRedemption,
} from "@/services/redemptions";

/*
  Run with: npm test  (needs .env pointed at the seeded development branch)

  A real database on purpose, and here it matters more than anywhere else in the repo. The
  properties being tested are all properties of Postgres — a partial unique index, a guarded UPDATE,
  two transactions racing — and none of them exist in a mocked version. A test suite that stubbed
  the database would assert that our stub hands out one code at a time, which nobody doubted.

  AGENTS.md names this set explicitly: double-scan, expired, wrong venue, already-used, concurrent
  verify. That list is here because it's the set where being wrong costs real money.

  ⚠️ Creates its own member and cleans up after itself. It uses SEEDED venues and deals rather than
  making its own, so it can't drift from the shapes production actually serves.
*/

/* A phone no real person can have — 0700 is not an allocated Romanian mobile prefix, and the seed
   already parks its fixtures there. */
const TEST_PHONE = "+40700009999";

let memberId: string;
/* Two venues, because "scanned at the wrong venue" is one of the cases that has to work. */
let dealA: string;
let venueA: string;
let dealB: string;
let venueB: string;

async function scalar<T>(query: ReturnType<typeof sql>): Promise<T> {
  const result = await db.execute(query);
  const row = result.rows[0] as Record<string, unknown> | undefined;
  assert.ok(row, "expected a row — is the database seeded?");
  return Object.values(row)[0] as T;
}

/* Wipes this member's history so a re-run starts clean. Redemptions are RESTRICT-on-delete against
   members, so they have to go first — which is the constraint doing exactly its job. */
async function resetMember(): Promise<void> {
  await db.execute(sql`DELETE FROM redemptions WHERE member_id = ${memberId}`);
  await db.execute(sql`
    UPDATE members SET trial_started_at = now(), trial_ends_at = now() + interval '14 days'
    WHERE id = ${memberId}
  `);
}

before(async () => {
  memberId = await scalar(sql`
    INSERT INTO members (phone, phone_verified_at, trial_started_at, trial_ends_at)
    VALUES (${TEST_PHONE}, now(), now(), now() + interval '14 days')
    ON CONFLICT (phone) DO UPDATE
      SET trial_started_at = now(), trial_ends_at = now() + interval '14 days'
    RETURNING id
  `);

  const deals = await db.execute(sql`
    SELECT d.id AS deal_id, d.venue_id
    FROM deals d
    JOIN venues v ON v.id = d.venue_id
    WHERE d.is_active AND v.is_published
    ORDER BY d.venue_id
    LIMIT 1
  `);
  const first = deals.rows[0] as { deal_id: string; venue_id: string } | undefined;
  assert.ok(first, "no active deals — is the database seeded?");
  dealA = first.deal_id;
  venueA = first.venue_id;

  const other = await db.execute(sql`
    SELECT d.id AS deal_id, d.venue_id
    FROM deals d
    JOIN venues v ON v.id = d.venue_id
    WHERE d.is_active AND v.is_published AND d.venue_id <> ${venueA}
    LIMIT 1
  `);
  const second = other.rows[0] as { deal_id: string; venue_id: string } | undefined;
  assert.ok(second, "need deals at two different venues");
  dealB = second.deal_id;
  venueB = second.venue_id;

  await resetMember();
});

/* Top-level, not inside a describe — a describe-scoped hook would close the pool while the next
   block still has queries to run. Same reason as hours.test.ts. */
after(async () => {
  await db.execute(sql`DELETE FROM redemptions WHERE member_id = ${memberId}`);
  await db.execute(sql`DELETE FROM member_sessions WHERE member_id = ${memberId}`);
  await db.execute(sql`DELETE FROM members WHERE id = ${memberId}`);
  await pool.end();
});

/* Pulls the raw token back out of the issued url — the plaintext only exists in that string. */
function tokenFrom(url: string): string {
  const token = url.split("/").pop();
  assert.ok(token, "issued url had no token");
  return token;
}

describe("issuing", () => {
  test("a member with an active trial gets a code", async () => {
    await resetMember();
    const result = await issueRedemption(memberId, dealA);

    assert.equal(result.ok, true);
    assert.ok(result.ok);

    /*
      The QR payload is the configured origin plus the token, nothing between them.

      ⚠️ Asserted against REDEEM_BASE_URL rather than a literal, because this string is what gets
      burned into a QR a member is holding up at a counter — a change to its shape strands whatever
      was already on screen, so it should have to be deliberate enough to update a test for.
    */
    const base = process.env.REDEEM_BASE_URL?.replace(/\/+$/, "") ?? "";
    assert.ok(base, "REDEEM_BASE_URL must be set to run this");
    assert.match(result.redemption.url, new RegExp(`^${base}/[A-Za-z0-9_-]{20,}$`));

    assert.match(result.redemption.shortCode, /^[2346789A-HJKMNPQRTUVWXYZ]{6}$/);
  });

  test("no trial is refused, and says so specifically", async () => {
    await resetMember();
    await db.execute(sql`
      UPDATE members SET trial_started_at = NULL, trial_ends_at = NULL WHERE id = ${memberId}
    `);

    const result = await issueRedemption(memberId, dealA);
    assert.equal(result.ok, false);
    /* Not a generic refusal — the app says "începe perioada de probă" to this one and
       "reactivează" to the next, and it can't tell them apart from a single code. */
    assert.equal(result.ok === false && result.reason, "TRIAL_REQUIRED");
  });

  test("an expired trial is refused differently", async () => {
    await resetMember();
    await db.execute(sql`
      UPDATE members SET trial_started_at = now() - interval '30 days',
                         trial_ends_at = now() - interval '1 day'
      WHERE id = ${memberId}
    `);

    const result = await issueRedemption(memberId, dealA);
    assert.equal(result.ok === false && result.reason, "TRIAL_EXPIRED");
  });

  test("a second issue voids the first", async () => {
    await resetMember();
    const first = await issueRedemption(memberId, dealA);
    assert.ok(first.ok);

    const second = await issueRedemption(memberId, dealB);
    assert.ok(second.ok);

    const stale = await getRedemptionStatus(memberId, first.redemption.id);
    assert.equal(stale?.state, "voided");
    /* And the old QR is genuinely dead, not merely marked — someone could still be holding it. */
    const target = await findRedemptionByToken(tokenFrom(first.redemption.url));
    assert.equal(target?.state, "voided");
  });

  /*
    ⚠️ The test the partial unique index exists for.

    Two taps on "Deblochează oferta" 50ms apart is an ordinary event, and without
    redemptions_one_live_per_member both transactions void what they can see and then both insert —
    the member walks away holding two live codes for two venues. The retry loop in issueRedemption
    means one of them re-runs rather than failing, so the visible outcome is two successes and
    exactly one survivor.
  */
  test("two concurrent issues leave exactly one live code", async () => {
    await resetMember();

    const [first, second] = await Promise.all([
      issueRedemption(memberId, dealA),
      issueRedemption(memberId, dealB),
    ]);
    assert.ok(first.ok);
    assert.ok(second.ok);

    const live = await scalar<number>(sql`
      SELECT count(*)::int FROM redemptions
      WHERE member_id = ${memberId} AND consumed_at IS NULL AND voided_at IS NULL
    `);
    assert.equal(live, 1);
  });

  test("the cooldown blocks a repeat and says when", async () => {
    await resetMember();
    const issued = await issueRedemption(memberId, dealA);
    assert.ok(issued.ok);
    await confirmRedemption(issued.redemption.id, venueA);

    const again = await issueRedemption(memberId, dealA);
    assert.equal(again.ok, false);
    assert.equal(again.ok === false && again.reason, "DEAL_ON_COOLDOWN");
    /* The app renders a date from this. A cooldown with no "when" is a dead end on screen. */
    assert.ok(again.ok === false && again.availableAt);
  });

  test("the cooldown is per deal, not per member", async () => {
    await resetMember();
    const issued = await issueRedemption(memberId, dealA);
    assert.ok(issued.ok);
    await confirmRedemption(issued.redemption.id, venueA);

    const other = await issueRedemption(memberId, dealB);
    assert.equal(other.ok, true);
  });
});

describe("confirming", () => {
  test("the happy path marks it used", async () => {
    await resetMember();
    const issued = await issueRedemption(memberId, dealA);
    assert.ok(issued.ok);

    const result = await confirmRedemption(issued.redemption.id, venueA);
    assert.equal(result.ok, true);
    assert.ok(result.ok && result.confirmation.consumedAt);

    const status = await getRedemptionStatus(memberId, issued.redemption.id);
    assert.equal(status?.state, "used");
  });

  /* The whole reason the UPDATE is guarded. A waiter scanning twice because the first tap didn't
     look like it worked is normal, and must not be two discounts. */
  test("a double scan is refused the second time", async () => {
    await resetMember();
    const issued = await issueRedemption(memberId, dealA);
    assert.ok(issued.ok);

    assert.equal((await confirmRedemption(issued.redemption.id, venueA)).ok, true);

    const second = await confirmRedemption(issued.redemption.id, venueA);
    assert.equal(second.ok, false);
    assert.equal(second.ok === false && second.reason, "REDEMPTION_USED");
  });

  /*
    ⚠️ The one AGENTS.md calls out by name: two scans arriving 50ms apart at a busy counter.

    Both transactions read a live row. Only one UPDATE can match `consumed_at IS NULL`, so exactly
    one gets a confirmation and the other is told it's already used. A read-then-write would hand
    out both.
  */
  test("two concurrent confirms produce exactly one success", async () => {
    await resetMember();
    const issued = await issueRedemption(memberId, dealA);
    assert.ok(issued.ok);

    const results = await Promise.all([
      confirmRedemption(issued.redemption.id, venueA),
      confirmRedemption(issued.redemption.id, venueA),
    ]);

    assert.equal(results.filter((r) => r.ok).length, 1);
    assert.equal(results.filter((r) => !r.ok).length, 1);
  });

  /* Scanned next door. Has to be its own answer — "already used" sounds like the member is trying
     it on, and that's the sentence that starts an argument at a counter. */
  test("the wrong venue is refused, and not as 'already used'", async () => {
    await resetMember();
    const issued = await issueRedemption(memberId, dealA);
    assert.ok(issued.ok);

    const result = await confirmRedemption(issued.redemption.id, venueB);
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.reason, "REDEMPTION_WRONG_VENUE");

    /* And it stayed usable at the venue it was actually for. */
    assert.equal((await confirmRedemption(issued.redemption.id, venueA)).ok, true);
  });

  test("an expired code is refused", async () => {
    await resetMember();
    const issued = await issueRedemption(memberId, dealA);
    assert.ok(issued.ok);

    await db.execute(sql`
      UPDATE redemptions SET expires_at = now() - interval '1 minute'
      WHERE id = ${issued.redemption.id}
    `);

    const result = await confirmRedemption(issued.redemption.id, venueA);
    assert.equal(result.ok === false && result.reason, "REDEMPTION_EXPIRED");
  });

  test("a voided code is refused", async () => {
    await resetMember();
    const issued = await issueRedemption(memberId, dealA);
    assert.ok(issued.ok);
    await voidRedemption(memberId, issued.redemption.id);

    const result = await confirmRedemption(issued.redemption.id, venueA);
    assert.equal(result.ok === false && result.reason, "REDEMPTION_VOIDED");
  });

  /* ⚠️ Voiding must never rewrite a redemption that already happened — that's the record a partner
     dispute is settled with. */
  test("voiding cannot undo a confirmed redemption", async () => {
    await resetMember();
    const issued = await issueRedemption(memberId, dealA);
    assert.ok(issued.ok);
    await confirmRedemption(issued.redemption.id, venueA);

    await voidRedemption(memberId, issued.redemption.id);

    const status = await getRedemptionStatus(memberId, issued.redemption.id);
    assert.equal(status?.state, "used");
  });
});

describe("the typed fallback code", () => {
  test("resolves within its own venue", async () => {
    await resetMember();
    const issued = await issueRedemption(memberId, dealA);
    assert.ok(issued.ok);

    const found = await findRedemptionByShortCode(venueA, issued.redemption.shortCode);
    assert.equal(found?.id, issued.redemption.id);
  });

  /* Typed off a screen across a counter, by someone in a hurry. All three have to work. */
  test("is case- and separator-insensitive", async () => {
    await resetMember();
    const issued = await issueRedemption(memberId, dealA);
    assert.ok(issued.ok);

    const code = issued.redemption.shortCode;
    const spaced = `${code.slice(0, 3)}-${code.slice(3)}`;
    const found = await findRedemptionByShortCode(venueA, spaced.toLowerCase());
    assert.equal(found?.id, issued.redemption.id);
  });

  /*
    ⚠️ The property that keeps six characters safe. The code is only meaningful inside the venue it
    was issued for — globally it would be a guessable handle on every live redemption on the
    platform.
  */
  test("does not resolve from another venue", async () => {
    await resetMember();
    const issued = await issueRedemption(memberId, dealA);
    assert.ok(issued.ok);

    const found = await findRedemptionByShortCode(venueB, issued.redemption.shortCode);
    assert.equal(found, null);
  });

  test("stops resolving once used", async () => {
    await resetMember();
    const issued = await issueRedemption(memberId, dealA);
    assert.ok(issued.ok);
    await confirmRedemption(issued.redemption.id, venueA);

    const found = await findRedemptionByShortCode(venueA, issued.redemption.shortCode);
    assert.equal(found, null);
  });
});

/*
  The polled read, which authenticates itself.

  ⚠️ Worth its own block rather than trusting the plain getRedemptionStatus tests above. This is the
  one route that skips requireMember — it does the session check inside its own WHERE clause for
  cost reasons — so "does that check actually hold" is not something any other test covers.
*/
describe("the self-authenticating poll", () => {
  async function openSession(forMemberId: string): Promise<string> {
    const token = generateToken();
    await db.execute(sql`
      INSERT INTO member_sessions (member_id, token_hash, expires_at)
      VALUES (${forMemberId}, ${hashToken(token)}, now() + interval '1 day')
    `);
    return token;
  }

  test("a live session reads its own redemption", async () => {
    await resetMember();
    const issued = await issueRedemption(memberId, dealA);
    assert.ok(issued.ok);

    const token = await openSession(memberId);
    const result = await getRedemptionStatusForSession(token, issued.redemption.id);

    assert.equal(result.session, "valid");
    assert.equal(result.session === "valid" && result.status?.state, "live");
  });

  test("it follows the redemption to used", async () => {
    await resetMember();
    const issued = await issueRedemption(memberId, dealA);
    assert.ok(issued.ok);
    const token = await openSession(memberId);

    await confirmRedemption(issued.redemption.id, venueA);

    const result = await getRedemptionStatusForSession(token, issued.redemption.id);
    assert.equal(result.session === "valid" && result.status?.state, "used");
  });

  /* ⚠️ A dead session must NOT read as "redemption not found". The app signs out on one and shows
     "cod inexistent" on the other, and collapsing them strands a member behind the wrong message. */
  test("an expired session is refused as a session problem, not a missing code", async () => {
    await resetMember();
    const issued = await issueRedemption(memberId, dealA);
    assert.ok(issued.ok);

    const token = await openSession(memberId);
    await db.execute(sql`
      UPDATE member_sessions SET expires_at = now() - interval '1 day'
      WHERE token_hash = ${hashToken(token)}
    `);

    const result = await getRedemptionStatusForSession(token, issued.redemption.id);
    assert.equal(result.session, "invalid");
  });

  test("a token nobody issued is refused", async () => {
    const result = await getRedemptionStatusForSession(generateToken(), crypto.randomUUID());
    assert.equal(result.session, "invalid");
  });

  /*
    ⚠️ THE one that matters. The session check lives in the WHERE clause now, so this is what proves
    it holds — a valid member cannot poll a redemption that isn't theirs, and gets "not found"
    rather than a 401 that would tell them their own session was fine.
  */
  test("a valid session cannot read someone else's redemption", async () => {
    await resetMember();
    const issued = await issueRedemption(memberId, dealA);
    assert.ok(issued.ok);

    const strangerId = await scalar<string>(sql`
      INSERT INTO members (phone, phone_verified_at)
      VALUES ('+40700009998', now())
      ON CONFLICT (phone) DO UPDATE SET updated_at = now()
      RETURNING id
    `);
    const strangerToken = await openSession(strangerId);

    const result = await getRedemptionStatusForSession(strangerToken, issued.redemption.id);
    assert.equal(result.session, "valid");
    assert.equal(result.session === "valid" && result.status, null);

    await db.execute(sql`DELETE FROM member_sessions WHERE member_id = ${strangerId}`);
    await db.execute(sql`DELETE FROM members WHERE id = ${strangerId}`);
  });
});
