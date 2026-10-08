import { randomInt } from "node:crypto";

import { sql } from "drizzle-orm";

import { db } from "@/db/client";
import { allowRequest } from "@/lib/rate-limit";
import { toDate } from "@/lib/rows";
import { generateToken, hashToken } from "@/lib/tokens";
import type { MemberProfile } from "@/types/api";

/*
  Member authentication: the phone code, and the session it produces.

  Deliberately a mirror of services/auth.ts rather than a generalisation of it. The two flows look
  similar and are not the same thing — a partner proves an email over a link in a browser and gets a
  cookie, a member proves a phone over SMS in an app and gets a bearer token. Merging them would put
  a branch on every line of the one file that decides who anybody is.

  ⚠️ This is the anti-fraud anchor of the whole product. Without a verified number one subscription
  gets shared by ten people, and that's what makes partners pull their best offers. Nothing in here
  may be softened for convenience.
*/

/* Five minutes. Long enough to read an SMS that took a while to arrive, short enough that a code
   glimpsed on a lock screen is dead by the time anyone acts on it. */
const CODE_TTL_MINUTES = 5;

/*
  Five wrong guesses and this code is finished — they have to ask for a new one.

  ⚠️ This is what makes six digits safe. A million tries walks the whole space; five doesn't. The
  cap lives on the row rather than in the in-memory limiter because that one is per-process and
  resets on deploy, and "redeploy for more guesses" is not a property worth having here.
*/
const MAX_CODE_ATTEMPTS = 5;

/*
  180 days, absolute, against the partner dashboard's 30.

  A dashboard opened once a month can afford to ask again. A member cannot: the moment a session
  lapses is the moment they're standing at a counter with a waiter waiting, and re-verifying there
  means an SMS, a wait and a queue behind them. It stays revocable because it's a row.
*/
const MEMBER_SESSION_TTL_DAYS = 180;

/* Ours, not a payment provider's, which is why it can exist before subscriptions do. */
const TRIAL_DAYS = 14;

/* ------------------------------------------------------------------------------------------- */

/*
  Romanian mobile numbers, normalised to E.164.

  Accepts the shapes people actually type — "0721 100 206", "+40721100206", "40721100206",
  "0721100206" — and returns exactly one of them. Storage is never prettified: a formatted number
  is one no lookup matches, same rule as venues.phone.

  ⚠️ Mobile only. The nine national digits must start with 7. A landline can't receive an SMS, so
  accepting one means a member who never gets a code and has no idea why.

  ⚠️ AGENTS.md also wants VOIP numbers rejected, and this does NOT do that — it can't be done from
  the number alone, it needs a carrier lookup. Whichever SMS provider lands should be asked for the
  line type, and that check belongs here.
*/
export function normalisePhone(input: string): string | null {
  const digits = input.replace(/\D/g, "");

  /* Strip whichever prefix they used down to the nine national digits. */
  let national: string | null = null;
  if (digits.length === 9) national = digits;
  else if (digits.length === 10 && digits.startsWith("0")) national = digits.slice(1);
  else if (digits.length === 11 && digits.startsWith("40")) national = digits.slice(2);
  else if (digits.length === 12 && digits.startsWith("040")) national = digits.slice(3);

  if (!national || !national.startsWith("7")) return null;
  return `+40${national}`;
}

/*
  Six digits, uniformly.

  `randomInt` rather than `Math.random()` for the reason lib/tokens.ts spells out, and rather than
  `randomBytes % 1000000` because modulo over a byte range is biased — the low codes would come up
  slightly more often, forever, which is a real if small gift to anyone guessing.

  Padded, so "000421" stays six characters and doesn't arrive looking like a five-digit code.
*/
function generateCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

