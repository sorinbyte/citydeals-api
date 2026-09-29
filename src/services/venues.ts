import { type SQL, sql } from "drizzle-orm";

import { db } from "@/db/client";
import { assetUrl } from "@/lib/assets";
import { type DealCopy, composeDealCopy, wholeScopeNoun } from "@/lib/deal-copy";
import { isOpenNow, localNow, nextOpeningAt, todayHours } from "@/lib/hours";
import type {
  AdminDeal,
  AdminMenuSection,
  AdminVenue,
  AdminVenueListItem,
  AdminVenueSort,
  Deal,
  Menu,
  OpeningWindow,
  Paginated,
  PartnerVenueListItem,
  VenueDetail,
  VenueHoursWindow,
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
     FROM partners p WHERE p.id = v.partner_id) AS partner,
  -- keys only. The admin app already fetches the taxonomy from /v1/categories for the labels, so
  -- sending them again here would be two sources for the same words.
  COALESCE((SELECT json_agg(vs.subcategory_key ORDER BY vs.subcategory_key)
            FROM venue_subcategories vs WHERE vs.venue_id = v.id), '[]'::json) AS subcategory_keys,
  -- ⚠️ NO is_active filter, unlike the deals aggregate in detailColumns. A deactivated offer is
  -- invisible to every member and has to be visible here, or there is no way to switch it back on.
  COALESCE((SELECT json_agg(json_build_object(
              'id', d.id, 'type', d.type, 'title', d.title, 'condition', d.condition,
              'percentOff', d.percent_off, 'avgSavingMinor', d.avg_saving_minor,
              'currency', d.currency, 'refreshDays', d.refresh_days, 'people', d.people,
              'isActive', d.is_active, 'sortOrder', d.sort_order,
              -- the structured offer behind title/condition; null on rows that predate it
              'itemLabel', d.item_label, 'requiredItem', d.required_item,
              'requiredGender', d.required_gender, 'scopeLabel', d.scope_label
            ) ORDER BY d.sort_order, d.id)
            FROM deals d WHERE d.venue_id = v.id), '[]'::json) AS admin_deals,
  -- paths, not URLs: assetUrl composes those in toAdminVenue, same as everywhere else
  COALESCE((SELECT json_agg(json_build_object(
              'id', vp.id, 'path', vp.path, 'sortOrder', vp.sort_order
            ) ORDER BY vp.sort_order, vp.id)
            FROM venue_photos vp WHERE vp.venue_id = v.id), '[]'::json) AS admin_photos,
  -- The whole schedule, flat, for an editor. Deliberately absent from the public projection: the
  -- app gets isOpen/opensAt/todayHours so the open-or-not decision stays server-side.
  COALESCE((SELECT json_agg(json_build_object(
              'weekday', oh.weekday,
              'opensAt', to_char(oh.opens_at, 'HH24:MI'),
              'closesAt', to_char(oh.closes_at, 'HH24:MI')
            ) ORDER BY oh.weekday, oh.opens_at)
            FROM opening_hours oh WHERE oh.venue_id = v.id), '[]'::json) AS week_hours,
  -- ⚠️ NO is_available filter, unlike detailColumns. An unavailable item is hidden from members and
  -- has to be visible here, for the same reason deactivated deals are.
  COALESCE((SELECT json_agg(section ORDER BY section_order, section_id)
            FROM (
              SELECT ms.sort_order AS section_order, ms.id AS section_id,
                     json_build_object(
                       'id', ms.id,
                       'title', ms.title,
                       'items', COALESCE((SELECT json_agg(json_build_object(
                                   'id', mi.id, 'name', mi.name, 'description', mi.description,
                                   'priceMinor', mi.price_minor, 'currency', mi.currency,
                                   'isAvailable', mi.is_available
                                 ) ORDER BY mi.sort_order, mi.id)
                                 FROM menu_items mi WHERE mi.section_id = ms.id), '[]'::json)
                     ) AS section
              FROM menu_sections ms WHERE ms.venue_id = v.id
            ) s), '[]'::json) AS admin_menu_sections
`;

type AdminVenueRow = DetailRow & {
  is_published: boolean;
  created_at: string;
  updated_at: string;
  partner: { id: string; companyName: string } | null;
  subcategory_keys: string[];
  admin_deals: AdminDeal[];
  admin_photos: Array<{ id: string; path: string; sortOrder: number }>;
  admin_menu_sections: AdminMenuSection[];
  week_hours: VenueHoursWindow[];
};

function toAdminVenue(row: AdminVenueRow): AdminVenue {
  /*
    `menu` is pulled off and dropped on purpose. Admin gets menuKind + menuSections instead, and
    without this the response would carry both spellings of the same thing — TypeScript lets a
    spread through excess-property checks, so the extra field would ship silently.
  */
  const { menu: _publicMenu, ...detail } = toDetail(row);

  return {
    ...detail,
    /*
      Overwrites the `deals` toDetail just built. That aggregate ran, filtered to active, and is
      thrown away — a few microseconds on a single-row admin query, and the price of detailColumns
      staying exactly as the app reads it. Widening the shared block instead would put isActive and
      sortOrder on the public /v1/venues/:slug response, which is the mistake this file's header
      warns about.
    */
    deals: row.admin_deals,
    /* Same override, same reason: the public shape is a bare URL array with nothing to address a
       row by, so an editor couldn't delete or reorder anything. */
    photos: row.admin_photos.flatMap((photo) => {
      const url = assetUrl(photo.path);
      /* assetUrl only returns null for an empty path, which the NOT NULL column forbids — but
         flatMap keeps the types honest without an assertion. */
      return url ? [{ id: photo.id, url, sortOrder: photo.sortOrder }] : [];
    }),
    menuKind: row.menu_kind,
    menuSections: row.admin_menu_sections,
    weekHours: row.week_hours,
    isPublished: row.is_published,
    partner: row.partner,
    subcategoryKeys: row.subcategory_keys,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/*
  The admin venues table.

  Its own small SELECT rather than summaryColumns, because the two answer different questions: the
  public shape builds a card (photo, rating, open now, top three deals) and this builds a row you
  triage on (owner, offer count, live or not). Reusing summaryColumns would mean paying for four
  subqueries per row to display none of them — and would put a public projection one edit away from
  carrying `partner`.

  ⚠️ No is_published filter. Unpublished venues are exactly what an admin needs to find.
*/
const adminListColumns = sql`
  v.id,
  v.slug,
  v.name,
  v.category_key,
  v.area,
  v.is_published,
  (SELECT json_build_object('id', p.id, 'companyName', p.company_name)
     FROM partners p WHERE p.id = v.partner_id) AS partner,
  (SELECT count(*)::int FROM deals d WHERE d.venue_id = v.id AND d.is_active) AS active_deal_count
