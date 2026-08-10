import { type SQL, sql } from "drizzle-orm";

/*
  "Is this venue open right now" — decided here, never on a client.

  Three reasons it lives server-side: it leans on the current time (device clocks are wrong and
  we don't trust them), it needs the hours table (which we deliberately don't ship to clients), and
  it's the natural place to grow holiday and one-off-closure handling later.

  ⚠️ The midnight-crossing case is the whole difficulty. Restaurants here close at 01:00, so a row
  reading Friday 10:00–01:00 means "opens Friday morning, closes Saturday morning". At 00:30 on
  Saturday the venue is open because of FRIDAY's row. Naive `time BETWEEN opens AND closes` reports
  it closed, which is the bug every version of this has, and it only shows up after midnight when
  nobody's testing.

  weekday is ISO-8601: 1 = Monday … 7 = Sunday, matching Postgres' EXTRACT(ISODOW).
*/

export const TIMEZONE = "Europe/Bucharest";

/*
  Local wall-clock time and weekday, plus yesterday's weekday for the after-midnight lookup.
  Everything below joins against this, so "now" is evaluated once per query rather than per row.

  `at` overrides the clock and exists ONLY for tests — the interesting cases here happen after
  midnight and there's no other way to exercise them. Production always calls this with no
  argument. It's a parameter rather than a duplicated query so the tests can't drift from the
  code they're meant to be checking.
*/
export function localTimeContext(at?: string): SQL {
  const instant = at ? sql`${at}::timestamp` : sql`now() AT TIME ZONE ${TIMEZONE}`;
  return sql`
    (SELECT
       ts::time                                    AS local_time,
       EXTRACT(ISODOW FROM ts)::int                AS dow,
       -- yesterday in ISO terms, wrapping Monday(1) back to Sunday(7)
       (((EXTRACT(ISODOW FROM ts)::int + 5) % 7) + 1) AS prev_dow
     FROM (SELECT ${instant} AS ts) _t
    ) AS t
  `;
}

/* What every production query uses. */
export const localNow: SQL = localTimeContext();

/* Correlates against `v.id`, so the caller must alias the venues table as `v`. */
export const isOpenNow: SQL = sql`
  EXISTS (
    SELECT 1 FROM opening_hours oh
    WHERE oh.venue_id = v.id
      AND (
        -- ordinary window that opens and closes on the same day
        (oh.weekday = t.dow
          AND oh.closes_at > oh.opens_at
          AND t.local_time >= oh.opens_at
          AND t.local_time <  oh.closes_at)
        -- opens today and runs past midnight: anything after opening still counts
        OR (oh.weekday = t.dow
          AND oh.closes_at <= oh.opens_at
          AND t.local_time >= oh.opens_at)
        -- opened YESTERDAY and hasn't closed yet: the 00:30-on-Saturday case
        OR (oh.weekday = t.prev_dow
          AND oh.closes_at <= oh.opens_at
          AND t.local_time < oh.closes_at)
      )
  )
`;

/*
  When it next opens, as "HH:MM", for the closed state. NULL if the venue has no hours at all.

  The ordering trick: (weekday - dow + 7) % 7 gives days from today. Today counts as 0 only if the
  opening is still ahead of us — otherwise it's already been and belongs a full week out, hence 7.
*/
export const nextOpeningAt: SQL = sql`
  (SELECT to_char(oh.opens_at, 'HH24:MI')
   FROM opening_hours oh
   WHERE oh.venue_id = v.id
   ORDER BY
     CASE
       WHEN (oh.weekday - t.dow + 7) % 7 = 0 AND oh.opens_at > t.local_time THEN 0
       WHEN (oh.weekday - t.dow + 7) % 7 = 0 THEN 7
       ELSE (oh.weekday - t.dow + 7) % 7
     END,
     oh.opens_at
   LIMIT 1)
`;

/*
  Today's opening windows as "HH:MM" pairs, for printing next to the open/closed line. An empty
  array means the venue isn't open at all today — which is not the same as having no hours on file,
  and `nextOpeningAt` is what tells those two apart.

  Today's weekday row, nothing cleverer: at 00:30 on Saturday this returns SATURDAY's hours even
  though the venue is open on Friday's row running to 02:00. That's the right answer to "what are
  today's hours" and the wrong one to "when does this close", so nothing but the detail screen's
  hours line should read it. `isOpenNow` remains the only source of open/closed.

  Correlates against `v.id` and the `t` alias from localTimeContext, same as the two above.
*/
export const todayHours: SQL = sql`
  COALESCE((
    SELECT json_agg(json_build_object(
             'opensAt', to_char(oh.opens_at, 'HH24:MI'),
             'closesAt', to_char(oh.closes_at, 'HH24:MI')
           ) ORDER BY oh.opens_at)
    FROM opening_hours oh
    WHERE oh.venue_id = v.id AND oh.weekday = t.dow
  ), '[]'::json)
`;
