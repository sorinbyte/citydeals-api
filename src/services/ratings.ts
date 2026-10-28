import { sql } from "drizzle-orm";

import { db } from "@/db/client";
import type { PendingRating } from "@/types/api";

/*
  Rating a used offer. Two asks at most:
    1. on the member's screen, the moment the venue validates the code
    2. on the next app launch, if (1) went unanswered — and answering "no" there writes a row with
       stars null, which is what stops a third ask

  Nothing is stored for (1) going unanswered: "no row yet" IS the pending state, which keeps this
  to one table and no flags.

  ⚠️ Only the member's own, consumed redemptions can be rated. Both are checked in the same
  statement as the write, so a rating can't be attached to a code that was voided, expired or
  belongs to someone else.
*/

/* How old a visit can be and still get the second ask. Past this, "how was it?" is a stranger's
   question — they'll barely remember, and the answer isn't worth much. */
const PENDING_WINDOW_DAYS = 7;

export type RateResult = "ok" | "not_found";

export async function rateRedemption(
  memberId: string,
  redemptionId: string,
  stars: number,
  comment: string | null,
): Promise<RateResult> {
  /* Upsert, so a member who said "no" on the second ask and then rates from somewhere else later
     still counts, and re-rating the same visit corrects rather than duplicates. */
  const result = await db.execute(sql`
    INSERT INTO redemption_ratings (redemption_id, member_id, venue_id, stars, comment)
    SELECT r.id, r.member_id, r.venue_id, ${stars}, ${comment}
    FROM redemptions r
    WHERE r.id = ${redemptionId} AND r.member_id = ${memberId} AND r.consumed_at IS NOT NULL
    ON CONFLICT (redemption_id) DO UPDATE
      SET stars = EXCLUDED.stars, comment = EXCLUDED.comment, updated_at = now()
    RETURNING redemption_id
  `);
  return result.rows.length > 0 ? "ok" : "not_found";
}

/* The "no thanks" on the second ask. Never overwrites a real rating. */
export async function skipRating(memberId: string, redemptionId: string): Promise<RateResult> {
  const result = await db.execute(sql`
    INSERT INTO redemption_ratings (redemption_id, member_id, venue_id)
    SELECT r.id, r.member_id, r.venue_id
    FROM redemptions r
    WHERE r.id = ${redemptionId} AND r.member_id = ${memberId} AND r.consumed_at IS NOT NULL
    ON CONFLICT (redemption_id) DO NOTHING
    RETURNING redemption_id
  `);
  if (result.rows.length > 0) return "ok";

  /* Zero rows is also "already had a row" — that's still a success for the caller. */
  const exists = await db.execute(sql`
    SELECT 1 FROM redemption_ratings WHERE redemption_id = ${redemptionId} AND member_id = ${memberId}
  `);
  return exists.rows.length > 0 ? "ok" : "not_found";
}

/*
  The one visit to ask about on launch: the member's most recent used offer, within the window,
  with no rating row. Only the latest — if they skipped three in a row, asking about all three at
  once is a questionnaire, not a nudge.
*/
export async function getPendingRating(memberId: string): Promise<PendingRating | null> {
  const result = await db.execute(sql`
    SELECT r.id, v.name AS venue_name, v.slug AS venue_slug, d.title AS deal_title,
      to_json(r.consumed_at)#>>'{}' AS used_at,
      EXISTS (SELECT 1 FROM redemption_ratings rr WHERE rr.redemption_id = r.id) AS answered
    FROM redemptions r
    JOIN venues v ON v.id = r.venue_id
    JOIN deals d ON d.id = r.deal_id
    WHERE r.member_id = ${memberId}
      AND r.consumed_at IS NOT NULL
      AND r.consumed_at > now() - ${PENDING_WINDOW_DAYS} * interval '1 day'
    ORDER BY r.consumed_at DESC
    LIMIT 1
  `);

  const row = result.rows[0] as
    | {
        id: string;
        venue_name: string;
        venue_slug: string;
        deal_title: string;
        used_at: string;
        answered: boolean;
      }
    | undefined;

  /* Latest visit already answered = nothing to ask, even if an older one wasn't. */
  if (!row || row.answered) return null;
  return {
    redemptionId: row.id,
    venueName: row.venue_name,
    venueSlug: row.venue_slug,
    dealTitle: row.deal_title,
    usedAt: row.used_at,
  };
}
