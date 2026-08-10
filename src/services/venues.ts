import { type SQL, sql } from "drizzle-orm";

import { db } from "@/db/client";
import { assetUrl } from "@/lib/assets";
import { isOpenNow, localNow, nextOpeningAt, todayHours } from "@/lib/hours";
import type {
  AdminVenue,
  Deal,
  Menu,
  OpeningWindow,
  Paginated,
  VenueDetail,
  VenueNearby,
  VenueSort,
  VenueSummary,
} from "@/types/api";

/*
  Every read query for the catalogue.

  Two habits throughout, both deliberate:

  1. One round trip per request. Photos, deals and menus come back as aggregated JSON rather than
     as follow-up queries — a venue list doing N+1 lookups is how a browse screen ends up slow on
     a phone, and the phone is the whole product.
  2. Rows are shaped in SQL and mapped once, here. Routes never touch a raw row.
*/

const PER_PAGE = 20;

/*
  How many of a venue's deals a card gets. Cards show all of them, so this is the only thing
  stopping a partner who runs a dozen active offers from producing a card three screens tall.

  Server-side on purpose: which offers are worth showing is a product decision, and a cap each
  client picks for itself is a cap the app and the website disagree about. Three is what fits the
  narrowest card in either surface — the 4-up related-venues grid on the marketing site.
*/
const TOP_DEALS_PER_CARD = 3;

/*
  ⚠️ The database collation is C.UTF-8 (checked: `SELECT datcollate FROM pg_database`), which sorts
  by byte order. That puts every name starting with ă/â/î/ș/ț AFTER Z — "Șarpele Roșu" would land
  below "Zorba". Romanian ICU collation is what a Romanian expects, and it's what the client used
  to do with localeCompare(name, "ro") before this moved server-side.

  No seeded venue starts with a diacritic today, so getting this wrong would have looked fine
  right up until a partner with one was onboarded. Don't drop the COLLATE.

  Every mode ends with v.id. Name is not unique and rating certainly isn't, and an ORDER BY that
  doesn't fully determine row order lets Postgres return a tied row on both page 1 and page 2 —
  or on neither. A unique tiebreaker is what makes LIMIT/OFFSET paging honest.
*/
const RO_COLLATE = sql`COLLATE "ro-RO-x-icu"`;

/*
  LIKE metacharacters have to be escaped, or search quietly does the wrong thing: a member typing
  "%" matches every venue in the catalogue (measured: 30 of 30) and "_" matches any single
  character. Not an injection — the value is bound — just wrong answers.

  Backslash has to be replaced first or it escapes the escapes we just added, which is why this is
  one pass over a character class rather than three sequential .replace() calls.
*/
const escapeLike = (s: string) => s.replace(/[\\%_]/g, "\\$&");

const ORDER_BY: Record<VenueSort, SQL> = {
  // the default, and what the home "Top rated" row leans on
  rating: sql`v.rating DESC NULLS LAST, v.name ${RO_COLLATE}, v.id`,
  az: sql`v.name ${RO_COLLATE} ASC, v.id`,
  za: sql`v.name ${RO_COLLATE} DESC, v.id`,
};

/*
  db.execute hands back Record<string, unknown> rows — it can't know the shape of a hand-written
  query. These types mirror the SELECT lists below; the SQL is the source of truth, and changing a
  column means changing both. Narrowing here keeps the mapping functions honest rather than pushing
  `unknown` outward.
*/
type SummaryRow = {
  id: string;
  slug: string;
  name: string;
  category_key: string;
  area: string;
  rating: number | null;
  rating_count: number;
  tags: string[];
  is_new: boolean;
  is_open: boolean;
  opens_at: string | null;
  image_path: string | null;
  top_deals: Array<{ type: Deal["type"]; title: string; percentOff: number | null }>;
};

