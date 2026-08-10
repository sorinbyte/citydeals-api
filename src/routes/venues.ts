import { Hono } from "hono";
import { z } from "zod";

import { findNearby, getVenueBySlug, listVenues } from "@/services/venues";

/*
  Public catalogue reads. No auth — this is the browse surface, and none of it is member-specific.

  Every query param goes through zod before it reaches a query. Not because these particular
  endpoints are dangerous, but because "validate at the edge, always" is the habit that keeps the
  dangerous ones safe. A page number arriving as "1e9" or "-1" is the polite version of the attack.
*/

const listQuery = z.object({
  category: z.string().min(1).max(64).optional(),
  // Narrows within a category ('italian' inside 'restaurante'). Independent of `category` on
  // purpose — the filter chips send both, but either alone is a valid question to ask.
  subcategory: z.string().min(1).max(64).optional(),
  /*
    An enum, not a column name — an open "sort by whatever field you like" param is how a client
    ends up ordering by something unindexed, and the allowlist is the whole defence. Anything else
    is INVALID_QUERY rather than a silent fallback, so a client typo is loud instead of confusing.
    "nearby" isn't here: distance needs coordinates, so that's /venues/near.
  */
  sort: z.enum(["rating", "az", "za"]).default("rating"),
  /*
    Free-text search over name and tags. Trimmed here so " " isn't a search for a space, and
    capped so nobody makes us ILIKE a novel across the table. A whitespace-only q fails min(1)
    and comes back 400 — clients are expected to omit the param rather than send an empty one.
  */
  q: z.string().trim().min(1).max(64).optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  /*
    Page size is the caller's, because the mobile list and the marketing grid genuinely want
    different ones. Capped at 50 so a page is never an unbounded ask, and defaulted to the
    service's own 20 so every existing caller keeps the page size it already had.
  */
  perPage: z.coerce.number().int().min(1).max(50).default(20),
});

const nearQuery = z.object({
  // Bucharest-only product, but bounds are the whole planet — the server shouldn't invent a
  // geofence the product hasn't decided on. Nonsense coordinates get rejected, that's all.
  lat: z.coerce.number().min(-90).max(90),
  lng: z.coerce.number().min(-180).max(180),
  // capped so nobody asks for "everything within 20,000km" and makes us sort the whole table
  radius: z.coerce.number().int().min(50).max(50_000).default(2_000),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const venuesRoute = new Hono()

  .get("/", async (c) => {
    const parsed = listQuery.safeParse(c.req.query());
    if (!parsed.success) {
      return c.json({ error: { code: "INVALID_QUERY", details: parsed.error.flatten() } }, 400);
    }

    const { category, subcategory, q, sort, page, perPage } = parsed.data;
    return c.json(
      await listVenues({
        categoryKey: category,
        subcategoryKey: subcategory,
        search: q,
        sort,
        page,
        perPage,
      }),
    );
  })

  /*
    Registered before /:slug — otherwise "near" is read as a slug and this route is unreachable.
    Hono matches in declaration order, so the specific path has to come first.
  */
  .get("/near", async (c) => {
    const parsed = nearQuery.safeParse(c.req.query());
    if (!parsed.success) {
      return c.json({ error: { code: "INVALID_QUERY", details: parsed.error.flatten() } }, 400);
    }

    const { lat, lng, radius, limit } = parsed.data;
    return c.json({ items: await findNearby(lat, lng, radius, limit) });
  })

  .get("/:slug", async (c) => {
    const venue = await getVenueBySlug(c.req.param("slug"));
    // a code, not a sentence — the client owns the Romanian copy for this
    if (!venue) return c.json({ error: { code: "VENUE_NOT_FOUND" } }, 404);

    return c.json(venue);
  });
