import { sql } from "drizzle-orm";

import { db } from "@/db/client";
import { generateToken, hashToken } from "@/lib/tokens";

/*
  Partner authentication: issuing a magic link, redeeming it, and the session it produces.

  ⚠️ Everything in here is scoped to `venue_owner`. Platform owners do NOT sign in this way — admin
  sits behind Cloudflare Access and has no password and no session of its own (see services/users.ts
  and routes/admin.ts). A platform_owner asking for a partner link gets nothing, deliberately:
  otherwise a widened Access policy and a magic link would be two independent ways into two
  different dashboards under one account.

  The plaintext token exists only in the return value of the two functions that mint one. Everything
  stored is SHA-256 — see lib/tokens.ts.
*/

/*
  Fifteen minutes. Long enough to switch to a phone and find the mail, short enough that a link
  sitting in an inbox that later gets breached is dead.

  Not configurable. A knob here is a knob someone eventually sets to a week.
*/
const LOGIN_TOKEN_TTL_MINUTES = 15;

/*
  An invite is a different job. Someone gets set up on a Tuesday and opens the mail when they next
  sit down at the restaurant's computer, which is realistically not that day — a 15-minute invite
  would be a support conversation every single time.
*/
const INVITE_TOKEN_TTL_DAYS = 7;

/* 30 days, refreshed on nothing — this is an absolute lifetime, so a partner signs in again about
   once a month. They open this dashboard every few weeks, so a shorter session would mean the
   magic-link dance nearly every visit, and a longer one is a stolen laptop staying signed in. */
const SESSION_TTL_DAYS = 30;

export type TokenPurpose = "login" | "invite";

/*
  ⚠️ `db.execute` hands back raw node-postgres rows, and a timestamptz in one of those is a STRING,
  not a Date — the typed query builder converts, this path doesn't.

  Worth a helper rather than a cast because the cast is what bit: annotating the row as
  `{ expires_at: Date }` compiles perfectly and then throws "toISOString is not a function" at
  runtime, in the caller, well away from the query that actually produced it.
*/
function toDate(value: unknown): Date {
  if (value instanceof Date) return value;
  if (typeof value === "string") return new Date(value);
  throw new Error(`expected a timestamp, got ${typeof value}`);
}

/* Who a session belongs to, plus everything the dashboard needs to render its chrome. One query
   rather than three, because every authenticated request pays for it. */
export type PartnerSession = {
  user: { id: string; email: string; name: string };
  partner: { id: string; companyName: string };
  venues: Array<{ id: string; name: string; area: string }>;
};

type VenueOwnerRow = { id: string; email: string; name: string };

/*
  The active venue_owner with this email, or null.

  Role and status both matter. `role` is what makes this a partner rather than an admin; `status` is
  how access gets taken away without deleting the row, which has to stay for the audit trail.

  Compared lowercased on both sides so it uses users_email_lower_key — the index is on
  lower(email), and a query that doesn't match it neither uses the index nor gets the
  case-insensitivity the index exists to enforce.
*/
async function findVenueOwnerByEmail(email: string): Promise<VenueOwnerRow | null> {
  const result = await db.execute(sql`
    SELECT id, email, name
    FROM users
    WHERE lower(email) = lower(${email})
      AND role = 'venue_owner'
      AND status = 'active'
    LIMIT 1
  `);

  return (result.rows[0] as VenueOwnerRow | undefined) ?? null;
}

export type IssuedToken = {
  /* ⚠️ The only time this value is ever readable. It is not stored and cannot be recovered — if the
     mail doesn't go out, the link is gone and the person has to ask again. */
  token: string;
  expiresAt: Date;
};

/*
  Mints a sign-in link for an email address, or returns null if nobody active owns it.

  ⚠️ The caller MUST NOT turn null into a different HTTP response. The route answers 204 either way
  — an endpoint that behaves differently for a known address is an endpoint that enumerates our
  partners' emails one guess at a time. Null here means "log it and say nothing".
*/
export async function issueLoginToken(email: string): Promise<IssuedToken | null> {
  const user = await findVenueOwnerByEmail(email);
  if (!user) return null;

  return issueTokenForUser(user.id, "login");
}