/* The columns every venue list and the detail view share. `v` and `t` must be in scope. */
const summaryColumns = sql`
  v.id,
  v.slug,
  v.name,
  v.category_key,
  v.area,
  v.rating::float8            AS rating,
  v.rating_count,
  v.tags,
  v.is_new,
  ${isOpenNow}                AS is_open,
  ${nextOpeningAt}            AS opens_at,
  (SELECT vp.path FROM venue_photos vp
    WHERE vp.venue_id = v.id ORDER BY vp.sort_order LIMIT 1) AS image_path,
  -- LIMIT has to happen in the derived table, before json_agg: an aggregate has no LIMIT, so
  -- capping outside would mean building the array for every active deal and throwing most away.
  -- The ORDER BY is repeated on the aggregate deliberately — a subquery's row order is not
  -- something json_agg is entitled to inherit, and deals_venue_idx (venue_id, sort_order) makes
  -- the inner sort an index read anyway.
  COALESCE((SELECT json_agg(json_build_object(
              'type', d.type, 'title', d.title, 'percentOff', d.percent_off
            ) ORDER BY d.sort_order)
    FROM (SELECT d2.type, d2.title, d2.percent_off, d2.sort_order
          FROM deals d2
          WHERE d2.venue_id = v.id AND d2.is_active
          ORDER BY d2.sort_order
          LIMIT ${TOP_DEALS_PER_CARD}) d), '[]'::json) AS top_deals
`;

function toSummary(row: SummaryRow): VenueSummary {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    categoryKey: row.category_key,
    area: row.area,
    rating: row.rating,
    ratingCount: row.rating_count,
    tags: row.tags,
    isNew: row.is_new,
    isOpen: row.is_open,
    // only meaningful while closed — sending a next-opening time for an open venue invites a
    // client to render "opens at 10:00" on something that's open right now
    opensAt: row.is_open ? null : row.opens_at,
    image: assetUrl(row.image_path),
    topDeals: row.top_deals,
  };
}

export async function listVenues({
  categoryKey,
  subcategoryKey,
  search,
  sort = "rating",
  page,
  perPage = PER_PAGE,
}: {
  categoryKey?: string;
  subcategoryKey?: string;
  search?: string;
  sort?: VenueSort;
  page: number;
  /*
    Callers get a say because the surfaces genuinely differ — the mobile list is an infinite
    scroll at 20, the marketing grid is a 3×3 of 9. The alternative was the client asking for 20
    and rendering 9, which makes `total` and `totalPages` describe a page size the user never
    sees, so "pagina 2" silently skips 11 venues. Capped at the route, not here.
  */
  perPage?: number;
}): Promise<Paginated<VenueSummary>> {
  const offset = (page - 1) * perPage;
  const categoryFilter = categoryKey ? sql`AND v.category_key = ${categoryKey}` : sql``;

  /*
    EXISTS rather than a join to venue_subcategories. A venue can be both 'italian' and 'pizza', so
    a join hands the same venue back once per matching link row — which duplicates rows in the page
    AND inflates count(*). EXISTS also stops at the first match, and
    venue_subcategories_subcategory_idx makes that an index lookup.

    Deliberately not cross-checked against the category: a ('restaurante', 'frizerii') pair returns
    nothing, which is the honest answer and cheaper than a round trip to validate the pairing.
  */
  const subcategoryFilter = subcategoryKey
    ? sql`AND EXISTS (
        SELECT 1 FROM venue_subcategories vs
        WHERE vs.venue_id = v.id AND vs.subcategory_key = ${subcategoryKey}
      )`
    : sql``;

  /*
    Name or tags, diacritic-insensitive both ways — unaccent() on the column AND the needle, so
    "bucuresteana" finds "Bucuresteană" and vice versa. Folding matters more than it sounds: nobody
    reaches for ă/ș/ț on a phone keyboard, so without this, search on a Romanian catalogue looks
    broken to the people using it.

    Matching the same two fields the client used to filter on locally — name and the free-text
    tags. `area` would be a reasonable third, but that's a product call, not a port.

    ⚠️ unaccent() is STABLE, not IMMUTABLE, so this can't use an expression index and it's a seq
    scan. Irrelevant at 30 venues. When it stops being irrelevant, the move is a generated column
    holding unaccent(name) with a pg_trgm GIN index on it — not an IMMUTABLE wrapper around
    unaccent(), which lies to the planner about a dictionary that can be reloaded.
  */
  const needle = search ? `%${escapeLike(search)}%` : null;
  const searchFilter = needle
    ? sql`AND (
        unaccent(v.name) ILIKE unaccent(${needle})
        OR EXISTS (
          SELECT 1 FROM unnest(v.tags) tag WHERE unaccent(tag) ILIKE unaccent(${needle})
        )
      )`
    : sql``;

  const [rows, counted] = await Promise.all([
    db.execute(sql`
      SELECT ${summaryColumns}
      FROM venues v, ${localNow}
      WHERE v.is_published ${categoryFilter} ${subcategoryFilter} ${searchFilter}
      ORDER BY ${ORDER_BY[sort]}
      LIMIT ${perPage} OFFSET ${offset}
    `),
    // the count carries the same filters, or totalPages disagrees with the rows and the client
    // pages into an empty list
    db.execute(sql`
      SELECT count(*)::int AS total
      FROM venues v
      WHERE v.is_published ${categoryFilter} ${subcategoryFilter} ${searchFilter}
    `),
  ]);

  const total = (counted.rows[0] as { total: number } | undefined)?.total ?? 0;

  return {
    items: (rows.rows as SummaryRow[]).map(toSummary),
    page,
    perPage,
    total,
    totalPages: Math.max(1, Math.ceil(total / perPage)),
  };
}