`;

type AdminListRow = {
  id: string;
  slug: string;
  name: string;
  category_key: string;
  area: string;
  is_published: boolean;
  partner: { id: string; companyName: string } | null;
  active_deal_count: number;
};

/*
  How each sort mode maps to SQL.

  ⚠️ Every mode ends with v.id, same as the public ORDER_BY and for the same reason: name isn't
  unique and a boolean certainly isn't, so an order that doesn't fully determine row position lets
  Postgres hand the same row back on page 1 and page 2 — or on neither. The tiebreaker is what makes
  LIMIT/OFFSET paging honest.

  ⚠️ RO_COLLATE on every text mode. The database collation is C.UTF-8, which sorts by byte order and
  puts every name starting with ă/â/î/ș/ț AFTER z.

  ⚠️ `category` orders by the taxonomy's own sort_order, NOT by the key. The product is dining-first
  and that's the order someone scanning this table expects; alphabetical-by-slug would be an
  accident of how the slugs happen to be spelled.
*/
const ADMIN_ORDER_BY: Record<AdminVenueSort, SQL> = {
  name: sql`v.name ${RO_COLLATE}`,
  category: sql`(SELECT c.sort_order FROM categories c WHERE c.key = v.category_key)`,
  area: sql`v.area ${RO_COLLATE}`,
  /*
    Venues with no partner group at one end rather than scattering — Postgres already does that,
    since NULLS LAST is the default for ASC and NULLS FIRST for DESC.

    ⚠️ Don't add an explicit NULLS clause here. It has to follow the direction keyword, and this
    fragment is interpolated BEFORE it — "… NULLS LAST ASC" is a syntax error, which surfaces as a
    500 rather than anything that points at the sort.
  */
  partner: sql`(SELECT p.company_name FROM partners p WHERE p.id = v.partner_id) ${RO_COLLATE}`,
  offers: sql`(SELECT count(*) FROM deals d WHERE d.venue_id = v.id AND d.is_active)`,
  status: sql`v.is_published`,
};

export async function listVenuesForAdmin({
  categoryKey,
  isPublished,
  sort,
  direction,
  page,
  perPage,
}: {
  categoryKey?: string;
  isPublished?: boolean;
  sort: AdminVenueSort;
  direction: "asc" | "desc";
  page: number;
  perPage: number;
}): Promise<Paginated<AdminVenueListItem>> {
  const offset = (page - 1) * perPage;

  const categoryFilter = categoryKey ? sql`AND v.category_key = ${categoryKey}` : sql``;
  const publishedFilter =
    isPublished === undefined ? sql`` : sql`AND v.is_published = ${isPublished}`;

  /* WHERE true so the filters can all start with AND and compose without counting commas. */
  const where = sql`WHERE true ${categoryFilter} ${publishedFilter}`;
  const orderDirection = direction === "asc" ? sql`ASC` : sql`DESC`;

  const [rows, counted] = await Promise.all([
    db.execute(sql`
      SELECT ${adminListColumns}
      FROM venues v
      ${where}
      ORDER BY ${ADMIN_ORDER_BY[sort]} ${orderDirection}, v.id
      LIMIT ${perPage} OFFSET ${offset}
    `),
    // same filters, or totalPages disagrees with the rows and the client pages into an empty list
    db.execute(sql`SELECT count(*)::int AS total FROM venues v ${where}`),
  ]);

  const total = (counted.rows[0] as { total: number } | undefined)?.total ?? 0;

  return {
    items: (rows.rows as AdminListRow[]).map((row) => ({
      id: row.id,
      slug: row.slug,
      name: row.name,
      categoryKey: row.category_key,
      area: row.area,
      partner: row.partner,
      activeDealCount: row.active_deal_count,
      isPublished: row.is_published,
    })),
    page,
    perPage,
    total,
    totalPages: Math.max(1, Math.ceil(total / perPage)),
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
  /* Replaces the whole set — whatever isn't in here stops applying to this venue. */
  subcategoryKeys: string[];
};

export type CreateVenueInput = UpdateVenueInput & {
  /* `venues.location` is NOT NULL, so a venue cannot exist without a point. It's what powers
     /v1/venues/near, which is a headline feature of the app. */
  lat: number;
  lng: number;
  /* Null is legal — a venue can exist before the company behind it does. The admin UI creates from
     a partner's page, so in practice this is set. */
  partnerId: string | null;
};

export type CreateVenueResult =
  | { ok: true; venue: AdminVenue }
  | {
      ok: false;
      reason: "SLUG_TAKEN" | "CATEGORY_NOT_FOUND" | "PARTNER_NOT_FOUND" | "SUBCATEGORY_INVALID";
    };

/*
  A new venue, with its subcategories, in one transaction.

  Everything that isn't passed uses the column default — `rating` stays null, `rating_count` 0,
  `tags` empty, `is_new` false, `menu_kind` null. Those are earned later (or set by an editor), not
  invented at creation.

  ⚠️ is_published is written explicitly rather than left to the column, because the column defaults
  to TRUE. A venue created here has no photos and no offers yet, so it would go live in the app as a
  blank card with nothing to redeem. The admin form sends false.
*/
export async function createVenueForAdmin(input: CreateVenueInput): Promise<CreateVenueResult> {
  const subcategoryKeys = [...new Set(input.subcategoryKeys)];

  let venueId: string | undefined;

  try {
    const failure = await db.transaction(async (tx) => {
      const inserted = await tx.execute(sql`
        INSERT INTO venues (slug, name, partner_id, category_key, area, address, phone,
                            location, is_published)
        VALUES (${input.slug}, ${input.name}, ${input.partnerId}, ${input.categoryKey},
                ${input.area}, ${input.address}, ${input.phone},
                -- ⚠️ ST_MakePoint takes (x, y) = (LONGITUDE, latitude). Backwards is a venue in the
                -- wrong hemisphere that still passes every range check.
                ST_MakePoint(${input.lng}, ${input.lat})::geography,
                ${input.isPublished})
        RETURNING id
      `);

      const row = inserted.rows[0] as { id: string } | undefined;
      if (!row) return "CATEGORY_NOT_FOUND" as const;
      venueId = row.id;

      if (subcategoryKeys.length > 0) {
        /* Same validation as the update path: only keys belonging to this venue's category
           survive the SELECT, so a short insert means at least one was wrong. */
        const linked = await tx.execute(sql`
          INSERT INTO venue_subcategories (venue_id, subcategory_key)
          SELECT ${row.id}, s.key
          FROM subcategories s
          WHERE s.key = ANY(${sql.param(subcategoryKeys)}::text[])
            AND s.category_key = ${input.categoryKey}
        `);

        if ((linked.rowCount ?? 0) !== subcategoryKeys.length) throw new SubcategoryMismatch();
      }

      return null;
    });

    if (failure) return { ok: false, reason: failure };
  } catch (error) {
    if (error instanceof SubcategoryMismatch) return { ok: false, reason: "SUBCATEGORY_INVALID" };
    if (violates(error, "23505", "venues_slug_key")) return { ok: false, reason: "SLUG_TAKEN" };
    /* Two foreign keys on this table, so the constraint name is what tells them apart — a bare
       23503 check would report an unknown partner as an unknown category. */
    if (violates(error, "23503", "venues_partner_id_partners_id_fk")) {
      return { ok: false, reason: "PARTNER_NOT_FOUND" };
    }
    if (violates(error, "23503", "venues_category_key_categories_key_fk")) {
      return { ok: false, reason: "CATEGORY_NOT_FOUND" };
    }
    throw error;
  }

  /* Outside the transaction — see the note on reorderVenuePhotos about reading through the pool. */
  const venue = venueId ? await getVenueForAdmin(venueId) : null;
  return venue ? { ok: true, venue } : { ok: false, reason: "CATEGORY_NOT_FOUND" };
}

export type UpdateVenueResult =
  | { ok: true; venue: AdminVenue }
  | {
      ok: false;
      reason: "NOT_FOUND" | "SLUG_TAKEN" | "CATEGORY_NOT_FOUND" | "SUBCATEGORY_INVALID";
    };

/* Rolls the transaction back from inside the callback. Not an error anyone sees — the catch turns
   it straight into a result, and it exists only because drizzle commits unless you throw. */
class SubcategoryMismatch extends Error {}

/*
  The venue's own fields, plus which subcategories it's filed under.

  Deliberately still not its photos, deals, menu or opening hours — each of those is a table of its
  own with its own ordering and its own routes. Subcategories are here rather than in a route of
  their own because they can't be edited independently of the category: change a venue from
  restaurante to divertisment and its old subcategories stop being legal that same instant. One
  transaction, or a window where the venue is filed under a category its subcategories don't
  belong to.

  updated_at is set by hand: the column has a DEFAULT now() that fires on INSERT and there's no
  trigger, so nothing bumps it on UPDATE. Same trap as partners.
*/
export async function updateVenueForAdmin(
  id: string,
  input: UpdateVenueInput,
): Promise<UpdateVenueResult> {
  /* Deduped before the count check below, otherwise ["pizza","pizza"] inserts one row, fails the
     comparison and gets reported as an invalid key — which it isn't. */
  const subcategoryKeys = [...new Set(input.subcategoryKeys)];

  try {
    const missing = await db.transaction(async (tx) => {
      const updated = await tx.execute(sql`
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

      if (!updated.rows[0]) return true;

      /* Replace rather than diff. The set is small and bounded, and working out which rows to add
         and which to drop is more code than throwing them all away and writing the new set. */
      await tx.execute(sql`DELETE FROM venue_subcategories WHERE venue_id = ${id}`);

      if (subcategoryKeys.length > 0) {
        /*
          The SELECT is the validation. Only keys that exist AND belong to the venue's new category
          survive it, so if fewer rows land than were asked for, at least one key was bogus or
          belonged to a different category. Doing it this way rather than as a pre-flight SELECT
          keeps the check and the write in the same statement.

          ⚠️ sql.param, not a bare ${}. Interpolating an array into a drizzle template expands it
          into a parameter LIST — `ANY(($1, $2))` — which Postgres reads as a record and refuses to
          cast to text[] (42846). sql.param binds the whole array as one value.
        */
        const inserted = await tx.execute(sql`
          INSERT INTO venue_subcategories (venue_id, subcategory_key)
          SELECT ${id}, s.key
          FROM subcategories s
          WHERE s.key = ANY(${sql.param(subcategoryKeys)}::text[])
            AND s.category_key = ${input.categoryKey}
        `);

        if ((inserted.rowCount ?? 0) !== subcategoryKeys.length) throw new SubcategoryMismatch();
      }

      return false;
    });

    if (missing) return { ok: false, reason: "NOT_FOUND" };
  } catch (error) {
    if (error instanceof SubcategoryMismatch) return { ok: false, reason: "SUBCATEGORY_INVALID" };
    /* Let the database be the arbiter of both, rather than pre-checking: a SELECT-then-UPDATE
       leaves a window where two requests both pass and only the index decides. */
    if (violates(error, "23505", "venues_slug_key")) return { ok: false, reason: "SLUG_TAKEN" };
    /* Named rather than a bare 23503: `venues` has a second foreign key (partner_id), and although
       this statement never touches it, an unnamed check would happily mislabel anything that did. */
    if (violates(error, "23503", "venues_category_key_categories_key_fk")) {
      return { ok: false, reason: "CATEGORY_NOT_FOUND" };
    }
    throw error;
  }

  const venue = await getVenueForAdmin(id);
  return venue ? { ok: true, venue } : { ok: false, reason: "NOT_FOUND" };
}