/*
  The same thing for a known user id, used by the invite flow in admin where the account was just
  created and there's nothing to look up.
*/
export async function issueTokenForUser(
  userId: string,
  purpose: TokenPurpose,
): Promise<IssuedToken> {
  const token = generateToken();
  const ttl =
    purpose === "invite"
      ? sql`${INVITE_TOKEN_TTL_DAYS} * interval '1 day'`
      : sql`${LOGIN_TOKEN_TTL_MINUTES} * interval '1 minute'`;

  /*
    Every outstanding link for this person dies first.

    Without this, asking twice because the first mail was slow leaves TWO working links in an inbox,
    and the older one keeps working for its full window. Marking them consumed rather than deleting
    keeps the "already used" answer honest for whichever one gets clicked second.
  */
  await db.execute(sql`
    UPDATE login_tokens
    SET consumed_at = now(), updated_at = now()
    WHERE user_id = ${userId} AND consumed_at IS NULL
  `);

  const inserted = await db.execute(sql`
    INSERT INTO login_tokens (user_id, token_hash, purpose, expires_at)
    VALUES (${userId}, ${hashToken(token)}, ${purpose}, now() + ${ttl})
    RETURNING expires_at
  `);

  const row = inserted.rows[0] as { expires_at: unknown } | undefined;
  if (!row) throw new Error("failed to insert login token");

  return { token, expiresAt: toDate(row.expires_at) };
}

/* Why a redemption failed, in the API's own vocabulary. The partner app words each of these
   differently — "expired" and "already used" both mean "ask for another", but only one of them
   sounds like something went wrong. */
export type ConsumeFailure = "TOKEN_INVALID" | "TOKEN_EXPIRED" | "TOKEN_USED";

export type ConsumeResult =
  | { ok: true; sessionToken: string; expiresAt: Date; session: PartnerSession }
  | { ok: false; reason: ConsumeFailure };

/*
  Trades a link token for a session.

  ⚠️ The whole redemption is one transaction, and the UPDATE that marks the token consumed carries
  its own `consumed_at IS NULL` guard. That guard is what makes it single-use under concurrency:
  two simultaneous clicks — which genuinely happens, because mail clients prefetch links — both read
  an unconsumed row, but only one UPDATE matches, and the loser gets TOKEN_USED instead of a second
  session. Checking in JavaScript and then updating would hand out two.
*/
export async function consumeLoginToken(token: string): Promise<ConsumeResult> {
  const tokenHash = hashToken(token);

  return db.transaction(async (tx) => {
    const found = await tx.execute(sql`
      SELECT t.id, t.user_id, t.purpose, t.consumed_at, t.expires_at <= now() AS expired,
             u.status AS user_status
      FROM login_tokens t
      JOIN users u ON u.id = t.user_id
      WHERE t.token_hash = ${tokenHash}
      LIMIT 1
    `);

    const row = found.rows[0] as
      | {
          id: string;
          user_id: string;
          purpose: TokenPurpose;
          consumed_at: string | null;
          expired: boolean;
          user_status: string;
        }
      | undefined;

    if (!row) return { ok: false, reason: "TOKEN_INVALID" } as const;
    if (row.consumed_at) return { ok: false, reason: "TOKEN_USED" } as const;
    if (row.expired) return { ok: false, reason: "TOKEN_EXPIRED" } as const;
    /* Suspended between the link being sent and clicked. TOKEN_INVALID rather than a distinct code:
       the reason someone lost access is a conversation, not a line of UI copy. */
    if (row.user_status !== "active") return { ok: false, reason: "TOKEN_INVALID" } as const;

    const claimed = await tx.execute(sql`
      UPDATE login_tokens
      SET consumed_at = now(), updated_at = now()
      WHERE id = ${row.id} AND consumed_at IS NULL
      RETURNING id
    `);

    /* Lost the race against a simultaneous click. */
    if (claimed.rows.length === 0) return { ok: false, reason: "TOKEN_USED" } as const;

    /* An invite is only accepted once, and only by actually being used — recording it here rather
       than when the mail goes out is the difference between "we invited them" and "they turned up". */
    if (row.purpose === "invite") {
      await tx.execute(sql`
        UPDATE users
        SET invite_accepted_at = coalesce(invite_accepted_at, now()), updated_at = now()
        WHERE id = ${row.user_id}
      `);
    }

    await tx.execute(sql`
      UPDATE users SET last_login_at = now(), updated_at = now() WHERE id = ${row.user_id}
    `);

    const sessionToken = generateToken();
    const created = await tx.execute(sql`
      INSERT INTO sessions (user_id, token_hash, expires_at)
      VALUES (${row.user_id}, ${hashToken(sessionToken)}, now() + ${SESSION_TTL_DAYS} * interval '1 day')
      RETURNING expires_at
    `);

    const sessionRow = created.rows[0] as { expires_at: unknown } | undefined;
    if (!sessionRow) throw new Error("failed to insert session");

    const session = await loadSession(row.user_id, tx);
    /* The row was just read inside this transaction, so the only way this is null is a check
       constraint we thought was impossible — better to fail loudly than hand back a half-session. */
    if (!session) throw new Error(`user ${row.user_id} has no partner after consuming a token`);

    return { ok: true, sessionToken, expiresAt: toDate(sessionRow.expires_at), session } as const;
  });
}

