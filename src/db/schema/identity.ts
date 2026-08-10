import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  check,
  index,
  pgEnum,
  pgTable,
  primaryKey,
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
