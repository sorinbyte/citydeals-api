import { index, pgTable, primaryKey, uuid } from "drizzle-orm/pg-core";

import { venues } from "@/db/schema/catalogue";
import { timestamps } from "@/db/schema/columns";
import { members } from "@/db/schema/identity";

/*
  Venues a member saved to come back to.

  A join table rather than a row with an id(), following user_venues: there is nothing to say about
  a favourite beyond who and what, so a surrogate key would only be a second way to name the same
  pair — and then something would eventually insert the pair twice.

  ⚠️ Venues, not deals. A deal is switched off and replaced by a partner whenever they feel like it,
  so a saved deal quietly becomes an entry pointing at nothing; "I like this restaurant" outlives
  "I like this 1+1". If per-deal saving is ever wanted it's a second table, not a column here.

  ⚠️ No "order" or "collection" column, deliberately. The tab is newest-first and that's an ORDER BY
  over created_at — a stored position is a thing every insert has to renumber.
*/
export const memberFavourites = pgTable(
  "member_favourites",
  {
    /*
      ⚠️ CASCADE on both sides, which is the opposite of `redemptions` and worth being explicit
      about. A favourite is a preference, not a record of something that happened — there is no
      dispute to settle with it later, so a deleted member or a removed venue should take its
      favourites along. A redemption is evidence and uses RESTRICT for exactly that reason.
    */
    memberId: uuid("member_id")
      .notNull()
      .references(() => members.id, { onDelete: "cascade" }),
    venueId: uuid("venue_id")
      .notNull()
      .references(() => venues.id, { onDelete: "cascade" }),
    ...timestamps,
  },
  (t) => [
    /*
      ⚠️ The composite key is what makes the endpoint idempotent — it turns adding a favourite into
      `INSERT … ON CONFLICT DO NOTHING`, so favouriting twice is a no-op rather than a duplicate row
      or an error the client has to interpret.

      That matters more than it sounds: the heart is optimistic, and a double-tap on bad wifi
      genuinely does send the same request twice.
    */
    primaryKey({ columns: [t.memberId, t.venueId] }),

    /* The tab's only ordering. The primary key can find a member's rows but can't sort them. */
    index("member_favourites_recent_idx").on(t.memberId, t.createdAt.desc()),

    /*
      ⚠️ NOT for a screen — nothing asks "who favourited this venue" yet.

      Postgres does not index a referencing column automatically, and without one every venue delete
      seq-scans this whole table to work out what to cascade. Same shape as user_venues_venue_idx,
      different motive: that one answers a question, this one keeps a delete cheap.
    */
    index("member_favourites_venue_idx").on(t.venueId),
  ],
);
