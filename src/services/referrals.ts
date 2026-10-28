import { randomInt } from "node:crypto";

import { sql } from "drizzle-orm";

import { db } from "@/db/client";
import { TRIAL_DAYS, findMemberProfile } from "@/services/member-auth";
import type { MemberProfile, ReferralSummary } from "@/types/api";

/*
  Invite a friend, you both get a month.

  The confirmation is the friend registering with their phone — a member row only exists for a
  verified number — and then typing the inviter's code on the step after. No payment is waited for,
  so everything that stops this being farmed lives here:
    - one code per member, ever (referrals.invitee_member_id is unique)
    - only in the account's first week, so it's a sign-up thing, not something to stack later
    - never your own code
    - the inviter's months are capped per year; the friend still gets theirs when the cap is hit

  ⚠️ A free month is time on members.trial_ends_at, because the trial is the only entitlement that
  exists. When subscriptions land this moves to whatever delays the first charge.
*/

/* No 0/O/1/I — people read these off a screen and type them on another one. */
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 8;
const CODE_ATTEMPTS = 5;

/* How long after sign-up a code can still be typed in. Long enough for "I skipped it, where do I
   put it now", short enough that it can't be saved up and used on an old account. */
const REDEEM_WINDOW_DAYS = 7;

/* Months an inviter can earn in any 365 days. Past it the friend still gets their month. */
const INVITER_MONTHS_PER_YEAR = 12;

function mintCode(): string {
  let code = "";
  for (let i = 0; i < CODE_LENGTH; i += 1) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return code;
}

/* "sorin vxgz-io " → "SORINVXGZIO". Spaces and dashes are how people type a code they read aloud. */
export function normaliseCode(input: string): string {
  return input.replace(/[\s-]/g, "").toUpperCase();
}

/* 23505 on the error or on its cause — drizzle wraps the pg error, see services/partners.ts. */
function isUniqueViolation(error: unknown): boolean {
  for (const value of [error, (error as { cause?: unknown } | null)?.cause]) {
    if (
      typeof value === "object" &&
      value !== null &&
      (value as { code?: string }).code === "23505"
    ) {
      return true;
    }
  }
  return false;
}

/*
  The member's code, minted the first time they open the invite screen.

  `WHERE referral_code IS NULL` so two screens opening at once can't each mint one — the loser
  updates nothing and reads the winner's. A collision with someone else's code is the unique index
  throwing, and the answer to that is just another code.
*/
async function ensureCode(memberId: string): Promise<string | null> {
  for (let attempt = 0; attempt < CODE_ATTEMPTS; attempt += 1) {
    try {
      await db.execute(sql`
        UPDATE members SET referral_code = ${mintCode()}, updated_at = now()
        WHERE id = ${memberId} AND referral_code IS NULL
      `);
      break;
    } catch (error) {
      if (!isUniqueViolation(error) || attempt === CODE_ATTEMPTS - 1) throw error;
    }
  }

  const result = await db.execute(sql`SELECT referral_code FROM members WHERE id = ${memberId}`);
  const row = result.rows[0] as { referral_code: string | null } | undefined;
  return row?.referral_code ?? null;
}

type FriendRow = { id: string; name: string | null; joined_at: string };
type SummaryRow = { months_earned: number; can_redeem: boolean };

/* `linkBase` is MARKETING_BASE_URL, passed in by the route so this file never reads a hostname. */
export async function getReferralSummary(
  memberId: string,
  linkBase: string,
): Promise<ReferralSummary | null> {
  const code = await ensureCode(memberId);
  if (!code) return null;

  const [summary, friends] = await Promise.all([
    db.execute(sql`
      SELECT
        (SELECT count(*)::int FROM referrals
          WHERE inviter_member_id = m.id AND inviter_rewarded) AS months_earned,
        (
          m.created_at > now() - ${REDEEM_WINDOW_DAYS} * interval '1 day'
          AND NOT EXISTS (SELECT 1 FROM referrals WHERE invitee_member_id = m.id)
        ) AS can_redeem
      FROM members m WHERE m.id = ${memberId}
    `),
    db.execute(sql`
      SELECT f.id, f.name, to_json(r.created_at)#>>'{}' AS joined_at
      FROM referrals r
      JOIN members f ON f.id = r.invitee_member_id
      WHERE r.inviter_member_id = ${memberId}
      ORDER BY r.created_at DESC
      LIMIT 100
    `),
  ]);

  const row = summary.rows[0] as SummaryRow | undefined;
  if (!row) return null;

  return {
    code,
    link: `${linkBase.replace(/\/$/, "")}/p/${code}`,
    monthsEarned: row.months_earned,
    friends: (friends.rows as FriendRow[]).map((f) => ({
      id: f.id,
      name: f.name,
      joinedAt: f.joined_at,
    })),
    canRedeemCode: row.can_redeem,
  };
}