/*
  The code is hashed together with the phone number it belongs to.

  Plain SHA-256 of six digits is a table of a million entries anyone can precompute, so a database
  dump would hand over every live code. Binding it to the phone makes that table per-number instead
  of global, which is the whole benefit of a salt for a secret that dies in five minutes.

  (Not scrypt, unlike the venue PIN. A slow hash buys time against offline attack on a long-lived
  secret; this one expires before the attack finishes and is capped at five guesses. The PIN has no
  expiry at all, which is what makes it the opposite case.)
*/
function hashCode(phone: string, code: string): string {
  return hashToken(`${phone}:${code}`);
}

/* ------------------------------------------------------------------------------------------- */

export type IssuedCode = { code: string; expiresAt: Date };

/*
  Mints a verification code for a number.

  ⚠️ Returns the plaintext, which only the delivery path and the dev echo may ever see. It is not
  stored and cannot be recovered.

  Unlike the partner flow there's no "or null if nobody owns it" — there is nothing to look up.
  A member row doesn't exist until verification succeeds, so every valid RO mobile gets a code.
*/
export async function requestPhoneCode(phone: string): Promise<IssuedCode> {
  const code = generateCode();

  /*
    Outstanding codes for this number die first.

    Without it, asking twice because the first SMS was slow leaves two working codes, and the older
    one keeps working for its full window. Same reasoning as issueTokenForUser.
  */
  await db.execute(sql`
    UPDATE phone_verifications
    SET consumed_at = now(), updated_at = now()
    WHERE phone = ${phone} AND consumed_at IS NULL
  `);

  const inserted = await db.execute(sql`
    INSERT INTO phone_verifications (phone, code_hash, expires_at)
    VALUES (${phone}, ${hashCode(phone, code)}, now() + ${CODE_TTL_MINUTES} * interval '1 minute')
    RETURNING expires_at
  `);

  const row = inserted.rows[0] as { expires_at: unknown } | undefined;
  if (!row) throw new Error("failed to insert phone verification");

  return { code, expiresAt: toDate(row.expires_at) };
}

export type VerifyFailure = "CODE_INVALID" | "CODE_EXPIRED" | "TOO_MANY_ATTEMPTS";

export type VerifyResult =
  /* `isNew` is true only when this call CREATED the member — see the note on MemberSession in
     types/api.ts for why the app can't just check whether the profile is empty. */
  | { ok: true; token: string; expiresAt: Date; member: MemberProfile; isNew: boolean }
  | { ok: false; reason: VerifyFailure };

