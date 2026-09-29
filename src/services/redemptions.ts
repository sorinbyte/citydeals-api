import { randomInt } from "node:crypto";

import { sql } from "drizzle-orm";

import { db } from "@/db/client";
import { env } from "@/lib/env";
import { REDEMPTION_TOKEN_BYTES, generateToken, hashToken } from "@/lib/tokens";
import type {
  DealType,
  IssuedRedemption,
  RedeemConfirmation,
  RedemptionState,
  RedemptionStatus,
} from "@/types/api";

/*
  Issuing a redemption, and consuming one.

  ⚠️ AGENTS.md calls redemption fraud the #1 operational risk of the business, and this file is
  where that is either handled or not. Two rules from it shape everything below:

    · Verification is atomic and idempotent. A single-use code is marked used inside the same
      transaction that validates it — never read-then-write. Two scans 50ms apart is a normal event
      at a busy counter, not an edge case.
    · Every redemption stays answerable months later. Nothing here is ever deleted, and a code we
      threw away is never recorded as one a member actually used.

  services/auth.ts is the template for the first rule; consumeLoginToken there is the same shape.
*/

/* Fifteen minutes, no renewal. Long enough that a waiter taking their time doesn't strand anyone,
   short enough that a screenshot passed to the next table is dead before it gets there. */
const TTL_MINUTES = 15;

/*
  The typed fallback's alphabet: 29 symbols, roughly 590 million six-character codes.

  ⚠️ 0/O, 1/I/L and 5/S are all gone. This gets read off a dim phone screen across a counter and
  typed by someone in a hurry, and every one of those pairs is a wrong entry that looks to the
  employee like the member's fault.
*/
const CODE_ALPHABET = "2346789ABCDEFGHJKMNPQRTUVWXYZ";
const CODE_LENGTH = 6;

/* Collisions are vanishingly unlikely per venue, but "unlikely" isn't "impossible" and the fix is
   three lines — see the partial unique index this retries against in db/schema/redemptions.ts. */
const CODE_ATTEMPTS = 3;

function generateShortCode(): string {
  let out = "";
  for (let i = 0; i < CODE_LENGTH; i += 1) {
    /* randomInt, not Math.random — same reasoning as lib/tokens.ts. It is uniform over the range,
       so there's no modulo bias pushing certain letters up. */
    out += CODE_ALPHABET[randomInt(0, CODE_ALPHABET.length)];
  }
  return out;
}