export type RedeemResult =
  | { ok: true; member: MemberProfile }
  | { ok: false; reason: "REFERRAL_CODE_INVALID" | "REFERRAL_NOT_ELIGIBLE" };

/*
  One month onto a member's trial.

  Never-started trial: the normal trial plus a month, and it starts now — otherwise startTrial would
  later overwrite the end date and the month would vanish. Running: a month on top. Expired: a month
  from today, not from the day it lapsed.
*/
const addOneMonth = sql`
  trial_started_at = COALESCE(trial_started_at, now()),
  trial_ends_at = GREATEST(
    COALESCE(trial_ends_at, now() + ${TRIAL_DAYS} * interval '1 day'),
    now()
  ) + interval '1 month',
  updated_at = now()
`;

export async function redeemReferralCode(memberId: string, input: string): Promise<RedeemResult> {
  const code = normaliseCode(input);

  let outcome: { ok: true } | Extract<RedeemResult, { ok: false }>;
  try {
    outcome = await db.transaction(async (tx) => {
      /* Locks the invitee so a double-tap can't run two of these side by side. */
      const invitee = await tx.execute(sql`
        SELECT
          m.created_at > now() - ${REDEEM_WINDOW_DAYS} * interval '1 day' AS in_window,
          EXISTS (SELECT 1 FROM referrals WHERE invitee_member_id = m.id) AS already_invited
        FROM members m WHERE m.id = ${memberId}
        FOR UPDATE
      `);
      const self = invitee.rows[0] as { in_window: boolean; already_invited: boolean } | undefined;
      if (!self) return { ok: false, reason: "REFERRAL_NOT_ELIGIBLE" } as const;

      /* Locked too: two friends joining in the same second must not both squeeze under the cap. */
      const found = await tx.execute(sql`
        SELECT m.id,
          (SELECT count(*)::int FROM referrals
            WHERE inviter_member_id = m.id AND inviter_rewarded
              AND created_at > now() - interval '365 days') AS rewarded_this_year
        FROM members m WHERE m.referral_code = ${code}
        FOR UPDATE
      `);
      const inviter = found.rows[0] as { id: string; rewarded_this_year: number } | undefined;

      if (!inviter) return { ok: false, reason: "REFERRAL_CODE_INVALID" } as const;
      if (inviter.id === memberId || !self.in_window || self.already_invited) {
        return { ok: false, reason: "REFERRAL_NOT_ELIGIBLE" } as const;
      }

      const inviterRewarded = inviter.rewarded_this_year < INVITER_MONTHS_PER_YEAR;

      await tx.execute(sql`
        INSERT INTO referrals (inviter_member_id, invitee_member_id, inviter_rewarded)
        VALUES (${inviter.id}, ${memberId}, ${inviterRewarded})
      `);
      await tx.execute(sql`UPDATE members SET ${addOneMonth} WHERE id = ${memberId}`);
      if (inviterRewarded) {
        await tx.execute(sql`UPDATE members SET ${addOneMonth} WHERE id = ${inviter.id}`);
      }

      return { ok: true } as const;
    });
  } catch (error) {
    /* The unique index on invitee_member_id beat the lock — same answer as "already used one". */
    if (isUniqueViolation(error)) return { ok: false, reason: "REFERRAL_NOT_ELIGIBLE" };
    throw error;
  }

  if (!outcome.ok) return outcome;

  /* Read after commit, so the app gets the trial date that actually stuck. */
  const member = await findMemberProfile(memberId);
  return member ? { ok: true, member } : { ok: false, reason: "REFERRAL_NOT_ELIGIBLE" };
}