type DetailRow = SummaryRow & {
  address: string;
  phone: string | null;
  logo_path: string | null;
  lat: number;
  lng: number;
  photo_paths: string[];
  today_hours: OpeningWindow[];
  deals: Deal[];
  menu_kind: Menu["kind"] | null;
  menu_sections: Menu["sections"];
};

/*
  Everything a detail view adds on top of summaryColumns. `v` and `t` must be in scope.

  Pulled out of getVenueBySlug so the admin read can select the same thing — one venue shape, not
  two that drift. Public and admin differ in what they're allowed to SEE, not in how a venue is
  described.

  ⚠️ This block ships to the member app and the marketing site. Admin-only fields go in
  adminColumns at the bottom of this file, never here and never in summaryColumns.
*/
const detailColumns = sql`
  v.address,
  v.phone,
  v.logo_path,
  -- geography can't be read directly (it comes back as EWKB hex), so project the coordinates
  ST_Y(v.location::geometry) AS lat,
  ST_X(v.location::geometry) AS lng,
  v.menu_kind,
  COALESCE((SELECT json_agg(vp.path ORDER BY vp.sort_order)
            FROM venue_photos vp WHERE vp.venue_id = v.id), '[]'::json) AS photo_paths,
  -- detail only: a list row has no room for opening times, and this is one more subquery
  ${todayHours} AS today_hours,
  COALESCE((SELECT json_agg(json_build_object(
              'id', d.id, 'type', d.type, 'title', d.title, 'condition', d.condition,
              'percentOff', d.percent_off, 'avgSavingMinor', d.avg_saving_minor,
              'currency', d.currency, 'refreshDays', d.refresh_days, 'people', d.people
            ) ORDER BY d.sort_order)
            FROM deals d WHERE d.venue_id = v.id AND d.is_active), '[]'::json) AS deals,
  COALESCE((SELECT json_agg(section ORDER BY section_order)
            FROM (
              SELECT ms.sort_order AS section_order,
                     json_build_object(
                       'title', ms.title,
                       'items', COALESCE((SELECT json_agg(json_build_object(
                                   'name', mi.name, 'priceMinor', mi.price_minor,
                                   'currency', mi.currency
                                 ) ORDER BY mi.sort_order)
                                 FROM menu_items mi
                                 WHERE mi.section_id = ms.id AND mi.is_available), '[]'::json)
                     ) AS section
              FROM menu_sections ms WHERE ms.venue_id = v.id
            ) s), '[]'::json) AS menu_sections
`;

