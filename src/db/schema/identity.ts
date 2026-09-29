import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  check,
  index,
  pgEnum,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { venues } from "@/db/schema/catalogue";
import { id, timestamps } from "@/db/schema/columns";
import { partners } from "@/db/schema/partners";

/*
  Who exists. Two tables, on purpose — `users` for the web, `members` for the app.

  They are not one table with a role column because the identity primitive genuinely differs: a web
  user is an email, a member is a +40 phone. Merging them means every row carries a null for one of
  the two plus a check constraint per role to keep it honest, and `members` goes on to grow
  subscriptions, redemptions and the whole GDPR surface that no web user ever touches.

  ⚠️ There is no password or credential column anywhere in this file, and that is not an oversight.
  The auth mechanism is still undecided (AGENTS.md), and admin has no password at all — Cloudflare
  Access authenticates before the app loads. Credentials arrive with the auth change, designed
  against whatever is actually chosen, rather than being guessed at now.
*/

/*
  Web roles. `member` is deliberately absent — members live in their own table and there is no
  member login on the web, ever. That pressure toward the app is the product decision, not an
  omission.
*/
export const userRole = pgEnum("user_role", ["platform_owner", "venue_owner"]);

/* Whether this person may sign in. Separate from partners.status — suspending an owner must not
   unconfirm their company or take their venues offline. */
export const userStatus = pgEnum("user_status", ["active", "suspended"]);

export const users = pgTable(
  "users",
  {
    id: id(),
    /*
      Uniqueness is on lower(email), not on the raw column — see the index below. Plain unique
      would let "Ion@x.ro" and "ion@x.ro" be two accounts, which is a support ticket and an
      invite that lands in the wrong inbox.
    */
    email: text("email").notNull(),
    name: text("name").notNull(),
    role: userRole("role").notNull(),
    status: userStatus("status").notNull().default("active"),
    /*
      The company this person works for. Null for platform_owner (we work for nobody), set for
      venue_owner — enforced by the check below.

      This says WHO they belong to. It deliberately does not say what they can see; that's
      user_venues, because a chain can have one manager per location.
    */
    partnerId: uuid("partner_id").references((): AnyPgColumn => partners.id, {
      onDelete: "cascade",
    }),

    /*
      The invite lifecycle, as three facts rather than a status column.

      The admin table's badge (Trimis / Acceptat / Expirat) is DERIVED from these: accepted if
      inviteAcceptedAt is set, expired if not and inviteExpiresAt has passed, sent otherwise. Same
      reasoning as isOpen and member status — a stored "expirat" is wrong the moment the clock
      passes it and needs a cron job to stay true.
    */
    invitedAt: timestamp("invited_at", { withTimezone: true }),
    inviteExpiresAt: timestamp("invite_expires_at", { withTimezone: true }),
    inviteAcceptedAt: timestamp("invite_accepted_at", { withTimezone: true }),

    /* Null means never signed in. That's a real signal the admin table renders in red, not
       missing data — an invite nobody acted on. */
    lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    /*
      Functional index, which is why it's raw SQL — drizzle's uniqueIndex().on() takes columns, not
      expressions. Every lookup by email must match this: WHERE lower(email) = lower($1), or the
      index isn't used and the case-insensitivity isn't enforced at read time either.
    */
    uniqueIndex("users_email_lower_key").on(sql`lower(${t.email})`),
    index("users_partner_idx").on(t.partnerId),
    /*
      A platform_owner works for the platform, so a partner_id on one is nonsense that would quietly
      scope us to a single company. A venue_owner with no company is an orphan nobody can administer.
      Both are perfectly insertable without this.
    */
    check(
      "users_partner_matches_role",
      sql`(${t.role} = 'platform_owner' AND ${t.partnerId} IS NULL)
          OR (${t.role} = 'venue_owner' AND ${t.partnerId} IS NOT NULL)`,
    ),
  ],
);

