import { timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { z } from "zod";

import { env } from "@/lib/env";
import {
  createPartner,
  getPartner,
  isValidCui,
  listLeads,
  listPartners,
  updateLeadStatus,
  updatePartner,
} from "@/services/partners";
import { getVenueForAdmin, updateVenueForAdmin } from "@/services/venues";

/*
  The admin dashboard's own surface. Everything here is mounted under /v1/admin and none of it is
  public.

  ⚠️ NOT AUTHENTICATED, and the gate below is not a substitute.

  Real auth is still an open decision (AGENTS.md). What guards these routes today is a shared
  secret that only the admin app's server-side proxy knows — which means a browser can't reach
  them, and neither can anyone who finds the API host without it. What it does NOT do is identify
  who is calling, carry a role, or survive being leaked. Every write is attributed to the acting
  admin named in env, not to whoever sent the request.

  When Cloudflare Access identity is verified here properly, this file's guard is what gets
  replaced, and the ADMIN_API_SECRET env var goes with it.
*/

/*
  Constant-time compare. A plain `===` on a secret leaks its length and, in principle, its prefix
  through how long the comparison takes. Cheap to do right, and the habit matters more than this
  particular endpoint does.
*/
function secretMatches(provided: string | undefined): boolean {
  if (!provided) return false;

  const a = Buffer.from(provided);
  const b = Buffer.from(env.ADMIN_API_SECRET);
  // timingSafeEqual throws on a length mismatch, which would itself be the leak we're avoiding
  return a.length === b.length && timingSafeEqual(a, b);
}

const partnerBody = z.object({
  companyName: z.string().trim().min(2).max(200),
  /*
    Validated for real here, not just for shape. The admin form checks the same thing, but that's
    for the person typing — a rule enforced only in a browser is a rule that can be skipped.
  */
  cui: z.string().trim().min(2).max(16).refine(isValidCui, "CUI checksum failed"),
  status: z.enum(["draft", "confirmed"]),
  contactName: z.string().trim().min(2).max(200),
  /* zod v3 in this repo, so .string().email() — the bare z.email() the web apps use is v4. */
  contactEmail: z.string().email().max(320),
  contactPhone: z.string().trim().min(6).max(32),
});

const leadPatchBody = z.object({
  status: z.enum(["new", "contacted", "qualified", "rejected"]),
});

/*
  Path ids get checked before they reach SQL.

  Not paranoia about injection — the queries are parameterised. It's that Postgres rejects a
  non-uuid cast with an error, which surfaces as a 500 INTERNAL: the API ends up claiming it broke
  when the honest answer is "that isn't an id". A bad link should read as a bad link.
*/
const idParam = z.string().uuid();

/*
  A venue's editable fields. Not its photos, deals, menu or hours — those are collections with
  their own tables and their own ordering, and each needs a real editor rather than a corner of
  this one.

  The slug pattern is enforced rather than suggested: it's the marketing site's URL
  (/local/<slug>) and it's UNIQUE in the database. "Trattoria Bucureșteană" typed straight into
  that field would produce a URL with a space and a diacritic in it, which is a problem you find
  out about from a broken link rather than from a form.
*/
const venueBody = z.object({
  name: z.string().trim().min(2).max(200),
  slug: z
    .string()
    .trim()
    .min(2)
    .max(200)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "slug must be lowercase words separated by single dashes"),
  categoryKey: z.string().trim().min(1).max(64),
  area: z.string().trim().min(1).max(120),
  address: z.string().trim().min(2).max(300),
  /* Nullable, and an empty string means null — a venue genuinely may have no phone, and storing
     "" would make every caller check two things for the same absence. */
  phone: z
    .string()
    .trim()
    .max(32)
    .nullable()
    .transform((value) => (value === null || value === "" ? null : value)),
  isPublished: z.boolean(),
});

