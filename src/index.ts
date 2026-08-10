import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";

import { pool } from "@/db/client";
import { env } from "@/lib/env";
import { adminRoute } from "@/routes/admin";
import { categoriesRoute } from "@/routes/categories";
import { venuesRoute } from "@/routes/venues";

const app = new Hono();

app.use("*", logger());

/*
  Wide open for now because every route here is public catalogue data and the client origins aren't
  decided yet — the domain is still open, and the mobile app sends no Origin at all.

  ⚠️ Tighten this to an allowlist BEFORE anything authenticated ships. A credentialed endpoint
  behind `origin: *` is how a session gets used from a site that isn't ours.
*/
app.use("*", cors());

/*
  Index of what's callable. Purely a developer convenience — hitting the root in a browser and
  getting a 404 tells you nothing about whether the thing is working. Safe to expose: every route
  below is public catalogue data.
*/
app.get("/", (c) =>
  c.json({
    service: "citydeals-api",
    version: "v1",
    routes: [
      "GET /health",
      "GET /v1/categories",
      "GET /v1/venues?category=&subcategory=&q=&sort=&page=&perPage=",
      "GET /v1/venues/:slug",
      "GET /v1/venues/near?lat=&lng=&radius=&limit=",
      /* Listed but not reachable without the admin secret — see routes/admin.ts. Naming them
         costs nothing: an attacker guesses /partners on the first try anyway, and hiding a route
         from a JSON index has never been what stops one. */
      "GET|POST /v1/admin/partners (admin secret)",
      "GET /v1/admin/partner-leads (admin secret)",
      "PATCH /v1/admin/partner-leads/:id (admin secret)",
    ],
  }),
);

/*
  Deliberately NOT under /v1 — this is an infrastructure probe, not part of the contract. A load
  balancer or uptime check shouldn't have to know which API version is current, and this endpoint
  has to keep answering even while /v1 and /v2 both exist.
*/
app.get("/health", async (c) => {
  try {
    await pool.query("SELECT 1");
    return c.json({ ok: true, db: "up" });
  } catch {
    // vague on purpose to the caller — the detail belongs in logs, not in a response body
    return c.json({ ok: false, db: "down" }, 503);
  }
});

/*
  Everything contractual lives under /v1.

  The reason is mobile, and only mobile. The web apps deploy in lockstep with this service, so a
  breaking change there is a coordinated release. A phone isn't: someone installs the app, never
  updates, and keeps calling whatever shape existed on the day they installed — for years. Without
  a version in the path the only safe change to this API is an additive one, permanently, and the
  first time that isn't enough the choice is between breaking those users and never fixing it.

  With the prefix, a breaking change becomes /v2 while /v1 keeps answering until the old installs
  drain. Costs nothing today; it's the kind of thing that's impossible to add later precisely
  because the clients you'd need to migrate are the ones you can't reach.
*/
const v1 = new Hono();
v1.route("/venues", venuesRoute);
v1.route("/categories", categoriesRoute);
/* Gated by a shared secret inside the route file, not here — one gate, next to the handlers it
   guards, rather than a middleware someone has to remember this mount point needs. */
v1.route("/admin", adminRoute);

app.route("/v1", v1);

/*
  Generic NOT_FOUND — an unrouted path is not the same thing as a venue that doesn't exist, and a
  client that special-cases VENUE_NOT_FOUND would render "acest local nu mai există" for a plain
  typo in a URL. VENUE_NOT_FOUND is only ever returned by the venue route itself.
*/
app.notFound((c) => c.json({ error: { code: "NOT_FOUND" } }, 404));

app.onError((err, c) => {
  console.error(err);
  // never leak a stack trace or a driver message to a client
  return c.json({ error: { code: "INTERNAL" } }, 500);
});

serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  console.log(`api listening on http://localhost:${info.port}`);
});

export default app;
export type AppType = typeof app;