/*
  Which venues a user may act on. THE scoping list.

  Explicit grants rather than inferring "everything my partner owns", because restaurant groups
  really do put one manager on one location. Inference would make that a schema change later, and
  AGENTS.md is blunt that retrofitting venue scoping is painful.

  ⚠️ These ids go into the WHERE clause of the query itself. Fetching a venue's stats and then
  checking ownership is how you leak another partner's revenue through a forgotten branch.

  Nothing is granted here for platform_owner — that role isn't scoped, and an empty grant list must
  never be read as "sees everything". The role decides that, not this table.
*/
export const userVenues = pgTable(
  "user_venues",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    venueId: uuid("venue_id")
      .notNull()
      .references(() => venues.id, { onDelete: "cascade" }),
    ...timestamps,
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.venueId] }),
    // the reverse question — "who can administer this venue" — which the PK's leading column can't answer
    index("user_venues_venue_idx").on(t.venueId),
  ],
);

/*
  What a one-time link is for. The token itself is identical either way — same length, same
  hashing, same expiry rules — but which one it is decides what happens on the way in: an accepted
  invite stamps users.invite_accepted_at, an ordinary login doesn't.

  Kept as a column rather than two tables because everything else about them is the same, and two
  near-identical tables is how the consume path ends up written twice and fixed once.
*/
export const loginTokenPurpose = pgEnum("login_token_purpose", ["login", "invite"]);

/*
  Magic links. The whole of partner authentication, since there is no password anywhere in this
  schema and there isn't going to be.

  ⚠️ The raw token is NEVER stored. `token_hash` is SHA-256 of the value that went in the email, so
  a database dump — a backup on someone's laptop, a leaked read replica — is a list of useless
  hashes rather than a set of live logins. The plaintext exists in exactly two places: the email,
  and the request that redeems it.

  SHA-256 rather than bcrypt/argon2 on purpose. Those exist to make LOW-entropy secrets expensive
  to guess; these tokens are 32 random bytes, so there is nothing to brute force and a slow hash
  would only make every sign-in slower.
*/
export const loginTokens = pgTable(
  "login_tokens",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /* Unique so a hash collision or a repeated insert can't produce two rows one consume would
       have to choose between. */
    tokenHash: text("token_hash").notNull(),
    purpose: loginTokenPurpose("purpose").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    /*
      Single use, recorded rather than deleted.

      Deleting on redemption would be simpler and worse: "this link was already used" and "this link
      never existed" would become the same answer, and the first is a thing that happens honestly —
      an email scanner follows the link before the person does. Keeping the row lets the API say
      TOKEN_USED, which the partner app words as "cere unul nou" instead of "invalid".
    */
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("login_tokens_hash_key").on(t.tokenHash),
    /* Drives "invalidate this person's outstanding links", which happens on every new request so
       asking twice doesn't leave two working links in an inbox. */
    index("login_tokens_user_idx").on(t.userId),
  ],
);

/*
  Live partner sessions. One row per sign-in.

  ⚠️ A table rather than a stateless signed token, and the reason is revocation. Signing out has to
  actually end the session, and suspending a venue_owner in admin has to end theirs — neither is
  possible with a self-contained JWT unless you keep a blocklist, which is this table with extra
  steps and worse failure modes.

  Same hashing rule as above: the cookie holds the plaintext, the database holds SHA-256 of it.
*/
export const sessions = pgTable(
  "sessions",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("sessions_hash_key").on(t.tokenHash),
    /* "End every session this person has" — sign-out-everywhere, and what suspending an account
       should do. */
    index("sessions_user_idx").on(t.userId),
  ],
);

