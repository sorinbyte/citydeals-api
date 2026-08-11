import { type SQL, sql } from "drizzle-orm";

import { db } from "@/db/client";
import type { AdminMember, AdminMemberSort, Paginated } from "@/types/api";

/*
  Reads behind the admin members page.

  ⚠️ Real people, and the only place in this product that serves a verified personal phone number.
  Nothing here is public, nothing here is cached, and the projection is deliberately small: name,
  phone, trial state, when they were last seen. If a column isn't needed to answer a support
  question, it isn't selected.

  ⚠️ What this CANNOT show, because none of it exists yet:

    · subscription status and plan — `members` carries our own trial dates and nothing a payment
      provider owns. There is no subscriptions table.
    · redemption counts — there is no redemptions table either.

  So there is no "activ"/"anulat", no lunar/anual, and no usage. Three of the four segments the
  design called for ("zero utilizări", "frecvenți", "plată eșuată") depend on those and are absent
  rather than faked.
*/

/*
  Postgres hands back its own text format for a top-level timestamptz ("2026-08-11 21:28:29+00", a
  space instead of a T), which new Date() parses in V8 and not by spec. Same helper and same reason
  as services/venues.ts and services/partners.ts.
*/
const isoTimestamp = (column: SQL) => sql`to_json(${column})#>>'{}'`;

/*
  Trial state, decided here rather than by a client comparing dates.

  Both nulls mean the trial was never started, which is a different thing from one that ended — a
  member who verified and never began is a funnel problem, one whose trial lapsed is a sales one.
*/
const trialState = sql`
  CASE
    WHEN m.trial_ends_at IS NULL THEN 'none'
    WHEN m.trial_ends_at > now() THEN 'active'
    ELSE 'expired'
  END
`;

const memberColumns = sql`
  m.id,
  m.name,
  m.phone,
  ${isoTimestamp(sql`m.phone_verified_at`)} AS phone_verified_at,
  ${trialState}                             AS trial_state,
  ${isoTimestamp(sql`m.trial_ends_at`)}     AS trial_ends_at,
  ${isoTimestamp(sql`m.last_seen_at`)}      AS last_seen_at,
  ${isoTimestamp(sql`m.created_at`)}        AS created_at
`;

type MemberRow = {
  id: string;
  name: string | null;
  phone: string;
  phone_verified_at: string;
  trial_state: AdminMember["trialState"];
  trial_ends_at: string | null;
  last_seen_at: string | null;
  created_at: string;
};

/* Same Romanian collation the catalogue uses — the database collation is C.UTF-8 and would sort
   ă/ș/ț after z. A member list sorted that way looks broken to the person reading it. */
const RO_COLLATE = sql`COLLATE "ro-RO-x-icu"`;

/*
  ⚠️ These take the direction rather than having it appended, because NULLS LAST has to come AFTER
  the ASC/DESC keyword. Interpolating the direction later produces "… NULLS LAST ASC", which is a
  syntax error surfacing as a 500 with nothing pointing at the sort.

  (Made exactly this mistake in services/venues.ts first, where the fix was to drop the clause and
  accept Postgres' default. Here the default isn't good enough: it flips with direction, and three
  of these columns are nullable in a way that matters — "never seen" belongs at the BOTTOM whichever
  way you're sorting, because it isn't a small last-seen date, it's the absence of one.)

  ⚠️ Every mode ends with m.id. A name isn't unique, a null last_seen certainly isn't, and an order
  that doesn't fully determine row position lets LIMIT/OFFSET return the same person on two pages.
*/
const ORDER_BY: Record<AdminMemberSort, (direction: SQL) => SQL> = {
  name: (d) => sql`m.name ${RO_COLLATE} ${d} NULLS LAST, m.id`,
  phone: (d) => sql`m.phone ${d}, m.id`,
  trial: (d) => sql`m.trial_ends_at ${d} NULLS LAST, m.id`,
  lastSeen: (d) => sql`m.last_seen_at ${d} NULLS LAST, m.id`,
  joined: (d) => sql`m.created_at ${d}, m.id`,
};

/*
  LIKE metacharacters have to be escaped or search quietly does the wrong thing — a "%" matches
  every member. Same helper and reasoning as the catalogue search.
*/
const escapeLike = (value: string) => value.replace(/[\\%_]/g, "\\$&");

export async function listMembersForAdmin({
  search,
  expiringTrial,
  sort,
  direction,
  page,
  perPage,
}: {
  search?: string;
  /* The one segment with a source: trials ending within three days. members_trial_ends_idx exists
     for exactly this. */
  expiringTrial?: boolean;
  sort: AdminMemberSort;
  direction: "asc" | "desc";
  page: number;
  perPage: number;
}): Promise<Paginated<AdminMember>> {
  const offset = (page - 1) * perPage;

  /*
    Phone or name.

    ⚠️ The phone match strips every non-digit from BOTH sides, so "0721 100 206", "+40721100206"
    and "721100206" all find the same person. Support gets the number in whatever shape the member
    typed it into a chat, and a lookup that only matches E.164 is a lookup that fails exactly when
    it's needed.

    ⚠️ The phone clause is only added when the search actually CONTAINS digits. Stripping non-digits
    from "Maria" leaves an empty string, and `LIKE '%%'` matches every row — so a name search would
    silently return the whole table while looking like it had worked.

    There is no email to search: `members` has no email column. Verification is by phone.
  */
  const digits = search?.replace(/\D/g, "") ?? "";
  const searchClauses: SQL[] = [];

  if (digits) {
    searchClauses.push(
      sql`regexp_replace(m.phone, '\\D', '', 'g') LIKE ${`%${escapeLike(digits)}%`}`,
    );
  }
  if (search) {
    searchClauses.push(sql`m.name ILIKE ${`%${escapeLike(search)}%`}`);
  }

  const searchFilter = searchClauses.length
    ? sql`AND (${sql.join(searchClauses, sql` OR `)})`
    : sql``;

  const trialFilter = expiringTrial
    ? sql`AND m.trial_ends_at > now() AND m.trial_ends_at <= now() + interval '3 days'`
    : sql``;

  const where = sql`WHERE true ${searchFilter} ${trialFilter}`;
  const orderDirection = direction === "asc" ? sql`ASC` : sql`DESC`;

  const [rows, counted] = await Promise.all([
    db.execute(sql`
      SELECT ${memberColumns}
      FROM members m
      ${where}
      ORDER BY ${ORDER_BY[sort](orderDirection)}
      LIMIT ${perPage} OFFSET ${offset}
    `),
    // same filters, or totalPages disagrees with the rows and the client pages into an empty list
    db.execute(sql`SELECT count(*)::int AS total FROM members m ${where}`),
  ]);

  const total = (counted.rows[0] as { total: number } | undefined)?.total ?? 0;

  return {
    items: (rows.rows as MemberRow[]).map((row) => ({
      id: row.id,
      name: row.name,
      phone: row.phone,
      phoneVerifiedAt: row.phone_verified_at,
      trialState: row.trial_state,
      trialEndsAt: row.trial_ends_at,
      lastSeenAt: row.last_seen_at,
      createdAt: row.created_at,
    })),
    page,
    perPage,
    total,
    totalPages: Math.max(1, Math.ceil(total / perPage)),
  };
}