/* ------------------------------------------------------------------------------------------- */
/* Admin — deals                                                                                 */

/*
  ⚠️ No `title` and no `condition`. Those are composed here from the structured parts — see
  lib/deal-copy.ts — and a caller that could pass them would be a caller that could route around
  every constraint the form applies.

  The shape mirrors the route's discriminated union, so the impossible combinations (a percentage
  with an item, a 1+1 with a scope) can't be expressed rather than being validated away.
*/
/*
  The offer itself, as three mutually exclusive shapes.

  A union rather than a bag of nullable fields, so "a percentage with an item label" or "a 1+1 with
  a scope" can't be written down, let alone validated away. percentOff lives in here rather than
  alongside, for the same reason: it belongs to exactly one of the three.
*/
export type DealOfferInput =
  | { type: "one_plus_one"; itemLabel: string }
  | {
      type: "free_item";
      itemLabel: string;
      requiredItem: string | null;
      requiredGender: "m" | "f" | null;
    }
  | { type: "percentage"; percentOff: number; scopeLabel: string | null };

/*
  ⚠️ No `title` and no `condition`. Those are composed here from the offer above — see
  lib/deal-copy.ts — and a caller able to pass them would be a caller able to route around every
  constraint the form applies.
*/
export type DealInput = {
  offer: DealOfferInput;
  /* Bani. Integer. The client sends this already converted — nothing here does money arithmetic. */
  avgSavingMinor: number;
  currency: string;
  refreshDays: number;
  people: number;
  isActive: boolean;
};