/*
  App members. Phone-first, because that's the anti-fraud anchor: without a verified number one
  subscription gets shared by ten people, and that's what makes partners pull their best offers.

  A row exists here ONLY after phone verification succeeded. "Just installed the app" is therefore
  the absence of a row — the app knows it locally and nothing in Postgres needs to. That keeps this
  table free of junk from bots, store reviewers and reinstalls, and keeps GDPR scoped to people who
  actually signed up.

  ⚠️ No `status` column, deliberately. Installed / phone-confirmed / in-trial / trial-expired are
  all answerable from the columns below plus now(), the same way isOpen is answered from
  opening_hours. A stored status is wrong the instant a trial lapses and needs a cron to stay true.

  Paid and cancelled are NOT answerable yet — that needs `subscriptions`, which waits on the
  payment provider decision (non-IAP: Stripe / Netopia). Don't fake it with a column here.
*/
export const members = pgTable(
  "members",
  {
    id: id(),
    /*
      E.164, +40 only, enforced server-side at verification. Same storage rule as venues.phone:
      never prettified, because a formatted number is one a lookup can't match.
    */
    phone: text("phone").notNull(),
    /*
      NOT NULL on purpose. The row only exists because verification succeeded, so this is an
      invariant rather than a flag — there is no such thing as an unverified member here.

      Kept as a timestamp rather than dropped entirely because "when did they verify" is a real
      anti-fraud question when a number gets recycled between accounts.
    */
    phoneVerifiedAt: timestamp("phone_verified_at", { withTimezone: true }).notNull(),
    // optional — we ask, they can skip, and a support email works fine off the phone number
    name: text("name"),

    /*
      The trial. Ours, not a payment provider's, which is why it can live here while subscriptions
      wait: nothing external owns these two dates.

      Both null = verified but never started a trial. In-trial vs expired is trialEndsAt against
      now(), decided in SQL.
    */
    trialStartedAt: timestamp("trial_started_at", { withTimezone: true }),
    trialEndsAt: timestamp("trial_ends_at", { withTimezone: true }),

    /* Null means they verified and never came back — which is exactly the segment worth knowing
       about, so it's a signal rather than missing data. */
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("members_phone_key").on(t.phone),
    // drives the "trial expiră în 3z" segment on the admin members page
    index("members_trial_ends_idx").on(t.trialEndsAt),
  ],
);

/*
  Live member sessions. The app's half of `sessions` above.

  A separate table rather than a nullable `member_id` on `sessions`, for exactly the reason this
  file opens with: `sessions.user_id` is NOT NULL, so merging them means every row carries a null
  for one side plus a check constraint to keep it honest. Same split, same reasoning.

  ⚠️ The token travels in an Authorization header, not a cookie — the client is a phone, there is no
  browser and no origin, so none of the cookie machinery above applies. It lands in
  expo-secure-store on the device and SHA-256 here, same rule as everything else in this file.
*/
export const memberSessions = pgTable(
  "member_sessions",
  {
    id: id(),
    memberId: uuid("member_id")
      .notNull()
      .references(() => members.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    /*
      Long — 180 days, against the partner dashboard's 30.

      A dashboard opened once a month can afford to ask again; a member cannot, because the moment
      the session lapses is the moment they're standing at a counter with a waiter waiting. It stays
      revocable because it's a row, which is the whole argument for a table over a signed token.
    */
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("member_sessions_hash_key").on(t.tokenHash),
    /* "End every session this member has" — sign-out-everywhere, and what a lost phone needs. */
    index("member_sessions_member_idx").on(t.memberId),
  ],
);

/*
  Phone verification codes. The thing that creates a member.

  ⚠️ `phone` is deliberately NOT a foreign key. The member row doesn't exist yet — verification is
  what brings it into being (see the members comment above: "just installed" is the absence of a
  row). A FK here would make it impossible to verify anyone for the first time.

  The code is hashed, but with SHA-256 rather than the scrypt the venue PIN gets, and the difference
  is worth stating because both are short numbers. A slow hash buys time against an OFFLINE attack
  on a stolen table. This secret is dead in five minutes and capped at five attempts, so there's no
  offline attack worth paying per-verify latency for. The PIN has no expiry at all, which is what
  makes it the opposite case.
*/
export const phoneVerifications = pgTable(
  "phone_verifications",
  {
    id: id(),
    // E.164, +40 only, normalised before it gets here — a prettified number is one no lookup matches
    phone: text("phone").notNull(),
    codeHash: text("code_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    /* Same "recorded, not deleted" rule as login_tokens: it lets "already used" and "never existed"
       stay different answers, and the first one happens honestly when someone double-taps submit. */
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    /*
      Wrong guesses against THIS code. Capped in the service, and the cap is what makes a 6-digit
      secret safe — without it a million requests walks the whole space in minutes.

      On the row rather than in the in-memory limiter on purpose: that one is per-process and resets
      on every deploy, and "redeploy to get more guesses" is not a property you want here.
    */
    attempts: smallint("attempts").notNull().default(0),
    ...timestamps,
  },
  (t) => [
    /* Finding the live code for a number, newest first — the only read this table has. */
    index("phone_verifications_phone_idx").on(t.phone, t.createdAt.desc()),
  ],
);
