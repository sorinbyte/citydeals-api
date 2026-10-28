import { sql } from "drizzle-orm";

import { db } from "@/db/client";
import { normalisePhone } from "@/services/member-auth";
import type { ContactMatch, FollowedMember } from "@/types/api";

/*
  The Prieteni tab: which of your contacts are on Crunch, and who you follow.

  ⚠️ PRIVACY CONTRACT — the app and the privacy policy both promise this, so don't break it here:
  the numbers sent to matchContacts are compared and dropped. Not stored, not logged, not put in
  an error message. The only thing that persists is a follow the member chose to make.

  ⚠️ The answer carries no names. It echoes the number exactly as the phone sent it, so the app can
  show the name from its own address book. A server-side name would let anyone with a list of
  numbers read off who's who; this way they learn "is a member" and nothing more, and the route's
  rate limit keeps even that slow.
*/

/* "Teodora Zamfir" → "Teodora Z." — enough to recognise a friend in a list, not a full name. */
function shortName(name: string | null): string | null {
  const parts = name?.trim().split(/\s+/).filter(Boolean) ?? [];
  const [first, ...rest] = parts;
  if (!first) return null;
  const last = rest.at(-1);
  return last ? `${first} ${last.charAt(0).toLocaleUpperCase("ro")}.` : first;
}

export async function matchContacts(memberId: string, phones: string[]): Promise<ContactMatch[]> {
  /* One contact can be saved as "0722 …" and "+40722…" — both map to the same member, and the app
     needs each spelling back to find its contact, so this is normalised → every spelling sent. */
  const sentAs = new Map<string, string[]>();
  for (const raw of phones) {
    const phone = normalisePhone(raw);
    if (!phone) continue;
    const list = sentAs.get(phone);
    if (list) list.push(raw);
    else sentAs.set(phone, [raw]);
  }
  if (sentAs.size === 0) return [];

  const result = await db.execute(sql`
    SELECT m.id, m.phone,
      EXISTS (
        SELECT 1 FROM follows f
        WHERE f.follower_member_id = ${memberId} AND f.followee_member_id = m.id
      ) AS following
    FROM members m
    WHERE m.phone IN (${sql.join([...sentAs.keys()], sql`, `)})
      AND m.id <> ${memberId}
  `);

  const rows = result.rows as Array<{ id: string; phone: string; following: boolean }>;
  return rows.flatMap((row) =>
    (sentAs.get(row.phone) ?? []).map((phone) => ({
      phone,
      memberId: row.id,
      following: row.following,
    })),
  );
}

export async function listFollowing(memberId: string): Promise<FollowedMember[]> {
  const result = await db.execute(sql`
    SELECT m.id, m.name, to_json(f.created_at)#>>'{}' AS followed_at
    FROM follows f
    JOIN members m ON m.id = f.followee_member_id
    WHERE f.follower_member_id = ${memberId}
    ORDER BY f.created_at DESC
    LIMIT 500
  `);

  return (result.rows as Array<{ id: string; name: string | null; followed_at: string }>).map(
    (row) => ({ id: row.id, name: shortName(row.name), followedAt: row.followed_at }),
  );
}

/*
  Follows several at once — the sheet confirms everyone ticked in one go.

  The SELECT is what drops ids that aren't members and your own id (the check constraint would
  throw on that instead), and ON CONFLICT makes a repeat a no-op.
*/
export async function follow(memberId: string, memberIds: string[]): Promise<void> {
  if (memberIds.length === 0) return;
  await db.execute(sql`
    INSERT INTO follows (follower_member_id, followee_member_id)
    SELECT ${memberId}, m.id
    FROM members m
    WHERE m.id IN (${sql.join(memberIds, sql`, `)}) AND m.id <> ${memberId}
    ON CONFLICT DO NOTHING
  `);
}

/* Idempotent, like removing a favourite. */
export async function unfollow(memberId: string, followeeId: string): Promise<void> {
  await db.execute(sql`
    DELETE FROM follows
    WHERE follower_member_id = ${memberId} AND followee_member_id = ${followeeId}
  `);
}
