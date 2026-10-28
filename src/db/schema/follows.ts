import { sql } from "drizzle-orm";
import { check, index, pgTable, primaryKey, timestamp, uuid } from "drizzle-orm/pg-core";

import { members } from "@/db/schema/identity";

/*
  Who follows whom, for the Prieteni tab. One way, like NeoTaste — following Bobby doesn't make
  Bobby follow you back.

  ⚠️ This is the ONLY thing the contact matching leaves behind. The numbers the app sends to
  /member/contacts/match are compared and dropped (services/friends.ts); what's stored is just the
  pair of members someone chose to follow.

  CASCADE on both sides, same reasoning as member_favourites: a follow is a preference, not a record
  of something that happened, so it goes with either account.
*/
export const follows = pgTable(
  "follows",
  {
    followerMemberId: uuid("follower_member_id")
      .notNull()
      .references(() => members.id, { onDelete: "cascade" }),
    followeeMemberId: uuid("followee_member_id")
      .notNull()
      .references(() => members.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    /* The pair is the key, so following twice is ON CONFLICT DO NOTHING rather than a duplicate. */
    primaryKey({ columns: [t.followerMemberId, t.followeeMemberId] }),
    check("follows_not_self", sql`${t.followerMemberId} <> ${t.followeeMemberId}`),
    /* Keeps a member delete from seq-scanning this table to cascade — and "who follows me" later. */
    index("follows_followee_idx").on(t.followeeMemberId),
  ],
);
