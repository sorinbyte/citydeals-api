import assert from "node:assert/strict";
import { after, beforeEach, describe, test } from "node:test";

import { sql } from "drizzle-orm";

import { db, pool } from "@/db/client";
import { getReferralSummary, normaliseCode, redeemReferralCode } from "@/services/referrals";

/*
  Run with: npm test  (needs .env pointed at the seeded development branch, migrated to 0013)

  Real database for the same reason as redemptions.test.ts — the rules are a unique index, a row
  lock and date arithmetic in SQL, and a mock would only test the mock.

  Three members on 0700 numbers (not an allocated mobile prefix): an inviter and two friends.
  Everything they own is wiped before each test, referrals first because they RESTRICT the delete.
*/

const INVITER_PHONE = "+40700009991";
const FRIEND_PHONE = "+40700009992";
const OTHER_PHONE = "+40700009993";
/* Stand-ins for twelve earlier friends, for the yearly-cap case. */
const CAP_PHONES = Array.from({ length: 12 }, (_, i) => `+407000098${String(i).padStart(2, "0")}`);
const PHONES = [INVITER_PHONE, FRIEND_PHONE, OTHER_PHONE, ...CAP_PHONES];
const LINK_BASE = "https://example.test";

async function reset(): Promise<void> {
  await db.execute(sql`
    DELETE FROM referrals r USING members m
    WHERE m.phone IN (${sql.join(PHONES, sql`, `)})
      AND (r.inviter_member_id = m.id OR r.invitee_member_id = m.id)
  `);
  await db.execute(sql`DELETE FROM members WHERE phone IN (${sql.join(PHONES, sql`, `)})`);
}

/* A fresh member with no trial. `daysOld` backdates created_at for the redeem-window cases. */
async function member(phone: string, daysOld = 0): Promise<string> {
  const result = await db.execute(sql`
    INSERT INTO members (phone, phone_verified_at, created_at)
    VALUES (${phone}, now(), now() - ${daysOld} * interval '1 day')
    RETURNING id
  `);
  return (result.rows[0] as { id: string }).id;
}

/* Days from now until the trial ends, rounded — enough precision for "a month got added". */
async function trialDaysLeft(memberId: string): Promise<number | null> {
  const result = await db.execute(sql`
    SELECT round(extract(epoch FROM trial_ends_at - now()) / 86400)::int AS days
    FROM members WHERE id = ${memberId}
  `);
  return (result.rows[0] as { days: number | null }).days;
}

async function codeOf(memberId: string): Promise<string> {
  const summary = await getReferralSummary(memberId, LINK_BASE);
  assert.ok(summary);
  return summary.code;
}

beforeEach(reset);

after(async () => {
  await reset();
  await pool.end();
});

describe("referral codes", () => {
  test("a code is minted once and the link is built on the base", async () => {
    const inviter = await member(INVITER_PHONE);
    const first = await getReferralSummary(inviter, `${LINK_BASE}/`);
    const second = await getReferralSummary(inviter, LINK_BASE);

    assert.ok(first && second);
    assert.match(first.code, /^[A-HJ-NP-Z2-9]{8}$/);
    assert.equal(second.code, first.code);
    assert.equal(first.link, `${LINK_BASE}/p/${first.code}`);
    assert.equal(first.monthsEarned, 0);
    assert.equal(first.canRedeemCode, true);
  });

  test("typed codes are forgiving about case, spaces and dashes", () => {
    assert.equal(normaliseCode(" abcd-efgh "), "ABCDEFGH");
  });
});