/* Flattens the offer union into the columns, so create and update write the same shape. */
function dealColumns(offer: DealOfferInput) {
  return {
    percentOff: offer.type === "percentage" ? offer.percentOff : null,
    itemLabel: offer.type === "percentage" ? null : offer.itemLabel,
    requiredItem: offer.type === "free_item" ? offer.requiredItem : null,
    requiredGender: offer.type === "free_item" ? offer.requiredGender : null,
    scopeLabel: offer.type === "percentage" ? offer.scopeLabel : null,
  };
}

/*
  Composes the two sentences, looking up whatever the venue calls "everything" first.

  Only a percentage over the whole bill needs that noun — a restaurant says "tot meniul", a barber
  "toate serviciile", a cinema "toată nota" — and it comes off the venue's own menu_kind rather than
  being asked again. One extra round trip on one of three offer types is cheaper than a join here or
  a field the form has to fill in.
*/
async function composeFor(venueId: string, offer: DealOfferInput): Promise<DealCopy> {
  if (offer.type !== "percentage") return composeDealCopy(offer);

  const result = await db.execute(sql`SELECT menu_kind FROM venues WHERE id = ${venueId}`);
  const row = result.rows[0] as { menu_kind: Menu["kind"] | null } | undefined;

  return composeDealCopy({ ...offer, wholeScopeNoun: wholeScopeNoun(row?.menu_kind ?? null) });
}

/*
  Every deal write answers with the whole venue.

  It costs one extra read and buys the client a single cache entry it can replace wholesale — no
  patching a nested array by hand, and no way for the venue on screen to disagree with the deal that
  was just saved. Same reasoning as updateVenueForAdmin re-reading after its UPDATE.
*/
export type DealResult =
  | { ok: true; venue: AdminVenue }
  | { ok: false; reason: "VENUE_NOT_FOUND" | "DEAL_NOT_FOUND" };

