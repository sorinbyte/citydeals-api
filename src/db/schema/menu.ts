import { boolean, char, index, integer, pgTable, smallint, text, uuid } from "drizzle-orm/pg-core";

import { venues } from "@/db/schema/catalogue";
import { id, timestamps } from "@/db/schema/columns";

/*
  The venue's own price list — "Meniu" at a restaurant, "Servicii" at a barber. One structure for
  both; the word comes from venues.menu_kind (a code, not the Romanian).

  Two levels because that's how every one of these actually reads: sections ("Paste", "Masaj",
  "Din tandoor") holding items with prices.

  ⚠️ These are the VENUE'S OWN prices, not discounted ones. The discount lives in `deals` and gets
  applied at the till by the venue. Nothing here is ever summed, discounted or compared against a
  deal — not on a client, not here. If a total is ever needed, it's computed server-side and sent.
*/

export const menuSections = pgTable(
  "menu_sections",
  {
    id: id(),
    venueId: uuid("venue_id")
      .notNull()
      .references(() => venues.id, { onDelete: "cascade" }),
    // partner content, so it stays Romanian — same as venue names and deal titles. The section
    // heading is the venue's own wording, not our app copy.
    title: text("title").notNull(),
    sortOrder: smallint("sort_order").notNull().default(0),
    ...timestamps,
  },
  (t) => [index("menu_sections_venue_idx").on(t.venueId, t.sortOrder)],
);

export const menuItems = pgTable(
  "menu_items",
  {
    id: id(),
    sectionId: uuid("section_id")
      .notNull()
      .references(() => menuSections.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    // optional — most menu lines are just a name and a price
    description: text("description"),
    /*
      MINOR UNITS (bani). Integer, same rule as deals.avg_saving_minor: never a float, never a
      numeric someone might be tempted to do arithmetic on in JS.
    */
    priceMinor: integer("price_minor").notNull(),
    currency: char("currency", { length: 3 }).notNull().default("RON"),
    // lets a partner grey out a seasonal item without deleting it and losing its ordering
    isAvailable: boolean("is_available").notNull().default(true),
    sortOrder: smallint("sort_order").notNull().default(0),
    ...timestamps,
  },
  (t) => [index("menu_items_section_idx").on(t.sectionId, t.sortOrder)],
);