/*
  Codes are compared in their canonical form: upper case, no separators.

  The app shows "K7M-2QX" because a hyphen is much easier to read aloud and to type, and staff will
  type it back with the hyphen, without it, or in lower case. All three have to work.
*/
function canonicalCode(input: string): string {
  return input.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/* Same binding trick as the phone code: the hash covers the venue too, so a dump can't be walked
   with one precomputed table across the whole platform. */
function hashShortCode(venueId: string, code: string): string {
  return hashToken(`${venueId}:${code}`);
}

/*
  The QR payload: the redeem app's origin, then the token. Nothing between them — the app owns its
  own hostname (v.crunchapp.ro), so the token sits at the root.

  ⚠️ This is baked into a QR a member may already be holding up at a counter, so changing the shape
  strands whatever was on screen a second earlier. Not a string to tidy on a live service.
*/
function redemptionUrl(token: string): string {
  /* Trailing slashes stripped — REDEEM_BASE_URL gets pasted out of a browser bar as often as it's
     typed, and `https://v.crunchapp.ro/` + `/xyz` is a 404 in a QR code nobody can debug. */
  return `${env.REDEEM_BASE_URL.replace(/\/+$/, "")}/${token}`;
}

/* ------------------------------------------------------------------------------------------- */

export type IssueFailure =
  | "DEAL_NOT_FOUND"
  | "DEAL_INACTIVE"
  | "TRIAL_REQUIRED"
  | "TRIAL_EXPIRED"
  | "DEAL_ON_COOLDOWN";

export type IssueResult =
  | { ok: true; redemption: IssuedRedemption }
  | { ok: false; reason: IssueFailure; availableAt?: string };

type EligibilityRow = {
  deal_id: string;
  deal_title: string;
  is_active: boolean;
  venue_id: string;
  venue_name: string;
  trial_state: "none" | "active" | "expired";
  available_at: string | null;
};

/*
  Everything that decides whether this member may have a code, in one query.

  ⚠️ Every one of these is computed HERE, against server time, and none of it is checkable on the
  device. The app knows a deal has a refresh window because the card says so; it does not get to
  decide whether this member is inside one.

  `available_at` is the cooldown answer: when this member may next use this deal, or null if now.
  It comes back as text because a top-level timestamptz out of db.execute is a string anyway.
*/
const eligibility = sql`
  SELECT
    d.id                  AS deal_id,
    d.title               AS deal_title,
    d.is_active,
    v.id                  AS venue_id,
    v.name                AS venue_name,
    CASE
      WHEN m.trial_ends_at IS NULL  THEN 'none'
      WHEN m.trial_ends_at > now()  THEN 'active'
      ELSE 'expired'
    END                   AS trial_state,
    to_json(
      (
        SELECT max(r.consumed_at) + d.refresh_days * interval '1 day'
        FROM redemptions r
        WHERE r.member_id = m.id AND r.deal_id = d.id AND r.consumed_at IS NOT NULL
      )
    )#>>'{}'              AS available_at
`;

/*
  Mints a code for a member and a deal.

  Retried as a whole, because the two unique indexes it can collide with both mean "run it again":
  a short-code collision needs a different code, and a lost race on the one-live-per-member index
  means someone else's issue committed first — re-running voids theirs and takes the slot, which is
  the intended outcome of "one live code" either way.
*/
export async function issueRedemption(memberId: string, dealId: string): Promise<IssueResult> {
  let lastError: unknown;

  for (let attempt = 0; attempt < CODE_ATTEMPTS; attempt += 1) {
    try {
      return await issueOnce(memberId, dealId);
    } catch (err) {
      /* 23505 is unique_violation. Anything else is a real fault and must not be swallowed by a
         retry loop — a broken query would otherwise look like three slow attempts and a 500. */
      if ((err as { code?: string }).code !== "23505") throw err;
      lastError = err;
    }
  }

  throw lastError;
}

async function issueOnce(memberId: string, dealId: string): Promise<IssueResult> {
  return db.transaction(async (tx) => {
    const found = await tx.execute(sql`
      ${eligibility}
      FROM deals d
      JOIN venues v ON v.id = d.venue_id
      JOIN members m ON m.id = ${memberId}
      WHERE d.id = ${dealId} AND v.is_published
      LIMIT 1
    `);

    const row = found.rows[0] as EligibilityRow | undefined;
    if (!row) return { ok: false, reason: "DEAL_NOT_FOUND" } as const;
    if (!row.is_active) return { ok: false, reason: "DEAL_INACTIVE" } as const;

    /* Two codes rather than one, because the app's answer differs: "începe perioada de probă" for
       someone who never started, "reactivează" for someone whose ran out. */
    if (row.trial_state === "none") return { ok: false, reason: "TRIAL_REQUIRED" } as const;
    if (row.trial_state === "expired") return { ok: false, reason: "TRIAL_EXPIRED" } as const;

    if (row.available_at && new Date(row.available_at) > new Date()) {
      return { ok: false, reason: "DEAL_ON_COOLDOWN", availableAt: row.available_at } as const;
    }

    /*
      Everything outstanding dies first — expired rows included.

      ⚠️ The expired ones matter more than they look. The one-live-per-member index can't mention
      now() in its predicate, so a code that lapsed without being scanned still occupies the slot
      until something voids it. Skip this and a member who abandons one code can never get another.
    */
    await tx.execute(sql`
      UPDATE redemptions
      SET voided_at = now(), updated_at = now()
      WHERE member_id = ${memberId} AND consumed_at IS NULL AND voided_at IS NULL
    `);

    const token = generateToken(REDEMPTION_TOKEN_BYTES);
    const shortCode = generateShortCode();

    const inserted = await tx.execute(sql`
      INSERT INTO redemptions (member_id, venue_id, deal_id, token_hash, short_code_hash, expires_at)
      VALUES (
        ${memberId}, ${row.venue_id}, ${row.deal_id},
        ${hashToken(token)}, ${hashShortCode(row.venue_id, shortCode)},
        now() + ${TTL_MINUTES} * interval '1 minute'
      )
      RETURNING id, to_json(expires_at)#>>'{}' AS expires_at
    `);

    const created = inserted.rows[0] as { id: string; expires_at: string } | undefined;
    if (!created) throw new Error("failed to insert redemption");

    return {
      ok: true,
      redemption: {
        id: created.id,
        url: redemptionUrl(token),
        shortCode,
        expiresAt: created.expires_at,
        venueName: row.venue_name,
        dealTitle: row.deal_title,
      },
    } as const;
  });
}

/* ------------------------------------------------------------------------------------------- */

/*
  live / used / expired / voided, derived rather than stored.

  ⚠️ Order matters. A code that was consumed and has since passed its expiry is USED, not expired —
  reading it the other way would turn every redemption older than fifteen minutes into a
  disappearance, which is exactly the record a partner dispute needs.
*/
const stateColumn = sql`
  CASE
    WHEN r.consumed_at IS NOT NULL THEN 'used'
    WHEN r.voided_at   IS NOT NULL THEN 'voided'
    WHEN r.expires_at <= now()     THEN 'expired'
    ELSE 'live'
  END
`;

type StatusRow = {
  id: string;
  state: RedemptionState;
  expires_at: string;
  consumed_at: string | null;
};

/*
  What the app polls while the code is on screen, so it can go quiet the moment a waiter confirms.

  ⚠️ Scoped to the member. Without the member_id in the WHERE, anyone holding an id could watch
  someone else's redemption resolve.
*/
export async function getRedemptionStatus(
  memberId: string,
  redemptionId: string,
): Promise<RedemptionStatus | null> {
  const result = await db.execute(sql`
    SELECT r.id, ${stateColumn} AS state,
           to_json(r.expires_at)#>>'{}'  AS expires_at,
           to_json(r.consumed_at)#>>'{}' AS consumed_at
    FROM redemptions r
    WHERE r.id = ${redemptionId} AND r.member_id = ${memberId}
    LIMIT 1
  `);

  const row = result.rows[0] as StatusRow | undefined;
  if (!row) return null;

  return {
    id: row.id,
    state: row.state,
    expiresAt: row.expires_at,
    consumedAt: row.consumed_at,
  };
}

/*
  The same read, but doing its own authentication in the WHERE clause — one round trip instead of
  two.

  ⚠️ This exists ONLY because it is the hottest endpoint in the product by a wide margin: the redeem
  screen polls it every five seconds for up to fifteen minutes, so it costs more requests than
  everything else the app does put together. Going through requireMember means a session lookup and
  then a status read; joining them halves that, and at a busy dinner service that is the difference
  that matters.

  ⚠️ It is NOT a way around the auth middleware, and must not become a pattern. The session check is
  still there — it has moved INTO the query, which is the same thing AGENTS.md insists on for venue
  scoping: "scoping happens in the query, not after it". A row comes back only for a live session
  that owns this redemption.

  ⚠️ The LEFT JOIN is load-bearing. An INNER JOIN would return zero rows for both "your session is
  dead" and "that redemption isn't yours", and the app has to tell those apart — the first means
  sign in again, the second means the code is gone. So the session matches on its own, and the
  redemption arrives as NULL when it doesn't exist.
*/
export type PolledStatus =
  | { session: "invalid" }
  | { session: "valid"; status: RedemptionStatus | null };

export async function getRedemptionStatusForSession(
  sessionToken: string,
  redemptionId: string,
): Promise<PolledStatus> {
  const result = await db.execute(sql`
    SELECT r.id, ${stateColumn} AS state,
           to_json(r.expires_at)#>>'{}'  AS expires_at,
           to_json(r.consumed_at)#>>'{}' AS consumed_at
    FROM member_sessions s
    LEFT JOIN redemptions r
      ON r.member_id = s.member_id AND r.id = ${redemptionId}
    WHERE s.token_hash = ${hashToken(sessionToken)} AND s.expires_at > now()
    LIMIT 1
  `);

  const row = result.rows[0] as (StatusRow & { id: string | null }) | undefined;
  /* No session row at all — expired, revoked or never existed. */
  if (!row) return { session: "invalid" };
  /* Session is fine, the redemption isn't theirs or doesn't exist. */
  if (!row.id) return { session: "valid", status: null };

  return {
    session: "valid",
    status: {
      id: row.id,
      state: row.state,
      expiresAt: row.expires_at,
      consumedAt: row.consumed_at,
    },
  };
}

/*
  The member backing out — closing the screen without using the code.

  Worth an endpoint rather than letting it expire quietly: it frees the one-live slot immediately,
  so changing your mind about which venue you're at doesn't mean waiting fifteen minutes.

  ⚠️ Never touches a consumed row. Voiding something already used would rewrite history in the one
  table that exists to be history.
*/
export async function voidRedemption(memberId: string, redemptionId: string): Promise<void> {
  await db.execute(sql`
    UPDATE redemptions
    SET voided_at = now(), updated_at = now()
    WHERE id = ${redemptionId}
      AND member_id = ${memberId}
      AND consumed_at IS NULL
      AND voided_at IS NULL
  `);
}

/* ------------------------------------------------------------------------------------------- */

export type RedemptionTarget = {
  id: string;
  state: RedemptionState;
  venue: { id: string; name: string };
  deal: { title: string; condition: string; type: DealType };
  consumedAt: string | null;
};

type TargetRow = {
  id: string;
  state: RedemptionState;
  venue_id: string;
  venue_name: string;
  deal_title: string;
  deal_condition: string;
  deal_type: DealType;
  consumed_at: string | null;
};

const targetColumns = sql`
  r.id,
  ${stateColumn}  AS state,
  v.id            AS venue_id,
  v.name          AS venue_name,
  d.title         AS deal_title,
  d.condition     AS deal_condition,
  d.type          AS deal_type,
  to_json(r.consumed_at)#>>'{}' AS consumed_at
`;

function toTarget(row: TargetRow): RedemptionTarget {
  return {
    id: row.id,
    state: row.state,
    venue: { id: row.venue_id, name: row.venue_name },
    deal: { title: row.deal_title, condition: row.deal_condition, type: row.deal_type },
    consumedAt: row.consumed_at,
  };
}

/*
  What the redeem page shows before anyone has proved anything.

  ⚠️ Says nothing about the member. Whoever scanned this is unauthenticated — they might be staff,
  they might be the person at the next table who photographed a screen — so it is venue and deal
  only, both of which are already public catalogue data.
*/
export async function findRedemptionByToken(token: string): Promise<RedemptionTarget | null> {
  const result = await db.execute(sql`
    SELECT ${targetColumns}
    FROM redemptions r
    JOIN venues v ON v.id = r.venue_id
    JOIN deals  d ON d.id = r.deal_id
    WHERE r.token_hash = ${hashToken(token)}
    LIMIT 1
  `);

  const row = result.rows[0] as TargetRow | undefined;
  return row ? toTarget(row) : null;
}

/*
  The typed fallback, resolved inside one venue.

  ⚠️ Venue-scoped, and that is what keeps six characters safe. Globally, a six-character code would
  be a guessable handle on every live redemption on the platform; scoped to the venue whose staff
  are typing it — and only reachable once that browser has proved the PIN — the attacker has to be
  standing in the restaurant to have a target worth guessing at.
*/
export async function findRedemptionByShortCode(
  venueId: string,
  code: string,
): Promise<RedemptionTarget | null> {
  const result = await db.execute(sql`
    SELECT ${targetColumns}
    FROM redemptions r
    JOIN venues v ON v.id = r.venue_id
    JOIN deals  d ON d.id = r.deal_id
    WHERE r.venue_id = ${venueId}
      AND r.short_code_hash = ${hashShortCode(venueId, canonicalCode(code))}
      AND r.consumed_at IS NULL
    LIMIT 1
  `);

  const row = result.rows[0] as TargetRow | undefined;
  return row ? toTarget(row) : null;
}

export type ConfirmFailure =
  | "REDEMPTION_NOT_FOUND"
  | "REDEMPTION_EXPIRED"
  | "REDEMPTION_USED"
  | "REDEMPTION_VOIDED"
  | "REDEMPTION_WRONG_VENUE";

export type ConfirmResult =
  | { ok: true; confirmation: RedeemConfirmation }
  | { ok: false; reason: ConfirmFailure };

/*
  Marks a redemption used. The one operation the whole product turns on.

  ⚠️ The guarded UPDATE is what makes it single-use under concurrency — same shape and same reason
  as consumeLoginToken in services/auth.ts. Two employees scanning the same screen a moment apart
  both read a live row; only one UPDATE matches, and the loser is told it's already used rather than
  being handed a second discount. Checking in JavaScript first would give out both.

  ⚠️ `venue_id` is in the WHERE as well as on the read above. The read is what lets us say WHICH
  failure it was; the WHERE is what makes it true when two things happen at once.
*/
export async function confirmRedemption(
  redemptionId: string,
  venueId: string,
): Promise<ConfirmResult> {
  return db.transaction(async (tx) => {
    const found = await tx.execute(sql`
      SELECT ${targetColumns}
      FROM redemptions r
      JOIN venues v ON v.id = r.venue_id
      JOIN deals  d ON d.id = r.deal_id
      WHERE r.id = ${redemptionId}
      LIMIT 1
    `);

    const row = found.rows[0] as TargetRow | undefined;
    if (!row) return { ok: false, reason: "REDEMPTION_NOT_FOUND" } as const;

    /*
      Checked before state, deliberately. Someone who walked next door and scanned there needs to
      hear "this isn't for this venue", not "already used" — the second sounds like the member is
      trying it on, and it's the sentence that starts an argument at a counter.
    */
    if (row.venue_id !== venueId) return { ok: false, reason: "REDEMPTION_WRONG_VENUE" } as const;

    if (row.state === "used") return { ok: false, reason: "REDEMPTION_USED" } as const;
    if (row.state === "voided") return { ok: false, reason: "REDEMPTION_VOIDED" } as const;
    if (row.state === "expired") return { ok: false, reason: "REDEMPTION_EXPIRED" } as const;

    const claimed = await tx.execute(sql`
      UPDATE redemptions
      SET consumed_at = now(), updated_at = now()
      WHERE id = ${row.id}
        AND venue_id = ${venueId}
        AND consumed_at IS NULL
        AND voided_at IS NULL
        AND expires_at > now()
      RETURNING to_json(consumed_at)#>>'{}' AS consumed_at
    `);

    const claimedRow = claimed.rows[0] as { consumed_at: string } | undefined;
    /* Lost the race against a simultaneous scan. */
    if (!claimedRow) return { ok: false, reason: "REDEMPTION_USED" } as const;

    return {
      ok: true,
      confirmation: {
        venue: { id: row.venue_id, name: row.venue_name },
        deal: { title: row.deal_title, condition: row.deal_condition, type: row.deal_type },
        consumedAt: claimedRow.consumed_at,
      },
    } as const;
  });
}