export async function createDeal(venueId: string, input: DealInput): Promise<DealResult> {
  /*
    New deals go last. sort_order decides which three a card shows, and silently promoting a brand
    new offer above the ones already earning is not a decision this function should be making.
    COALESCE covers the first deal, where max() over no rows is null.
  */
  const copy = await composeFor(venueId, input.offer);
  const parts = dealColumns(input.offer);

  const inserted = await db.execute(sql`
    INSERT INTO deals (venue_id, type, title, condition, percent_off, avg_saving_minor,
                       currency, refresh_days, people, is_active, sort_order,
                       item_label, required_item, required_gender, scope_label)
    SELECT ${venueId}, ${input.offer.type}::deal_type, ${copy.title}, ${copy.condition},
           ${parts.percentOff}, ${input.avgSavingMinor}, ${input.currency},
           ${input.refreshDays}, ${input.people}, ${input.isActive},
           COALESCE((SELECT max(d.sort_order) + 1 FROM deals d WHERE d.venue_id = ${venueId}), 0),
           ${parts.itemLabel}, ${parts.requiredItem},
           ${parts.requiredGender}::deal_gender, ${parts.scopeLabel}
    -- guards the FK: without it a bad venue id is a 23503 we'd have to decode back into a 404
    WHERE EXISTS (SELECT 1 FROM venues v WHERE v.id = ${venueId})
    RETURNING id
  `);

  if (!inserted.rows[0]) return { ok: false, reason: "VENUE_NOT_FOUND" };

  const venue = await getVenueForAdmin(venueId);
  return venue ? { ok: true, venue } : { ok: false, reason: "VENUE_NOT_FOUND" };
}

/*
  ⚠️ venue_id is in the WHERE clause, not just the id.

  The deal id alone would be enough to find the row, but then a wrong or stale venue id in the path
  would happily edit another venue's offer and report success. Scoping the write to the pair makes
  a mismatch a 404 instead.
*/
export async function updateDeal(
  venueId: string,
  dealId: string,
  input: DealInput,
): Promise<DealResult> {
  const copy = await composeFor(venueId, input.offer);
  const parts = dealColumns(input.offer);

  const updated = await db.execute(sql`
    UPDATE deals
    SET type             = ${input.offer.type}::deal_type,
        title            = ${copy.title},
        condition        = ${copy.condition},
        percent_off      = ${parts.percentOff},
        avg_saving_minor = ${input.avgSavingMinor},
        currency         = ${input.currency},
        refresh_days     = ${input.refreshDays},
        people           = ${input.people},
        is_active        = ${input.isActive},
        item_label       = ${parts.itemLabel},
        required_item    = ${parts.requiredItem},
        required_gender  = ${parts.requiredGender}::deal_gender,
        scope_label      = ${parts.scopeLabel},
        updated_at       = now()
    WHERE id = ${dealId} AND venue_id = ${venueId}
    RETURNING id
  `);

  if (!updated.rows[0]) return { ok: false, reason: "DEAL_NOT_FOUND" };

  const venue = await getVenueForAdmin(venueId);
  return venue ? { ok: true, venue } : { ok: false, reason: "VENUE_NOT_FOUND" };
}

/*
  A real delete, not a soft one.

  is_active already exists for "stop showing this" and the editor exposes it, so a second, invisible
  kind of deleted would just be a row nobody can see or reactivate. Deleting is for offers that
  should never have been typed.
*/
export async function deleteDeal(venueId: string, dealId: string): Promise<DealResult> {
  const deleted = await db.execute(sql`
    DELETE FROM deals WHERE id = ${dealId} AND venue_id = ${venueId} RETURNING id
  `);

  if (!deleted.rows[0]) return { ok: false, reason: "DEAL_NOT_FOUND" };

  const venue = await getVenueForAdmin(venueId);
  return venue ? { ok: true, venue } : { ok: false, reason: "VENUE_NOT_FOUND" };
}

/* ------------------------------------------------------------------------------------------- */
/* Admin — photos                                                                                */

/*
  What every photo and menu write answers with.

  Same contract as DealResult above: the whole venue on success, so the dashboard replaces one cache
  entry instead of reconciling nested arrays. PHOTO_NOT_FOUND never fires from a menu write — one
  union covering both beats two that differ by a member nobody reads.
*/
export type VenueContentResult =
  | { ok: true; venue: AdminVenue }
  | { ok: false; reason: "VENUE_NOT_FOUND" | "PHOTO_NOT_FOUND" | "PHOTO_LIMIT_REACHED" };

/*
  How many photos a venue may have.

  ⚠️ Enforced HERE rather than only in the dashboard, so it applies to admin as much as to a
  partner — this is a catalogue rule about how much of one venue a member should have to swipe
  through, not a restriction on partners. A cap that lives only in a UI is a cap anyone can edit
  away in devtools.
*/
const MAX_PHOTOS_PER_VENUE = 10;

/*
  Record an already-uploaded object against a venue.

  The R2 write happens at the route, before this — if the object doesn't land there's nothing to
  record, and a row pointing at a missing key renders as a broken image forever. This is only the
  bookkeeping half.

  New photos go last, same as new deals: the first photo is the card image across the whole product,
  and quietly promoting whatever was uploaded most recently is not this function's call.
*/
export async function addVenuePhoto(venueId: string, path: string): Promise<VenueContentResult> {
  /*
    Checked before the insert rather than as part of it, so "this venue doesn't exist" and "this
    venue is full" stay distinguishable — they need different words in the UI.

    ⚠️ The caller has already put the object in R2 by this point, so a refusal here leaves an
    orphan. Both routes delete it; see the PHOTO_LIMIT_REACHED branch there.
  */
  const counted = await db.execute(sql`
    SELECT count(*)::int AS n FROM venue_photos WHERE venue_id = ${venueId}
  `);

  const existing = (counted.rows[0] as { n: number } | undefined)?.n ?? 0;
  if (existing >= MAX_PHOTOS_PER_VENUE) return { ok: false, reason: "PHOTO_LIMIT_REACHED" };

  const inserted = await db.execute(sql`
    INSERT INTO venue_photos (venue_id, path, sort_order)
    SELECT ${venueId}, ${path},
           COALESCE((SELECT max(vp.sort_order) + 1 FROM venue_photos vp
                     WHERE vp.venue_id = ${venueId}), 0)
    WHERE EXISTS (SELECT 1 FROM venues v WHERE v.id = ${venueId})
    RETURNING id
  `);

  if (!inserted.rows[0]) return { ok: false, reason: "VENUE_NOT_FOUND" };

  const venue = await getVenueForAdmin(venueId);
  return venue ? { ok: true, venue } : { ok: false, reason: "VENUE_NOT_FOUND" };
}

