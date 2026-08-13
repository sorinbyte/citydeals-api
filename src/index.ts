import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";

import { pool } from "@/db/client";
import { corsAllowedOrigins, env } from "@/lib/env";
import { adminRoute } from "@/routes/admin";
import { categoriesRoute } from "@/routes/categories";
import { partnerRoute } from "@/routes/partner";
import { venuesRoute } from "@/routes/venues";

const app = new Hono();

app.use("*", logger());

/*
  Allowlist, not `*`.

  Only browsers enforce CORS, so this governs exactly one thing: whether another website's
  JavaScript can read our responses on a visitor's behalf. The mobile app, both dashboards'
  server-side proxies and curl all send no Origin and are unaffected — which is why this list stays
  short. Today the entire cross-origin surface is POST /v1/partner-leads from the marketing site.

  ⚠️ This is NOT what protects /v1/admin — that's the shared secret plus the Access token in
  routes/admin.ts. Don't let a tightened CORS config read as "the admin routes are covered".
*/
app.use(
  "*",
  cors({
    /* An unlisted origin — and a request with no Origin at all — gets no header back rather than a
       reflected one. Reflecting whatever the caller sent is `*` with extra steps. */
    origin: (origin) => (corsAllowedOrigins.has(origin) ? origin : null),
    allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    /*
      Deliberately minimal. `x-admin-secret` and `cf-access-jwt-assertion` are NOT here and must
      never be: both are set server-side by a dashboard proxy, which never preflights. Listing them
      would be telling browsers those headers are acceptable cross-origin, which is precisely the
      request shape that should be impossible.
    */
    allowHeaders: ["Content-Type", "Accept"],
    /* Nothing here is cookie-authenticated — the app sends a bearer token, the dashboards call
       server-to-server. `credentials: true` beside a reflected origin is the classic way someone
       else's site gets to use a session. */
    credentials: false,
    maxAge: 86_400,
  }),
);

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
      "POST /v1/partner/auth/request-link",
      "POST /v1/partner/auth/session",
      "GET|DELETE /v1/partner/session (session cookie)",
      "GET /v1/partner/venues (session cookie)",
      "GET /v1/partner/venues/:id (session cookie)",
      "PATCH /v1/partner/venues/:id/contact (session cookie)",
      "PATCH /v1/partner/venues/:id/deals/:dealId (session cookie)",
      "POST|DELETE /v1/partner/venues/:id/photos (session cookie)",
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
/* Session-cookie gated, per route rather than per subtree — the two auth endpoints under it are
   exactly the ones you reach without a session. Shares no gate, no middleware and no helper with
   /v1/admin above; see the note at the top of routes/partner.ts. */
v1.route("/partner", partnerRoute);

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
  /* Printed because an empty allowlist fails in the one place nobody is looking — the marketing
     site's lead form, in a browser, with a CORS error in a console on someone else's machine.
     Server-side calls and the mobile app keep working either way, so nothing else would tell you. */
  console.log(
    corsAllowedOrigins.size > 0
      ? `cors: allowing ${[...corsAllowedOrigins].join(", ")}`
      : "cors: no browser origins allowed (CORS_ALLOWED_ORIGINS unset — the partner lead form will fail)",
  );

  /*
    ⚠️ Both of these print because both are development-only holes, and a hole nobody can see is a
    hole that ships. Same reasoning as the CORS line above: the symptom otherwise shows up
    somewhere nobody is looking.
  */
  if (env.LOGIN_LINK_TO_CONSOLE === "yes") {
    console.warn(
      "⚠️  LOGIN_LINK_TO_CONSOLE=yes — partner magic links are printed to this console in full.",
      "Anyone who can read these logs can sign in as any partner. Never set this in production.",
    );
  }
  if (env.ALLOW_INSECURE_COOKIE === "yes") {
    console.warn(
      "⚠️  ALLOW_INSECURE_COOKIE=yes — the partner session cookie is sent without Secure,",
      "so it travels in clear text over http. localhost only.",
    );
  }
  if (!env.PARTNER_BASE_URL) {
    console.log("partner: PARTNER_BASE_URL unset — sign-in links can't be built");
  }
});

export default app;
export type AppType = typeof app;