function toDetail(row: DetailRow): VenueDetail {
  return {
    ...toSummary(row),
    address: row.address,
    phone: row.phone,
    logo: assetUrl(row.logo_path),
    location: { lat: row.lat, lng: row.lng },
    photos: row.photo_paths.map((p) => assetUrl(p)).filter((u): u is string => u !== null),
    todayHours: row.today_hours,
    deals: row.deals,
    // a venue with no price list gets null, so the client hides the button instead of opening
    // an empty sheet
    menu: row.menu_kind ? { kind: row.menu_kind, sections: row.menu_sections } : null,
  };
}

export async function getVenueBySlug(slug: string): Promise<VenueDetail | null> {
  const result = await db.execute(sql`
    SELECT ${summaryColumns}, ${detailColumns}
    FROM venues v, ${localNow}
    WHERE v.slug = ${slug} AND v.is_published
    LIMIT 1
  `);

  const row = result.rows[0] as DetailRow | undefined;
  return row ? toDetail(row) : null;
}

/*
  "Offers near me". PostGIS does the distance work — ST_DWithin on a geography column takes METRES,
  and the GIST index makes it an index scan rather than a walk over every venue.

  No client anywhere computes distance. There is no haversine in this product.
*/
export async function findNearby(
  lat: number,
  lng: number,
  radiusMetres: number,
  limit: number,
): Promise<VenueNearby[]> {
  const point = sql`ST_MakePoint(${lng}, ${lat})::geography`;

  /*
    `false` = measure on a sphere, not the spheroid.

    Not an accuracy shortcut — a consistency one. ORDER BY uses the `<->` KNN operator so the GIST
    index does the work, and on geography that operator measures on a sphere. ST_Distance defaults
    to the spheroid, so the rows come back ordered by one model and labelled with another. They
    disagree by ~2m in 5km, which is enough to render a visibly out-of-order pair when two venues
    are near-tied (measured: karting-arena 4985m listed above spa-elysee 4984m).

    Matching the two costs a couple of metres of precision at 5km — invisible at the "5,0 km" the
    card actually shows — and keeps the index-assisted ordering.
  */
  const result = await db.execute(sql`
    SELECT ${summaryColumns},
           round(ST_Distance(v.location, ${point}, false)::numeric)::int AS distance_metres,
           -- same projection the detail query needs: geography reads back as EWKB hex, so the
           -- coordinates have to be pulled out explicitly rather than selected as a column
           ST_Y(v.location::geometry) AS lat,
           ST_X(v.location::geometry) AS lng
    FROM venues v, ${localNow}
    WHERE v.is_published
      AND ST_DWithin(v.location, ${point}, ${radiusMetres})
    ORDER BY v.location <-> ${point}, v.id
    LIMIT ${limit}
  `);

  type NearbyRow = SummaryRow & { distance_metres: number; lat: number; lng: number };

  return (result.rows as NearbyRow[]).map((row) => ({
    ...toSummary(row),
    distanceMetres: row.distance_metres,
    // for a pin and a "take me there" deep link — never for measuring anything on the device
    location: { lat: row.lat, lng: row.lng },
  }));
}

/* ------------------------------------------------------------------------------------------- */
/* Admin                                                                                        */
/*
  Reads and writes behind the admin venue page. Everything below is served only under /v1/admin.

  It lives in this file rather than its own because it selects the same two column blocks the
  public reads do, and the thing that keeps a venue one shape is those blocks having one
  definition. What must NOT happen is the reverse — a field from adminColumns drifting up into
  summaryColumns or detailColumns, which is how the marketing site starts announcing which company
  owns which restaurant.
*/

/*
  Same trick as services/partners.ts: db.execute returns Postgres' raw text for a top-level
  timestamptz ("2026-08-07 21:28:29+00", a space instead of a T), which new Date() parses in V8
  and not by spec. to_json emits real ISO 8601 and #>>'{}' unwraps it back to text. See the full
  explanation on isoTimestamp in services/partners.ts.
*/
const isoTimestamp = (column: ReturnType<typeof sql>) => sql`to_json(${column})#>>'{}'`;

/* ⚠️ ADMIN ONLY. None of this may appear in a public response — see the warning on
   venues.partner_id in db/schema/catalogue.ts. */