/* Returns the deleted row's path so the caller can go and remove the object too. Scoped to the
   (venue, photo) pair for the same reason the deal writes are. */
export async function deleteVenuePhoto(
  venueId: string,
  photoId: string,
): Promise<VenueContentResult & { path?: string }> {
  const deleted = await db.execute(sql`
    DELETE FROM venue_photos WHERE id = ${photoId} AND venue_id = ${venueId} RETURNING path
  `);

  const row = deleted.rows[0] as { path: string } | undefined;
  if (!row) return { ok: false, reason: "PHOTO_NOT_FOUND" };

  const venue = await getVenueForAdmin(venueId);
  return venue ? { ok: true, venue, path: row.path } : { ok: false, reason: "VENUE_NOT_FOUND" };
}

/*
  Rewrite the order from a list of ids.

  ⚠️ The list must be exactly the venue's photos — every one, no extras. Anything else is a stale
  page racing a delete, and applying half an order silently would leave positions that don't mean
  what the person saw. Checking the count both ways is what makes a partial list a 404 instead.

  Position comes from the array, so "make this one primary" is just a reorder that puts it first;
  there's no is_primary column to keep in step.
*/
export async function reorderVenuePhotos(
  venueId: string,
  photoIds: string[],
): Promise<VenueContentResult> {
  const mismatched = await db.transaction(async (tx) => {
    const owned = await tx.execute(sql`
      SELECT id FROM venue_photos WHERE venue_id = ${venueId} FOR UPDATE
    `);

    const ownedIds = new Set((owned.rows as Array<{ id: string }>).map((row) => row.id));
    const requested = new Set(photoIds);

    if (ownedIds.size !== requested.size || photoIds.some((id) => !ownedIds.has(id))) {
      return true;
    }

    /* Row by row, but inside the transaction and behind the FOR UPDATE above — so the window where
       two photos briefly share a position is never observable from outside. A handful of photos per
       venue doesn't justify building a VALUES join for this. */
    for (const [index, photoId] of photoIds.entries()) {
      await tx.execute(sql`
        UPDATE venue_photos SET sort_order = ${index}, updated_at = now()
        WHERE id = ${photoId} AND venue_id = ${venueId}
      `);
    }

    return false;
  });

  if (mismatched) return { ok: false, reason: "PHOTO_NOT_FOUND" };

  /*
    ⚠️ Re-read AFTER the transaction commits, never inside it.

    getVenueForAdmin goes through the `db` pool, which is a different connection from `tx` — so
    calling it inside the callback reads the pre-transaction snapshot and answers with the OLD
    order. It doesn't even block: a plain SELECT sails past FOR UPDATE under MVCC, so the bug is
    silent. Caught by a reorder whose response disagreed with what the public endpoint then served.
  */
  const venue = await getVenueForAdmin(venueId);
  return venue ? { ok: true, venue } : { ok: false, reason: "VENUE_NOT_FOUND" };
}

/* ------------------------------------------------------------------------------------------- */
/* Admin — menu                                                                                  */

export type MenuInput = {
  /* null wipes the price list entirely — a venue that genuinely has none. */
  kind: Menu["kind"] | null;
  sections: Array<{
    title: string;
    items: Array<{
      name: string;
      description: string | null;
      priceMinor: number;
      currency: string;
      isAvailable: boolean;
    }>;
  }>;
};

/*
  Replace the whole price list in one transaction.

  Deliberately a wipe-and-reinsert rather than six routes for sections and items. A price list is
  edited in bursts — rename a section, fix three prices, add a line — and diffing that against what's
  stored is a lot of machinery to avoid rewriting a few dozen rows. Ordering falls out of array
  position, so reordering needs no separate concept at all.

  ⚠️ The cost is that ids churn on every save. That's free here and would not be if anything
  referenced a menu item: nothing does, and the public projection doesn't even send an id. If
  redemptions ever point at a menu line, this has to become a diff.

  menu_kind lives on `venues` while the sections live in their own tables, so both move together or
  the venue ends up claiming to have a menu that isn't there.
*/
export async function replaceVenueMenu(
  venueId: string,
  input: MenuInput,
): Promise<VenueContentResult> {
  const missing = await db.transaction(async (tx) => {
    const updated = await tx.execute(sql`
      UPDATE venues SET menu_kind = ${input.kind}::menu_kind, updated_at = now()
      WHERE id = ${venueId}
      RETURNING id
    `);

    if (!updated.rows[0]) return true;

    /* menu_items cascades off menu_sections, so this clears both. */
    await tx.execute(sql`DELETE FROM menu_sections WHERE venue_id = ${venueId}`);

    for (const [sectionIndex, section] of input.sections.entries()) {
      const inserted = await tx.execute(sql`
        INSERT INTO menu_sections (venue_id, title, sort_order)
        VALUES (${venueId}, ${section.title}, ${sectionIndex})
        RETURNING id
      `);

      const sectionRow = inserted.rows[0] as { id: string } | undefined;
      if (!sectionRow) continue;

      for (const [itemIndex, item] of section.items.entries()) {
        await tx.execute(sql`
          INSERT INTO menu_items (section_id, name, description, price_minor, currency,
                                  is_available, sort_order)
          VALUES (${sectionRow.id}, ${item.name}, ${item.description}, ${item.priceMinor},
                  ${item.currency}, ${item.isAvailable}, ${itemIndex})
        `);
      }
    }

    return false;
  });

  if (missing) return { ok: false, reason: "VENUE_NOT_FOUND" };

  /* Same trap as reorderVenuePhotos: this must run after the commit, or it reads the old menu off
     a different pooled connection and answers with what was there before the save. */
  const venue = await getVenueForAdmin(venueId);
  return venue ? { ok: true, venue } : { ok: false, reason: "VENUE_NOT_FOUND" };
}