/* Narrow enough to cover both the pool and a transaction handle, without dragging the full Db type
   through every signature. */
type Queryable = Pick<typeof db, "execute">;

/*
  Everything the dashboard needs about who's signed in, in one round trip.

  ⚠️ `venues` comes from user_venues — the explicit grant list — NOT from "every venue this partner
  owns". A chain can put one manager on one location, and inferring it from partner_id would quietly
  hand that manager the whole group.
*/
async function loadSession(userId: string, tx: Queryable = db): Promise<PartnerSession | null> {
  const result = await tx.execute(sql`
    SELECT
      u.id, u.email, u.name,
      p.id AS partner_id, p.company_name,
      coalesce(
        (
          SELECT json_agg(json_build_object('id', v.id, 'name', v.name, 'area', v.area)
                          ORDER BY v.name)
          FROM user_venues uv
          JOIN venues v ON v.id = uv.venue_id
          WHERE uv.user_id = u.id
        ),
        '[]'::json
      ) AS venues
    FROM users u
    JOIN partners p ON p.id = u.partner_id
    WHERE u.id = ${userId} AND u.role = 'venue_owner' AND u.status = 'active'
    LIMIT 1
  `);

  const row = result.rows[0] as
    | {
        id: string;
        email: string;
        name: string;
        partner_id: string;
        company_name: string;
        venues: Array<{ id: string; name: string; area: string }>;
      }
    | undefined;

  if (!row) return null;

  return {
    user: { id: row.id, email: row.email, name: row.name },
    partner: { id: row.partner_id, companyName: row.company_name },
    venues: row.venues,
  };
}

/*
  The cookie → who's calling. Runs on every authenticated request, so it's one indexed lookup.

  Returns null for expired, unknown, and suspended alike. The route turns all three into the same
  401: from the browser's point of view there is no useful difference, and the app's answer to each
  is identical — go and sign in again.
*/
export async function findSessionByToken(token: string): Promise<PartnerSession | null> {
  const result = await db.execute(sql`
    SELECT user_id FROM sessions
    WHERE token_hash = ${hashToken(token)} AND expires_at > now()
    LIMIT 1
  `);

  const row = result.rows[0] as { user_id: string } | undefined;
  if (!row) return null;

  /* Re-reads the user rather than trusting the session row, so suspending someone in admin takes
     effect on their next request instead of whenever their session happens to lapse. */
  return loadSession(row.user_id);
}

/*
  Ends one session. Idempotent — signing out twice, or with a cookie that's already dead, is a
  no-op rather than an error, because the caller's intent is satisfied either way.
*/
export async function destroySessionByToken(token: string): Promise<void> {
  await db.execute(sql`DELETE FROM sessions WHERE token_hash = ${hashToken(token)}`);
}