describe("redeeming", () => {
  test("both get a month; a never-started trial gets the 14 days plus the month", async () => {
    const inviter = await member(INVITER_PHONE);
    const friend = await member(FRIEND_PHONE);
    const code = await codeOf(inviter);

    const result = await redeemReferralCode(friend, code.toLowerCase());
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.member.trialState, "active");

    const friendDays = await trialDaysLeft(friend);
    const inviterDays = await trialDaysLeft(inviter);
    assert.ok(friendDays !== null && friendDays >= 14 + 28 && friendDays <= 14 + 31);
    assert.ok(inviterDays !== null && inviterDays >= 14 + 28 && inviterDays <= 14 + 31);

    const summary = await getReferralSummary(inviter, LINK_BASE);
    assert.equal(summary?.monthsEarned, 1);
    assert.equal(summary?.friends.length, 1);
    assert.equal(summary?.friends[0]?.id, friend);
  });

  test("an expired trial restarts from today, not from when it lapsed", async () => {
    const inviter = await member(INVITER_PHONE);
    await db.execute(sql`
      UPDATE members SET trial_started_at = now() - interval '60 days',
        trial_ends_at = now() - interval '46 days'
      WHERE id = ${inviter}
    `);
    const friend = await member(FRIEND_PHONE);

    await redeemReferralCode(friend, await codeOf(inviter));

    const days = await trialDaysLeft(inviter);
    assert.ok(days !== null && days >= 28 && days <= 31);
  });

  test("an active trial gets the month on top", async () => {
    const inviter = await member(INVITER_PHONE);
    await db.execute(sql`
      UPDATE members SET trial_started_at = now(), trial_ends_at = now() + interval '10 days'
      WHERE id = ${inviter}
    `);
    const friend = await member(FRIEND_PHONE);

    await redeemReferralCode(friend, await codeOf(inviter));

    const days = await trialDaysLeft(inviter);
    assert.ok(days !== null && days >= 10 + 28 && days <= 10 + 31);
  });

  test("an unknown code is invalid", async () => {
    const friend = await member(FRIEND_PHONE);
    const result = await redeemReferralCode(friend, "ZZZZZZZZ");
    assert.deepEqual(result, { ok: false, reason: "REFERRAL_CODE_INVALID" });
  });

  test("your own code doesn't count", async () => {
    const inviter = await member(INVITER_PHONE);
    const result = await redeemReferralCode(inviter, await codeOf(inviter));
    assert.deepEqual(result, { ok: false, reason: "REFERRAL_NOT_ELIGIBLE" });
    assert.equal(await trialDaysLeft(inviter), null);
  });

  test("one code per member, ever", async () => {
    const inviter = await member(INVITER_PHONE);
    const other = await member(OTHER_PHONE);
    const friend = await member(FRIEND_PHONE);

    assert.equal((await redeemReferralCode(friend, await codeOf(inviter))).ok, true);
    const second = await redeemReferralCode(friend, await codeOf(other));
    assert.deepEqual(second, { ok: false, reason: "REFERRAL_NOT_ELIGIBLE" });

    const summary = await getReferralSummary(friend, LINK_BASE);
    assert.equal(summary?.canRedeemCode, false);
  });

  test("an account older than a week can't use a code", async () => {
    const inviter = await member(INVITER_PHONE);
    const friend = await member(FRIEND_PHONE, 8);

    const result = await redeemReferralCode(friend, await codeOf(inviter));
    assert.deepEqual(result, { ok: false, reason: "REFERRAL_NOT_ELIGIBLE" });
    assert.equal((await getReferralSummary(friend, LINK_BASE))?.canRedeemCode, false);
  });

  test("past the yearly cap the friend still gets the month, the inviter doesn't", async () => {
    const inviter = await member(INVITER_PHONE);
    for (const phone of CAP_PHONES) {
      const earlier = await member(phone);
      await db.execute(sql`
        INSERT INTO referrals (inviter_member_id, invitee_member_id, inviter_rewarded)
        VALUES (${inviter}, ${earlier}, true)
      `);
    }
    const friend = await member(FRIEND_PHONE);

    const result = await redeemReferralCode(friend, await codeOf(inviter));
    assert.equal(result.ok, true);
    assert.ok(((await trialDaysLeft(friend)) ?? 0) >= 14 + 28);
    assert.equal(await trialDaysLeft(inviter), null);
    assert.equal((await getReferralSummary(inviter, LINK_BASE))?.monthsEarned, 12);
  });
});
