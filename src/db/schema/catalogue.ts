import { sql } from "drizzle-orm";
import {
  boolean,
  char,
  check,
  index,
  integer,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  smallint,
  text,
  time,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { id, timestamps } from "@/db/schema/columns";
import { partners } from "@/db/schema/partners";
import { geography } from "@/db/types/geography";

/*
  The venue catalogue — what all three clients read. Nothing in here is member-specific and
  nothing in here is a secret; this is the public-facing half of the product.

  Deliberately NOT here yet: members, subscriptions, redemptions. Those need the auth decision
  that's still open in AGENTS.md, and guessing at them now would mean throwing the guess away.
*/

/*
  What to call a venue's price list. A restaurant has a "Meniu", a barber has "Servicii" — same UI,
  same table, different word.

  It's a CODE, not the word itself. Storing "Meniu" here would mean the API hands clients a
  user-facing Romanian string, which AGENTS.md forbids for a concrete reason: copy would then need
  a backend deploy, and the mobile app couldn't fix its own wording over OTA. Clients map this to
  a word. NULL means the venue has no price list at all and the button hides itself — a cinema or a
  phone-repair shop has nothing to put in one.
*/
export const menuKind = pgEnum("menu_kind", ["menu", "services"]);

/*
  Top-level categories. The key is a stable slug ('restaurante') rather than a uuid because both
  clients already hardcode these in routes and filter chips, and a URL like /localuri?categorie=
  restaurante has to keep working. Adding a category is a data change, not a migration.
*/
export const categories = pgTable("categories", {
  key: text("key").primaryKey(),
  labelRo: text("label_ro").notNull(),
  // relative path — clients prefix it with their own asset base URL. No hostnames in the DB.
  imagePath: text("image_path"),
  sortOrder: smallint("sort_order").notNull().default(0),
  ...timestamps,
});

export const subcategories = pgTable(
  "subcategories",
  {
    key: text("key").primaryKey(),
    categoryKey: text("category_key")
      .notNull()
      .references(() => categories.key, { onDelete: "cascade" }),
    labelRo: text("label_ro").notNull(),
    emoji: text("emoji"),
    imagePath: text("image_path"),
    sortOrder: smallint("sort_order").notNull().default(0),
    ...timestamps,
  },
  (t) => [index("subcategories_category_idx").on(t.categoryKey)],
);

export const venues = pgTable(
  "venues",
  {
    id: id(),
    /*
      Human-readable stable handle ('trattoria-bucureseana'). Public ids stay uuids — this is for
      URLs and for matching against the placeholder data both clients already ship, so the seed is
      re-runnable without the ids churning.
    */
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    /*
      The partner's round logo, shown on the venue hero. Nullable and null everywhere today — we
      have no real partner logos yet, the mobile mock was standing in with category artwork. The
      client renders a fallback rather than assuming one exists.

      Same deal as venue_photos.path: a key inside the bucket, never a full URL. The API composes
      the URL at read time so a domain change doesn't mean rewriting rows.
    */
    logoPath: text("logo_path"),
    /*
      Which company runs this place. A venue IS a partner's location — the punct de lucru and the
      thing members browse are the same address, so there's no separate locations table.

      Nullable, and null for all 30 seeded venues: they're placeholder data with no company behind
      them, and inventing 30 fake CUIs to satisfy a NOT NULL would be worse than an honest null.

      ⚠️ NEVER select this into a public response. summaryColumns in services/venues.ts is shared by
      the list, detail and nearby queries, so adding it there would tell the marketing site — and
      anyone reading the JSON — which company owns which venue.
    */
    partnerId: uuid("partner_id").references(() => partners.id, { onDelete: "set null" }),
    categoryKey: text("category_key")
      .notNull()
      .references(() => categories.key),
    // neighbourhood, shown next to the open/closed line
    area: text("area").notNull(),
    address: text("address").notNull(),
    // E.164, what a tel: URL wants. Never prettified in storage.
    phone: text("phone"),
    /*
      Geography, not geometry — ST_DWithin against this takes METRES. Geocoded once at onboarding,
      never at query time. See src/db/types/geography.ts for why this is a custom type.
    */
    location: geography("location").notNull(),
    /*
      Denormalised review aggregate. numeric, not float — 4.9 is not representable in binary
      floating point and ratings are compared and sorted. There's no reviews table yet; when there
      is, this becomes a maintained rollup rather than a seeded value.
    */
    rating: numeric("rating", { precision: 2, scale: 1 }),
    ratingCount: integer("rating_count").notNull().default(0),
    // free-text descriptors shown as chips ("Italian", "Pizza"). Not the same thing as
    // subcategories, which are a controlled list the filters actually query on.
    tags: text("tags").array().notNull().default(sql`'{}'::text[]`),
    isNew: boolean("is_new").notNull().default(false),
    /*
      Which word the price list goes by, or NULL for venues that don't have one. Deliberately per
      venue rather than derived from the category — a croitorie and a phone-repair shop genuinely
      do have a priced service list, they just don't have one seeded yet.
    */
    menuKind: menuKind("menu_kind"),
    /*
      Whether the venue is live in the app at all. NOT the same as open/closed — that's worked out
      from opening_hours at query time, because it changes by the minute and a stored boolean is
      wrong the moment it's written.
    */
    isPublished: boolean("is_published").notNull().default(true),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("venues_slug_key").on(t.slug),
    index("venues_category_idx").on(t.categoryKey),
    // "every location this partner runs" — the admin partner page's main question
    index("venues_partner_idx").on(t.partnerId),
    // GIST is what makes ST_DWithin fast. Without it PostGIS scans every row and the query still
    // returns the right answer, so this is the kind of thing you only notice at scale.
    index("venues_location_idx").using("gist", t.location),
  ],
);

export const venueSubcategories = pgTable(
  "venue_subcategories",
  {
    venueId: uuid("venue_id")
      .notNull()
      .references(() => venues.id, { onDelete: "cascade" }),
    subcategoryKey: text("subcategory_key")
      .notNull()
      .references(() => subcategories.key, { onDelete: "cascade" }),
  },
  // a trattoria is both 'italian' and 'pizza' — many-to-many, and the PK stops duplicates
  (t) => [
    primaryKey({ columns: [t.venueId, t.subcategoryKey] }),
    index("venue_subcategories_subcategory_idx").on(t.subcategoryKey),
  ],
);

export const venuePhotos = pgTable(
  "venue_photos",
  {
    id: id(),
    venueId: uuid("venue_id")
      .notNull()
      .references(() => venues.id, { onDelete: "cascade" }),
    // relative path into the asset bucket. The client builds the full URL — the domain isn't
    // finalised and hardcoding it here would bake it into the data.
    path: text("path").notNull(),
    sortOrder: smallint("sort_order").notNull().default(0),
    ...timestamps,
  },
  (t) => [index("venue_photos_venue_idx").on(t.venueId, t.sortOrder)],
);

/*
  Opening hours as data, so the server can answer "is this open right now" itself.

  The clients deliberately don't get an hours table to reason over — that'd be business logic on
  the device leaning on device time, which we don't trust. They get a decided boolean.

  weekday follows ISO-8601: 1 = Monday … 7 = Sunday. Postgres' own EXTRACT(ISODOW) matches, which
  keeps the "is it open" query free of off-by-one juggling.
*/
export const openingHours = pgTable(
  "opening_hours",
  {
    id: id(),
    venueId: uuid("venue_id")
      .notNull()
      .references(() => venues.id, { onDelete: "cascade" }),
    weekday: smallint("weekday").notNull(),
    opensAt: time("opens_at").notNull(),
    closesAt: time("closes_at").notNull(),
    ...timestamps,
  },
  (t) => [index("opening_hours_venue_idx").on(t.venueId, t.weekday)],
);

/*
  What kind of discount this is. Codes, not Romanian — clients own the wording and the icon.

  These three are the whole product: 1+1, something free, or a percentage off. Adding a fourth is
  a breaking change across three repos, so it's a decision, not a data entry.

    one_plus_one — two of a thing, one gets paid for
    free_item    — something comes free, usually on a qualifying purchase
    percentage   — a straight % off, with the number in percent_off
*/
export const dealType = pgEnum("deal_type", ["one_plus_one", "free_item", "percentage"]);

/*
  Grammatical gender, used for one job: choosing "unui" or "unei" in a composed sentence.

  Romanian has three genders, but neuter nouns take masculine articles in the singular — which is
  all this is ever asked about — so two values cover it. Codes rather than Romanian words, same as
  every other enum here.
*/
export const dealGender = pgEnum("deal_gender", ["m", "f"]);

/*
  The discounts themselves. What a member sees on a venue page.

  Note what is NOT here: no redemption codes, no per-member "already used" flag, no expiry
  timestamp. A code is issued signed and short-lived at redemption time and lives in its own table
  (not built yet). This table is the catalogue entry, not the entitlement.
*/
export const deals = pgTable(
  "deals",
  {
    id: id(),
    venueId: uuid("venue_id")
      .notNull()
      .references(() => venues.id, { onDelete: "cascade" }),
    type: dealType("type").notNull(),
    /*
      ⚠️ COMPOSED, never typed. Both this and `condition` are built server-side from the structured
      columns below — see lib/deal-copy.ts. They stay because every client reads them verbatim and
      always has, so none of this was visible to the mobile app.

      They used to be free text a venue owner wrote, which is why the catalogue ended up with sixty
      different ways of phrasing three offers. Anything writing here directly is now a bug.
    */
    title: text("title").notNull(),
    /*
      The catch, in plain Romanian — "Produsul cu valoarea mai mică este gratuit."

      This is a `condition`, not a `description`, and the distinction is the point: a description
      invites a client to parse it for meaning, a condition is understood to be display-only. It is
      NEVER parsed, matched on, or used to decide anything. Whether a member may redeem right now is
      the server's call, made against structured columns — not against this sentence.
    */
    condition: text("condition").notNull(),
    /*
      The number behind a `percentage` deal. NULL for the other two types.

      It exists so clients never have to scrape "20" out of the title to render a badge or sort by
      discount — that'd be business logic on the device, working off a string a partner can edit.
    */
    percentOff: smallint("percent_off"),
    /*
      ── The structured offer, as the owner actually enters it ────────────────────────────────
      These four are the input; `title` and `condition` above are what falls out of them.

      All nullable, because sixty rows predate them and there is no honest way to parse a noun back
      out of "Vii însoțit; al doilea bărbierit cu brici nu se taxează." Those rows keep their old
      prose until someone re-enters them, and the admin form says so. New rows always have these —
      enforced by the route's schema rather than by a CHECK, precisely so the old rows can stay.
    */

    /*
      The noun the offer is about.

      one_plus_one → what you get two of  ("felul principal", "tunsoarea")
      free_item    → what comes free      ("o cafea", "desertul")
      percentage   → NULL; a percentage is about the bill, not an item
    */
    itemLabel: text("item_label"),
    /*
      free_item only: what has to be bought to earn it. NULL means nothing does — a free
      consultation is a real offer, not a malformed one.
    */
    requiredItem: text("required_item"),
    /*
      ⚠️ Grammatical gender of `required_item`, purely so the composed sentence reads like Romanian:
      "la achiziția UNUI croissant" but "la achiziția UNEI cafele". There is no way to derive this
      from the noun — Romanian gender isn't predictable from spelling — so the owner picks it.

      NULL exactly when required_item is NULL; the CHECK below keeps the pair honest.
    */
    requiredGender: dealGender("required_gender"),
    /*
      percentage only: which menu section the discount is limited to, or NULL for the whole bill.

      ⚠️ The section TITLE, not its id, and deliberately not a foreign key. Saving a venue's menu
      replaces every section row (see replaceVenueMenu), so ids churn on every save — an FK here
      would break every scoped offer each time anyone touched the menu. A title survives that and
      goes stale only on a rename, which the admin page can show.
    */
    scopeLabel: text("scope_label"),
    /*
      What a member typically saves, in BANI (RON minor units). Integer — never a float, never a
      numeric we'd be tempted to do arithmetic on in JS. Clients display this and nothing else.
    */
    avgSavingMinor: integer("avg_saving_minor").notNull(),
    currency: char("currency", { length: 3 }).notNull().default("RON"),
    // how long before the same member can use this deal again
    refreshDays: smallint("refresh_days").notNull(),
    // 1+1 offers are inherently for two people; a straight % off is for one
    people: smallint("people").notNull().default(1),
    isActive: boolean("is_active").notNull().default(true),
    sortOrder: smallint("sort_order").notNull().default(0),
    ...timestamps,
  },
  (t) => [
    index("deals_venue_idx").on(t.venueId, t.sortOrder),
    /*
      Keeps the type and its payload honest at the database level rather than by convention: a
      percentage deal must carry a sensible percent, and the other two must not carry one at all.
      Without this, "type: free_item, percentOff: 20" is a perfectly insertable piece of nonsense.
    */
    check(
      "deals_percent_off_matches_type",
      sql`(${t.type} = 'percentage' AND ${t.percentOff} BETWEEN 1 AND 100)
          OR (${t.type} <> 'percentage' AND ${t.percentOff} IS NULL)`,
    ),
    /*
      The gender is only ever there to inflect the article in front of `required_item`, so one
      without the other is meaningless: a gender with nothing to agree with, or a noun the composer
      can't put an article in front of.

      ⚠️ Deliberately the ONLY check on the new columns. The per-type rules ("a 1+1 must name an
      item") are enforced by the route's zod schema instead, because sixty rows created before any
      of this exists would fail a CHECK and take the migration down with them.
    */
    check(
      "deals_required_gender_matches_item",
      sql`(${t.requiredItem} IS NULL) = (${t.requiredGender} IS NULL)`,
    ),
  ],
);