/* ------------------------------------------------------------------------------------------- */
/* Partner — the venue_owner's own venues                                                        */

/*
  ⚠️ READ THIS BEFORE ADDING ANYTHING BELOW.

  Every function in this section takes a `userId` and puts it in the WHERE clause. Not in an `if`
  after the query — in the statement. AGENTS.md is blunt about why: "Fetching a venue's stats and
  then checking ownership is how you leak another partner's revenue through a forgotten branch."

  So the shape is always the same, and there is a helper for it because a hand-written copy is a
  hand-written copy that can be forgotten:

      AND EXISTS (SELECT 1 FROM user_venues uv WHERE uv.venue_id = … AND uv.user_id = …)

  The grants come from `user_venues`, NOT from `venues.partner_id`. A chain can put one manager on
  one location — inferring scope from the company would hand that manager the whole group, and the
  schema models the two separately for exactly this reason.

  ⚠️ These are also the reason routes/partner.ts and routes/admin.ts share no code. Services are
  data access and reusing them across both is fine; a shared gate is not.
*/

/* The scope predicate, once. `venueColumn` is whatever names the venue in the surrounding query —
   `v.id` in a SELECT over venues, a bound id in a standalone UPDATE. */
const grantedTo = (userId: string, venueColumn: SQL) => sql`
  EXISTS (SELECT 1 FROM user_venues uv
          WHERE uv.venue_id = ${venueColumn} AND uv.user_id = ${userId})
`;

/*
  The venues this person may act on.

  Ordered by name with the Romanian collation, same as everywhere else — three venues don't need a
  sort control, but they do need to not jump around between loads.
*/
export async function listVenuesForPartner(userId: string): Promise<PartnerVenueListItem[]> {
  const result = await db.execute(sql`
    SELECT
      v.id, v.slug, v.name, v.category_key, v.area, v.is_published,
      (SELECT vp.path FROM venue_photos vp
        WHERE vp.venue_id = v.id ORDER BY vp.sort_order, vp.id LIMIT 1) AS image_path,
      (SELECT count(*)::int FROM deals d WHERE d.venue_id = v.id AND d.is_active) AS active_deal_count
    FROM venues v
    WHERE ${grantedTo(userId, sql`v.id`)}
    ORDER BY v.name ${RO_COLLATE}, v.id
  `);

  return (result.rows as PartnerListRow[]).map((row) => ({
    id: row.id,
    slug: row.slug,
    name: row.name,
    categoryKey: row.category_key,
    area: row.area,
    image: assetUrl(row.image_path),
    activeDealCount: row.active_deal_count,
    isPublished: row.is_published,
  }));
}

type PartnerListRow = {
  id: string;
  slug: string;
  name: string;
  category_key: string;
  area: string;
  is_published: boolean;
  image_path: string | null;
  active_deal_count: number;
};

/*
  One venue, scoped.

  Reuses the admin projection wholesale. That's deliberate: a partner editing their own venue needs
  exactly what admin needs — photos with ids on them (you can't delete what you can't name) and
  deactivated deals visible (or there'd be no way to switch one back on). Forking the column set to
  shave a field would leave two projections to keep in step, and the shared ones are already
  documented as the thing not to widen carelessly.

  ⚠️ The menu aggregate comes back and is thrown away — the partner dashboard has no menu editor.
  Same trade-off toAdminVenue already documents for the deals aggregate it overwrites: a few
  microseconds on a single-row query, against a second projection to maintain.

  Returns null for both "no such venue" and "not yours". The caller cannot tell them apart and
  shouldn't try — see the note in routes/partner.ts.
*/
export async function getVenueForPartner(
  userId: string,
  venueId: string,
): Promise<AdminVenue | null> {
  const result = await db.execute(sql`
    SELECT ${summaryColumns}, ${detailColumns}, ${adminColumns}
    FROM venues v, ${localNow}
    WHERE v.id = ${venueId}
      AND ${grantedTo(userId, sql`v.id`)}
    LIMIT 1
  `);

  const row = result.rows[0] as AdminVenueRow | undefined;
  return row ? toAdminVenue(row) : null;
}

export type PartnerVenueResult =
  | { ok: true; venue: AdminVenue }
  | { ok: false; reason: "VENUE_NOT_FOUND" };