const adminColumns = sql`
  v.is_published,
  ${isoTimestamp(sql`v.created_at`)} AS created_at,
  ${isoTimestamp(sql`v.updated_at`)} AS updated_at,
  (SELECT json_build_object('id', p.id, 'companyName', p.company_name)
     FROM partners p WHERE p.id = v.partner_id) AS partner
`;

type AdminVenueRow = DetailRow & {
  is_published: boolean;
  created_at: string;
  updated_at: string;
  partner: { id: string; companyName: string } | null;
};

function toAdminVenue(row: AdminVenueRow): AdminVenue {
  return {
    ...toDetail(row),
    isPublished: row.is_published,
    partner: row.partner,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/*
  One venue, by id, published or not.

  Two differences from getVenueBySlug and both are the point. By ID because admin links between
  screens with ids — a slug is editable, and a URL that breaks when someone fixes a typo is not a
  URL. And no is_published filter, because a venue that isn't live is precisely the one you opened
  this page to look at.
*/
export async function getVenueForAdmin(id: string): Promise<AdminVenue | null> {
  const result = await db.execute(sql`
    SELECT ${summaryColumns}, ${detailColumns}, ${adminColumns}
    FROM venues v, ${localNow}
    WHERE v.id = ${id}
    LIMIT 1
  `);

  const row = result.rows[0] as AdminVenueRow | undefined;
  return row ? toAdminVenue(row) : null;
}

export type UpdateVenueInput = {
  name: string;
  slug: string;
  categoryKey: string;
  area: string;
  address: string;
  phone: string | null;
  isPublished: boolean;
};

export type UpdateVenueResult =
  | { ok: true; venue: AdminVenue }
  | { ok: false; reason: "NOT_FOUND" | "SLUG_TAKEN" | "CATEGORY_NOT_FOUND" };

/*
  The venue's own fields. Deliberately not its photos, deals, menu or opening hours — each of those
  is a table of its own with its own ordering, and editing a collection through the same form that
  edits six scalars is how you end up with a form that can't do either well.

  updated_at is set by hand: the column has a DEFAULT now() that fires on INSERT and there's no
  trigger, so nothing bumps it on UPDATE. Same trap as partners.
*/
export async function updateVenueForAdmin(
  id: string,
  input: UpdateVenueInput,
): Promise<UpdateVenueResult> {
  try {
    const updated = await db.execute(sql`
      UPDATE venues
      SET name         = ${input.name},
          slug         = ${input.slug},
          category_key = ${input.categoryKey},
          area         = ${input.area},
          address      = ${input.address},
          phone        = ${input.phone},
          is_published = ${input.isPublished},
          updated_at   = now()
      WHERE id = ${id}
      RETURNING id
    `);

    if (!updated.rows[0]) return { ok: false, reason: "NOT_FOUND" };
  } catch (error) {
    /* Let the database be the arbiter of both, rather than pre-checking: a SELECT-then-UPDATE
       leaves a window where two requests both pass and only the index decides. */
    if (violates(error, "23505", "venues_slug_key")) return { ok: false, reason: "SLUG_TAKEN" };
    if (violates(error, "23503")) return { ok: false, reason: "CATEGORY_NOT_FOUND" };
    throw error;
  }

  const venue = await getVenueForAdmin(id);
  return venue ? { ok: true, venue } : { ok: false, reason: "NOT_FOUND" };
}

/*
  Postgres constraint violations, as they actually reach us.

  ⚠️ The SQLSTATE is on error.cause, not on the error — drizzle wraps the driver's DatabaseError in
  a DrizzleQueryError. Checking only the top level matches nothing and every collision becomes a
  500. Both levels are checked so this survives a drizzle that stops wrapping.
*/
function violates(value: unknown, code: string, constraint?: string): boolean {
  const matches = (candidate: unknown): boolean => {
    if (typeof candidate !== "object" || candidate === null) return false;
    const e = candidate as { code?: string; constraint?: string };
    return e.code === code && (constraint === undefined || e.constraint === constraint);
  };

  return matches(value) || matches((value as { cause?: unknown } | null)?.cause);
}
