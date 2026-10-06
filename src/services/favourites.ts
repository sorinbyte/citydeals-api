import { sql } from "drizzle-orm";

import { db } from "@/db/client";

/*
  Who saved what.

  Only the membership lives here. The venue payload a favourites list renders is assembled by
  `listFavouriteVenues` in services/venues.ts, beside `summaryColumns` — see the note there for why
  that split matters.
*/

/*
  Saves a venue, or does nothing if it was already saved.

  ⚠️ One statement, not a read then a write. The SELECT is what proves the venue exists and is
  published, and ON CONFLICT is what makes a repeat a no-op — so a double-tapped heart on bad wifi
  can't produce a duplicate, an error, or a favourite pointing at a venue we've pulled.

  Returns false only for a venue that isn't there, which the route turns into VENUE_NOT_FOUND.
*/
export async function addFavourite(memberId: string, venueId: string): Promise<boolean> {
  const result = await db.execute(sql`
    INSERT INTO member_favourites (member_id, venue_id)
    SELECT ${memberId}, v.id
    FROM venues v
    WHERE v.id = ${venueId} AND v.is_published
    ON CONFLICT (member_id, venue_id) DO NOTHING
    RETURNING venue_id
  `);

  /*
    ⚠️ Zero rows is ambiguous — it means EITHER no such venue OR it was already saved — so it can't
    be reported as a failure on its own. Asking separately keeps "save something twice" silent,
    which is what an idempotent endpoint owes its caller.
  */
  if (result.rows.length > 0) return true;

  const exists = await db.execute(sql`
    SELECT 1 FROM member_favourites
    WHERE member_id = ${memberId} AND venue_id = ${venueId}
    LIMIT 1
  `);

  return exists.rows.length > 0;
}

/* Idempotent, like adding. Removing something that was never saved is a no-op rather than a 404 —
   the caller's intent is satisfied either way, and an optimistic heart can genuinely send this
   twice. */
export async function removeFavourite(memberId: string, venueId: string): Promise<void> {
  await db.execute(sql`
    DELETE FROM member_favourites
    WHERE member_id = ${memberId} AND venue_id = ${venueId}
  `);
}

/*
  Every venue id this member saved. Unpaginated, deliberately.

  The hearts have to be right on whatever the member is looking at — the home rows, search, the map
  — not just on the first page of their own favourites list. A member with fifty saved venues would
  otherwise see thirty of them rendered as unsaved. It's a list of uuids; even an enthusiast is a
  couple of KB.

  ⚠️ Not filtered by is_published. An unfavourited-by-us venue would otherwise show a hollow heart
  that fills, saves nothing new, and stays hollow. Better that the heart matches the row we hold.
*/
export async function listFavouriteIds(memberId: string): Promise<string[]> {
  const result = await db.execute(sql`
    SELECT venue_id FROM member_favourites
    WHERE member_id = ${memberId}
    ORDER BY created_at DESC
  `);

  return (result.rows as Array<{ venue_id: string }>).map((row) => row.venue_id);
}