/*
  Trades a code for a session, creating the member on first success.

  ⚠️ One transaction, and the UPDATE that consumes the code carries its own `consumed_at IS NULL`
  guard — that guard is what makes it single-use under concurrency. Two taps on "Confirmă" 50ms
  apart both read an unconsumed row; only one UPDATE matches. Checking in JavaScript and then
  updating would mint two sessions.

  ⚠️ A wrong guess is recorded OUTSIDE the transaction's happy path but still counted. Without that
  the attempt cap is decorative: a failed verify that rolls back its own counter can be retried
  forever.
*/
export async function verifyPhoneCode(phone: string, code: string): Promise<VerifyResult> {
  return db.transaction(async (tx) => {
    const found = await tx.execute(sql`
      SELECT id, attempts, consumed_at, expires_at <= now() AS expired
      FROM phone_verifications
      WHERE phone = ${phone} AND consumed_at IS NULL
      ORDER BY created_at DESC
      LIMIT 1
    `);

    const row = found.rows[0] as
      | { id: string; attempts: number; consumed_at: string | null; expired: boolean }
      | undefined;

    /* No live code for this number. Same answer as a wrong one — telling them apart only helps
       someone probing which numbers have a request in flight. */
    if (!row) return { ok: false, reason: "CODE_INVALID" } as const;
    if (row.expired) return { ok: false, reason: "CODE_EXPIRED" } as const;
    if (row.attempts >= MAX_CODE_ATTEMPTS)
      return { ok: false, reason: "TOO_MANY_ATTEMPTS" } as const;

    /*
      The guess itself. Compared by hash equality on an indexed lookup rather than in JavaScript,
      so there's no character-by-character timing to read.
    */
    const matched = await tx.execute(sql`
      UPDATE phone_verifications
      SET consumed_at = now(), updated_at = now()
      WHERE id = ${row.id}
        AND consumed_at IS NULL
        AND code_hash = ${hashCode(phone, code)}
      RETURNING id
    `);

    if (matched.rows.length === 0) {
      /* Wrong, or someone else just consumed it. Either way it costs an attempt — the counter is
         the only thing standing between six digits and a brute force. */
      await tx.execute(sql`
        UPDATE phone_verifications
        SET attempts = attempts + 1, updated_at = now()
        WHERE id = ${row.id}
      `);
      return { ok: false, reason: "CODE_INVALID" } as const;
    }

    /*
      The member row, created here or found.

      ⚠️ This is the ONLY place a member comes into existence, which is what makes
      phone_verified_at NOT NULL an invariant rather than a flag. `last_seen_at` is bumped on the
      way through because signing in is the most certain "they're here" there is.
    */
    const upserted = await tx.execute(sql`
      INSERT INTO members (phone, phone_verified_at, last_seen_at)
      VALUES (${phone}, now(), now())
      ON CONFLICT (phone) DO UPDATE
        SET last_seen_at = now(), updated_at = now()
      RETURNING id, phone, name, email,
                /* Postgres sets xmax to 0 on a freshly inserted row and to the locking transaction
                   id on one that an ON CONFLICT update touched. It is the only way to tell an
                   insert from an update out of a single upsert without a second round trip. */
                (xmax = 0) AS is_new,
                CASE
                  WHEN trial_ends_at IS NULL THEN 'none'
                  WHEN trial_ends_at > now() THEN 'active'
                  ELSE 'expired'
                END AS trial_state,
                to_json(trial_ends_at)#>>'{}' AS trial_ends_at
    `);

    const memberRow = upserted.rows[0] as (MemberRow & { is_new: boolean }) | undefined;
    if (!memberRow) throw new Error("failed to upsert member");

    const token = generateToken();
    const created = await tx.execute(sql`
      INSERT INTO member_sessions (member_id, token_hash, expires_at)
      VALUES (${memberRow.id}, ${hashToken(token)},
              now() + ${MEMBER_SESSION_TTL_DAYS} * interval '1 day')
      RETURNING expires_at
    `);

    const sessionRow = created.rows[0] as { expires_at: unknown } | undefined;
    if (!sessionRow) throw new Error("failed to insert member session");

    return {
      ok: true,
      token,
      expiresAt: toDate(sessionRow.expires_at),
      member: toProfile(memberRow),
      isNew: memberRow.is_new,
    } as const;
  });
}

type MemberRow = {
  id: string;
  phone: string;
  name: string | null;
  email: string | null;
  trial_state: MemberProfile["trialState"];
  trial_ends_at: string | null;
};

function toProfile(row: MemberRow): MemberProfile {
  return {
    id: row.id,
    phone: row.phone,
    name: row.name,
    email: row.email,
    trialState: row.trial_state,
    trialEndsAt: row.trial_ends_at,
  };
}

/* The projection every member-authenticated request needs. Trial state is decided in SQL against
   server time, so the app never compares a date and can never disagree with us about eligibility. */
const profileColumns = sql`
  m.id, m.phone, m.name, m.email,
  CASE
    WHEN m.trial_ends_at IS NULL THEN 'none'
    WHEN m.trial_ends_at > now() THEN 'active'
    ELSE 'expired'
  END AS trial_state,
  to_json(m.trial_ends_at)#>>'{}' AS trial_ends_at
`;