/*
  Phone and address. That is the entire list, and it is a list of two on purpose.

  ⚠️ This UPDATE names two columns. It CANNOT set is_published, slug, category_key or area — not
  "doesn't happen to", cannot. That's the whole reason it exists instead of calling
  updateVenueForAdmin with a narrower caller: a narrower caller is one refactor away from being a
  wider caller, whereas a statement that doesn't mention a column can never write it.

  Which fields those are, and why:
    · slug is the public /local/<slug> URL — indexed, shared, renaming costs redirects
    · category_key and area drive the app's browse filters and the taxonomy is editorial
    · is_published is a commercial decision, not a partner's

  No constraint handling here, unlike updateVenueForAdmin. Neither column is unique and neither has
  a foreign key, so there is nothing for the database to reject that zod hasn't already refused.
*/
export async function updateVenueContactForPartner(
  userId: string,
  venueId: string,
  input: { phone: string | null; address: string },
): Promise<PartnerVenueResult> {
  const updated = await db.execute(sql`
    UPDATE venues
    SET phone      = ${input.phone},
        address    = ${input.address},
        updated_at = now()
    WHERE id = ${venueId}
      AND ${grantedTo(userId, sql`venues.id`)}
    RETURNING id
  `);

  if (!updated.rows[0]) return { ok: false, reason: "VENUE_NOT_FOUND" };

  const venue = await getVenueForPartner(userId, venueId);
  return venue ? { ok: true, venue } : { ok: false, reason: "VENUE_NOT_FOUND" };
}

export type PartnerDealResult =
  | { ok: true; venue: AdminVenue }
  | { ok: false; reason: "VENUE_NOT_FOUND" | "DEAL_NOT_FOUND" };

/*
  Pause or resume an offer. One column.

  ⚠️ A partner can switch an offer OFF and back ON. They cannot change what it says, what it's
  worth, or whether it exists. That's a product decision, not a gap: an offer is the commercial
  term agreed with Crunch, and letting it be edited here means "-25% la orice pizza" quietly
  becoming "-5%" with nothing telling us, while members keep being sold the old one.

  So there is no title/condition recomposition below — nothing that feeds them can change here.
  If that ever loosens, this function is NOT the place to widen; deal-copy.ts has to run, and
  updateDeal already knows how.
*/
export async function setDealActiveForPartner(
  userId: string,
  venueId: string,
  dealId: string,
  isActive: boolean,
): Promise<PartnerDealResult> {
  const updated = await db.execute(sql`
    UPDATE deals
    SET is_active  = ${isActive},
        updated_at = now()
    WHERE id = ${dealId}
      AND venue_id = ${venueId}
      AND ${grantedTo(userId, sql`deals.venue_id`)}
    RETURNING id
  `);

  /* The venue scope was already proved by the route's gate, so a miss here is the deal id, not the
     venue — a stale page, or an offer admin removed while this one was open. */
  if (!updated.rows[0]) return { ok: false, reason: "DEAL_NOT_FOUND" };

  const venue = await getVenueForPartner(userId, venueId);
  return venue ? { ok: true, venue } : { ok: false, reason: "VENUE_NOT_FOUND" };
}

/*
  The whole opening schedule, replaced in one go.

  Whole-list replace rather than a diff, same as the menu and for the same reason: a week of
  opening hours is edited in bursts — shift the Sunday close, add a lunch break, mark Monday shut —
  and every row is derived from array position anyway. Nothing references an opening_hours id, so
  regenerating them costs nothing.

  ⚠️ NOT scoped to a user, deliberately. This one takes a plain venueId because the route gate has
  already proved the caller owns it, and because admin will want the same function the day it grows
  an hours editor — it has none today, which is exactly why partners can't have their hours fixed
  for them.

  ⚠️ A window with closesAt <= opensAt is legal and means it runs past midnight. Nothing here
  reorders, splits or "corrects" such a row; lib/hours.ts is built to read them and the whole
  after-midnight case depends on them surviving intact.
*/
export async function replaceVenueHours(
  venueId: string,
  windows: VenueHoursWindow[],
): Promise<PartnerVenueResult> {
  const missing = await db.transaction(async (tx) => {
    /* Confirms the venue exists before wiping its hours — otherwise a bad id would silently
       delete nothing and report success. */
    const found = await tx.execute(sql`SELECT id FROM venues WHERE id = ${venueId}`);
    if (!found.rows[0]) return true;

    await tx.execute(sql`DELETE FROM opening_hours WHERE venue_id = ${venueId}`);

    for (const window of windows) {
      await tx.execute(sql`
        INSERT INTO opening_hours (venue_id, weekday, opens_at, closes_at)
        VALUES (${venueId}, ${window.weekday}, ${window.opensAt}::time, ${window.closesAt}::time)
      `);
    }

    /* The venue's own row is untouched by the loop above, so bump it here — "when did this venue
       last change" should count a schedule change. */
    await tx.execute(sql`UPDATE venues SET updated_at = now() WHERE id = ${venueId}`);

    return false;
  });

  if (missing) return { ok: false, reason: "VENUE_NOT_FOUND" };

  /* ⚠️ After the commit, never inside it. Reading within the transaction goes out on a different
     pooled connection and answers with the pre-commit schedule — the same trap reorderVenuePhotos
     and replaceVenueMenu both document. */
  const venue = await getVenueForAdmin(venueId);
  return venue ? { ok: true, venue } : { ok: false, reason: "VENUE_NOT_FOUND" };
}

/*
  Whether this user may act on this venue at all.

  Used by the route gate, and ONLY there. It is a check-then-act by nature, which is exactly the
  pattern the header above warns against — it's acceptable in one place because what follows it are
  the photo services, which constrain every statement to the venue id they're handed. Nothing reads
  venue data on the strength of this alone.

  ⚠️ Do not reach for this to "simplify" any of the four functions above. Their scope belongs in
  their own WHERE clauses.
*/
export async function venueGrantedTo(userId: string, venueId: string): Promise<boolean> {
  const result = await db.execute(sql`
    SELECT 1 FROM user_venues WHERE user_id = ${userId} AND venue_id = ${venueId} LIMIT 1
  `);

  return result.rows.length > 0;
}

/* ------------------------------------------------------------------------------------------- */

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
