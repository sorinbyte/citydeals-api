import { index, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

import { id, timestamps } from "@/db/schema/columns";

/*
  People who left an email on the marketing site to hear when the app launches.

  Not members and not accounts — an address, where it was given, and proof of consent. Nothing here
  grants anything, and nothing reads it except the launch announcement (and the admin list).

  Double opt-in: a row exists from the moment the form is sent, but only `confirmed_at` makes it a
  real subscriber. The confirmation link carries a one-time token whose SHA-256 is all we keep —
  same rule as the login links (lib/tokens.ts), the plaintext only ever exists in the email.
*/
export const waitlistSignups = pgTable(
  "waitlist_signups",
  {
    id: id(),
    // lower-cased and trimmed on the way in, so the unique index means "one row per person"
    email: text("email").notNull(),
    /* Which form it came from ("home", "abonament"). Free text — it's for counting, not for logic. */
    source: text("source").notNull(),
    /* When they ticked the consent box. The GDPR record: what they agreed to, and when. */
    consentedAt: timestamp("consented_at", { withTimezone: true }).notNull(),
    /* Set when they click the link in the email. Null = not yet a subscriber. */
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    /* SHA-256 of the outstanding confirmation token; cleared once used. */
    confirmTokenHash: text("confirm_token_hash"),
    confirmTokenExpiresAt: timestamp("confirm_token_expires_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("waitlist_signups_email_key").on(t.email),
    uniqueIndex("waitlist_signups_confirm_token_key").on(t.confirmTokenHash),
    index("waitlist_signups_created_idx").on(t.createdAt),
  ],
);
