import { sql } from "drizzle-orm";
import { check, index, pgTable, smallint, text, timestamp, uuid } from "drizzle-orm/pg-core";

import { venues } from "@/db/schema/catalogue";
import { members } from "@/db/schema/identity";
import { redemptions } from "@/db/schema/redemptions";

/*
  A member's rating of one used offer. Asked right after the venue validates the code, and once
  more on the next app launch if they didn't answer — never a third time.

  ⚠️ One row per REDEMPTION, not per member+venue. You rate a visit, and the next visit to the same
  place is a new answer. It's also what makes "only people who actually used an offer can rate"
  structural: there's nothing to point a row at without a consumed redemption (services/ratings.ts
  checks consumed_at on the way in).

  `stars` null = they said no on the second ask. The row still exists so they're not asked again.

  RESTRICT, like redemptions itself — this is attached to the dispute record and outlives edits to
  the venue. Member deletion is the anonymisation job's problem, same as redemptions.
*/
export const redemptionRatings = pgTable(
  "redemption_ratings",
  {
    redemptionId: uuid("redemption_id")
      .primaryKey()
      .references(() => redemptions.id, { onDelete: "restrict" }),
    memberId: uuid("member_id")
      .notNull()
      .references(() => members.id, { onDelete: "restrict" }),
    /* Denormalised from the redemption so a venue's average is one indexed scan, not a join. */
    venueId: uuid("venue_id")
      .notNull()
      .references(() => venues.id, { onDelete: "restrict" }),
    stars: smallint("stars"),
    comment: text("comment"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("redemption_ratings_stars_range", sql`${t.stars} IS NULL OR ${t.stars} BETWEEN 1 AND 5`),
    /* venue averages for the partner dashboard / admin, once those read it */
    index("redemption_ratings_venue_idx").on(t.venueId, t.createdAt.desc()),
  ],
);