export const adminRoute = new Hono()

  /* One gate for the whole subtree — a per-route check is a check somebody forgets to add. */
  .use("*", async (c, next) => {
    if (!secretMatches(c.req.header("x-admin-secret"))) {
      return c.json({ error: { code: "UNAUTHORIZED" } }, 401);
    }
    await next();
  })

  .get("/partners", async (c) => c.json({ items: await listPartners() }))

  .post("/partners", async (c) => {
    const parsed = partnerBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: { code: "INVALID_BODY", details: parsed.error.flatten() } }, 400);
    }

    const result = await createPartner(parsed.data);

    if (!result.ok) {
      /* 409, not 400: the payload is fine, the world just already contains this company. The
         admin app renders a different message for it. */
      if (result.reason === "CUI_TAKEN") {
        return c.json({ error: { code: "CUI_TAKEN" } }, 409);
      }

      /*
        500 because this is our misconfiguration, not the caller's mistake — ADMIN_ACTING_EMAIL
        doesn't match a platform_owner in `users`. In dev that usually means the database hasn't
        been seeded yet.
      */
      console.error(
        `ADMIN_ACTING_EMAIL (${env.ADMIN_ACTING_EMAIL}) matches no platform_owner in users — run db:seed or fix the env var`,
      );
      return c.json({ error: { code: "ACTING_ADMIN_MISSING" } }, 500);
    }

    return c.json(result.partner, 201);
  })

  .get("/partners/:id", async (c) => {
    const id = idParam.safeParse(c.req.param("id"));
    if (!id.success) return c.json({ error: { code: "INVALID_ID" } }, 400);

    const partner = await getPartner(id.data);
    if (!partner) return c.json({ error: { code: "PARTNER_NOT_FOUND" } }, 404);

    return c.json(partner);
  })

  /*
    PATCH, and it wants the whole record.

    Two things that look like mistakes and aren't. It's PATCH rather than PUT because the admin
    app reaches this through a Next proxy that only exports GET/POST/PATCH/DELETE — a PUT would
    405 before it ever got here. And the body is the full `partnerBody` rather than a partial one
    because the only caller is an edit-in-place panel that always submits all six fields; a partial
    schema buys a dynamically-built SET clause to serve a case that doesn't exist.

    Same validation as create, CUI checksum included. created_by_user_id is never touched — who
    added a company is a fact about the past.
  */
  .patch("/partners/:id", async (c) => {
    const id = idParam.safeParse(c.req.param("id"));
    if (!id.success) return c.json({ error: { code: "INVALID_ID" } }, 400);

    const parsed = partnerBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: { code: "INVALID_BODY", details: parsed.error.flatten() } }, 400);
    }

    const result = await updatePartner(id.data, parsed.data);

    if (!result.ok) {
      if (result.reason === "NOT_FOUND") {
        return c.json({ error: { code: "PARTNER_NOT_FOUND" } }, 404);
      }
      /* 409 like create: the payload is fine, another company already owns this CUI. */
      return c.json({ error: { code: "CUI_TAKEN" } }, 409);
    }

    return c.json(result.partner);
  })

  /*
    By id and without the is_published filter, unlike the public /v1/venues/:slug. Both differences
    are deliberate — see getVenueForAdmin. An unpublished venue is invisible everywhere else, which
    is exactly when someone opens this page.
  */
  .get("/venues/:id", async (c) => {
    const id = idParam.safeParse(c.req.param("id"));
    if (!id.success) return c.json({ error: { code: "INVALID_ID" } }, 400);

    const venue = await getVenueForAdmin(id.data);
    if (!venue) return c.json({ error: { code: "VENUE_NOT_FOUND" } }, 404);

    return c.json(venue);
  })

  .patch("/venues/:id", async (c) => {
    const id = idParam.safeParse(c.req.param("id"));
    if (!id.success) return c.json({ error: { code: "INVALID_ID" } }, 400);

    const parsed = venueBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: { code: "INVALID_BODY", details: parsed.error.flatten() } }, 400);
    }

    const result = await updateVenueForAdmin(id.data, parsed.data);

    if (!result.ok) {
      if (result.reason === "NOT_FOUND") {
        return c.json({ error: { code: "VENUE_NOT_FOUND" } }, 404);
      }
      /* A taken slug is a conflict; an unknown category is the caller sending a key that doesn't
         exist. Different codes because the admin app words them differently. */
      if (result.reason === "SLUG_TAKEN") {
        return c.json({ error: { code: "SLUG_TAKEN" } }, 409);
      }
      return c.json({ error: { code: "CATEGORY_NOT_FOUND" } }, 400);
    }

    return c.json(result.venue);
  })

  .get("/partner-leads", async (c) => c.json({ items: await listLeads() }))

  .patch("/partner-leads/:id", async (c) => {
    const id = idParam.safeParse(c.req.param("id"));
    if (!id.success) return c.json({ error: { code: "INVALID_ID" } }, 400);

    const parsed = leadPatchBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: { code: "INVALID_BODY", details: parsed.error.flatten() } }, 400);
    }

    const lead = await updateLeadStatus(id.data, parsed.data.status);
    if (!lead) return c.json({ error: { code: "LEAD_NOT_FOUND" } }, 404);

    return c.json(lead);
  });