/*
  The bearer token → who's calling. Runs on every authenticated request, so it's one indexed lookup.

  Returns null for expired and unknown alike; the app's answer to both is the same — sign in again.
*/
export async function findMemberBySessionToken(token: string): Promise<MemberProfile | null> {
  const result = await db.execute(sql`
    SELECT ${profileColumns}
    FROM member_sessions s
    JOIN members m ON m.id = s.member_id
    WHERE s.token_hash = ${hashToken(token)} AND s.expires_at > now()
    LIMIT 1
  `);

  const row = result.rows[0] as MemberRow | undefined;
  return row ? toProfile(row) : null;
}

/*
  ⚠️ Fire-and-forget, and throttled in memory BEFORE it reaches the database.

  The SQL guard below already stops the column being written more than once a day — but a guarded
  UPDATE is still a write transaction on a pooled connection, and this ran on every authenticated
  request. Measured against the redemption poll, it was a third of that endpoint's entire database
  cost, for a column whose only reader is the "verified and never came back" segment on the admin
  members page.

  So the in-memory window comes first and the overwhelming majority of calls never reach Postgres.
  Reusing allowRequest rather than writing a second map: "let one through per member per hour" is
  exactly a fixed-window counter with a limit of one.

  Per-process and reset by a deploy, which costs at most one extra no-op UPDATE per member — and the
  SQL guard is still what actually decides, so the two can't disagree.
*/
export async function touchMemberSeen(memberId: string): Promise<void> {
  if (!allowRequest(`member-seen:${memberId}`, 1, 60 * 60_000)) return;

  await db.execute(sql`
    UPDATE members
    SET last_seen_at = now(), updated_at = now()
    WHERE id = ${memberId}
      AND (last_seen_at IS NULL OR last_seen_at < now() - interval '1 day')
  `);
}

/* Idempotent — signing out twice, or with a token that's already dead, satisfies the caller's
   intent either way. */
export async function destroyMemberSession(token: string): Promise<void> {
  await db.execute(sql`DELETE FROM member_sessions WHERE token_hash = ${hashToken(token)}`);
}

/*
  Starts the trial, once.

  ⚠️ The guard is `trial_started_at IS NULL`, not "is the trial over" — a member whose trial lapsed
  must NOT get another one by tapping the button again. That's the cheapest possible subscription
  bypass and it would be invisible until the revenue didn't arrive.

  Returns the profile either way, so a double-tap is a no-op rather than an error.
*/
export async function startTrial(memberId: string): Promise<MemberProfile | null> {
  await db.execute(sql`
    UPDATE members
    SET trial_started_at = now(),
        trial_ends_at = now() + ${TRIAL_DAYS} * interval '1 day',
        updated_at = now()
    WHERE id = ${memberId} AND trial_started_at IS NULL
  `);

  const result = await db.execute(sql`
    SELECT ${profileColumns} FROM members m WHERE m.id = ${memberId} LIMIT 1
  `);

  const row = result.rows[0] as MemberRow | undefined;
  return row ? toProfile(row) : null;
}

/*
  Name and email, set from the step after verification or edited later from Profile.

  ⚠️ Both are optional and both are clearable. `undefined` means "leave it alone", `null` means
  "remove it" — which is why the SQL uses COALESCE against a sentinel rather than taking the value
  straight: a plain COALESCE(${name}, name) can never clear a field, and a plain assignment can never
  leave one alone. The route decides which of the two a request meant; this just does it.

  Never touches the phone. That is the identity, it was verified, and nothing on a profile form gets
  to move it.
*/
export async function updateMemberProfile(
  memberId: string,
  patch: { name?: string | null; email?: string | null },
): Promise<MemberProfile | null> {
  const result = await db.execute(sql`
    UPDATE members m SET
      name  = ${patch.name === undefined ? sql`m.name` : patch.name},
      email = ${patch.email === undefined ? sql`m.email` : patch.email},
      updated_at = now()
    WHERE m.id = ${memberId}
    RETURNING ${profileColumns}
  `);

  const row = result.rows[0] as MemberRow | undefined;
  return row ? toProfile(row) : null;
}
