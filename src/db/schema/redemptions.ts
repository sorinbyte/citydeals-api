import { sql } from "drizzle-orm";
import { index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

import { deals, venues } from "@/db/schema/catalogue";
import { id, timestamps } from "@/db/schema/columns";
import { members } from "@/db/schema/identity";

/*
  The redemption itself, and the venue devices that confirm one.

  This is the table the whole product rests on: AGENTS.md calls redemption fraud the #1 operational
  risk, and everything in here is shaped by two requirements from it — verification has to be atomic
  and single-use under concurrency, and every redemption has to still be answerable months later when
  a partner disputes a bill.

  Which is why nothing here is ever deleted.
*/

/*
  One issued code. Alive from the moment the app asks for it until it's consumed, voided or expires.

  ⚠️ No `status` column, same rule as isOpen and member trial state — live / used / expired / voided
  are all answerable from the three timestamps below plus now(). A stored status is wrong the instant
  the clock passes it and needs a cron job to stay true.
*/
export const redemptions = pgTable(
  "redemptions",
  {
    id: id(),

    /*
      RESTRICT on all three, not CASCADE.

      This table IS the dispute record. A deal deleted in the partner dashboard, or a venue removed,
      must not quietly take the history of what was served with it — the argument being settled is
      usually about a venue or a deal that has since changed. Deleting a member becomes a deliberate
      anonymisation job (null the phone, keep the row), not something a foreign key does by accident.
    */
    memberId: uuid("member_id")
      .notNull()
      .references(() => members.id, { onDelete: "restrict" }),
    /* Denormalised from the deal on purpose — it's what the confirm checks against, and resolving it
       through deals at verify time would be a join on the hottest path in the product. */
    venueId: uuid("venue_id")
      .notNull()
      .references(() => venues.id, { onDelete: "restrict" }),
    dealId: uuid("deal_id")
      .notNull()
      .references(() => deals.id, { onDelete: "restrict" }),

    /* SHA-256 of the random bytes in the QR url. Plaintext exists on the member's screen and in the
       scan, never at rest — same rule as login_tokens and sessions. */
    tokenHash: text("token_hash").notNull(),
    /*
      The typed fallback, for when the scan won't work — a cracked screen, a camera that won't focus,
      a phone with the permission denied. Hashed too: the app gets the plaintext once in the issue
      response and holds it in memory, and nothing ever needs to read it back out of here.
    */
    shortCodeHash: text("short_code_hash").notNull(),

    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),

    /*
      ⚠️ Two columns, not one, and this is the difference that matters.

      login_tokens overloads consumed_at for both "used" and "superseded", which is fine for a magic
      link. Here they're completely different facts: consumed means a member actually got a discount
      at a counter, voided means we threw the code away because they asked for another one. A voided
      row that looks consumed is a redemption we'd bill a partner for that never happened.
    */
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    voidedAt: timestamp("voided_at", { withTimezone: true }),

    ...timestamps,
  },
  (t) => [
    uniqueIndex("redemptions_token_hash_key").on(t.tokenHash),

    /*
      ⚠️ THE one-live-code rule, enforced here rather than in the service.

      A double-tapped "Deblochează oferta" fires two issues at once. Both void what's outstanding,
      both insert, and without this index both succeed — the member walks away with two live codes
      for two different venues. Checking in JavaScript first doesn't help; that's the same
      read-then-write AGENTS.md rules out for verification, for the same reason.

      The predicate can't mention now(), so an expired-but-unvoided row would block issuing forever.
      The issue path therefore voids EVERYTHING outstanding — expired included — before inserting.
    */
    uniqueIndex("redemptions_one_live_per_member")
      .on(t.memberId)
      .where(sql`consumed_at IS NULL AND voided_at IS NULL`),

    /*
      The fallback code is only ever looked up within the venue whose staff are typing it, so
      uniqueness only has to hold there.

      Global uniqueness would be wrong at scale: 6 characters from a 32-symbol alphabet is about a
      billion, which starts colliding by the birthday bound somewhere around 100k rows. Per venue,
      among codes that haven't been used, it never gets close. The generator still retries on
      conflict, because "never gets close" is not the same as "cannot".
    */
    uniqueIndex("redemptions_venue_short_code_key")
      .on(t.venueId, t.shortCodeHash)
      .where(sql`consumed_at IS NULL`),

    /* Drives the refresh_days cooldown: "when did this member last actually use this deal". */
    index("redemptions_member_deal_idx").on(t.memberId, t.dealId, t.consumedAt),
    /* The partner's own history, once /utilizari gets built. */
    index("redemptions_venue_idx").on(t.venueId, t.createdAt.desc()),
  ],
);

/*
  A staff phone that has proved it knows the venue's PIN.

  The point of the whole design is that venue employees install nothing, so "logged in" has to mean
  a cookie in whatever browser the scan opened. This is what that cookie points at.

  ⚠️ A table rather than an HMAC-signed cookie, for the same reason sessions is a table rather than a
  JWT: revocation. A venue that loses a phone, or fires someone, needs the grant to actually end —
  and with a signed cookie the only way to end one is to rotate the key and sign every other device
  out at the same time.

  ⚠️ It also carries the lockout below on its back. A wrong-PIN lockout is a denial of service on a
  real counter unless already-enrolled devices keep working straight through it. That relationship is
  load-bearing — see services/venue-pin.ts before weakening either half.
*/
export const venueDevices = pgTable(
  "venue_devices",
  {
    id: id(),
    venueId: uuid("venue_id")
      .notNull()
      .references(() => venues.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    /* Not analytics — it's how you tell a phone still behind the bar from one that left with an
       employee in March, which is the only way to prune this list sensibly later. */
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("venue_devices_hash_key").on(t.tokenHash),
    /* "Sign out every device at this venue" — the answer to a leaked PIN. */
    index("venue_devices_venue_idx").on(t.venueId),
  ],
);
