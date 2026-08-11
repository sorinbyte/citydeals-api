import { timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { z } from "zod";

import { type AccessIdentity, createAccessVerifier } from "@/lib/access";
import { adminIdentityEnabled, env } from "@/lib/env";
import { UPLOADABLE_IMAGE_TYPES, deleteVenuePhotoObject, uploadVenuePhoto } from "@/lib/r2";
import { listMembersForAdmin } from "@/services/members";
import {
  createPartner,
  getPartner,
  isValidCui,
  listLeads,
  listPartners,
  updateLeadStatus,
  updatePartner,
} from "@/services/partners";
import { findPlatformOwnerByEmail } from "@/services/users";
import {
  addVenuePhoto,
  createDeal,
  createVenueForAdmin,
  deleteDeal,
  deleteVenuePhoto,
  getVenueForAdmin,
  listVenuesForAdmin,
  reorderVenuePhotos,
  replaceVenueMenu,
  updateDeal,
  updateVenueForAdmin,
} from "@/services/venues";

/*
  The admin dashboard's own surface. Everything here is mounted under /v1/admin and none of it is
  public.

  Authenticated by two independent things — see the gate below for the full reasoning:

    · ADMIN_API_SECRET  proves the request came from the admin app's server-side proxy, so a browser
      can't reach these routes and neither can anyone who merely finds the API host.
    · Cloudflare Access  proves WHICH PERSON is calling. The token is verified against the team's
      signing keys (lib/access.ts) and then matched to an active platform_owner in `users`.

  ⚠️ The second one is skipped ONLY on a localhost run that set ALLOW_INSECURE_ADMIN=yes, because
  Access can't mint a token for localhost. A deployed environment missing the Access variables
  refuses to boot rather than quietly falling back — see lib/env.ts.
*/

/*
  Built once at module load, so the JWKS cache is shared across requests rather than refetched per
  call. Only constructed when Access is configured — on a localhost run the variables are absent by
  design and there's nothing to build it from.
*/
const verifyAccessToken: (token: string) => Promise<AccessIdentity> =
  adminIdentityEnabled && env.CF_ACCESS_TEAM_DOMAIN && env.CF_ACCESS_AUD
    ? createAccessVerifier({
        teamDomain: env.CF_ACCESS_TEAM_DOMAIN,
        aud: env.CF_ACCESS_AUD,
      })
    : async () => {
        throw new Error("Access verification is not configured");
      };

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
  /*
    Replaces the whole set, so an empty array means "file this venue under none".

    Only the shape is checked here. Whether each key exists and belongs to the venue's category is
    a database question, and it's answered inside the same transaction that writes them — see
    updateVenueForAdmin.
  */
  subcategoryKeys: z.array(z.string().trim().min(1).max(64)).max(20),
});

/*
  Filters and paging for the admin venues table, mirroring the public list's listQuery.

  ⚠️ `published` arrives as a string because it's a query param — "false" is truthy, so it gets
  transformed rather than coerced. Absent means "both", which is not the same as either.

  perPage is bounded at the route, not in the service, and an over-large value is REJECTED rather
  than clamped — same as the public list's listQuery. Silently returning 100 when 9 999 was asked
  for makes `total` describe a page size the caller never chose.

  Defaults keep the common case ("just show me the venues") a bare URL.
*/
const venueListQuery = z.object({
  category: z.string().trim().min(1).max(64).optional(),
  published: z
    .enum(["true", "false"])
    .optional()
    .transform((value) => (value === undefined ? undefined : value === "true")),
  sort: z.enum(["name", "category", "area", "partner", "offers", "status"]).default("name"),
  direction: z.enum(["asc", "desc"]).default("asc"),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  perPage: z.coerce.number().int().min(1).max(100).default(25),
});

/*
  Filters and paging for the members table.

  ⚠️ One segment, not four. "zero utilizări", "frecvenți" and "plată eșuată" all need tables that
  don't exist (redemptions, payments), so they aren't offered rather than being offered and
  returning nothing.

  `q` searches phone and name. Bounded at 64 — it's a lookup, not a query language.
*/
const memberListQuery = z.object({
  q: z.string().trim().min(1).max(64).optional(),
  segment: z.enum(["trial-expira"]).optional(),
  sort: z.enum(["name", "phone", "trial", "lastSeen", "joined"]).default("joined"),
  direction: z.enum(["asc", "desc"]).default("desc"),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  perPage: z.coerce.number().int().min(1).max(100).default(25),
});

/*
  Creating a venue needs everything the edit form has, plus a point and an owner.

  ⚠️ Ranges only. A latitude of 26.1 and a longitude of 44.4 are both perfectly valid numbers and
  also a swapped Bucharest — that lands the venue in Uzbekistan and nothing here can tell. The admin
  form warns when coordinates fall outside Romania, which is a nudge rather than a rule, because the
  day we launch in Sofia a hard bound here becomes a bug.
*/
const venueCreateBody = venueBody.extend({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  /* Null is legal — a venue can exist before the company behind it does. */
  partnerId: z.string().uuid().nullable(),
});

/*
  An offer.

  ⚠️ NO title and NO condition. Those are composed server-side from the parts below (lib/deal-copy.ts)
  and the route will not accept them — accepting them would hand back exactly the free-text hole
  this replaced, where sixty offers ended up phrased sixty ways.

  A discriminated union rather than a bag of nullable fields, so the nonsense combinations can't be
  written down at all: a percentage with an item, a 1+1 with a scope, a free item with a percent.
  The database says the same thing about percent_off via deals_percent_off_matches_type; this makes
  the failure a 400 naming a field rather than a 500 from a constraint.

  avgSavingMinor is BANI and an integer — the admin form converts from RON before it gets here, and
  nothing on the server multiplies it by anything. A float is rejected by .int() rather than
  silently truncated.
*/

/*
  A noun an owner types: "felul principal", "o cafea", "masajul de 60 de minute".

  ⚠️ 40 characters, and the tightness is the point. This is the only free text left in an offer, so
  it's the only place left to be creative — at 60 there was room for "felul principal dar numai
  marți și joi", which is a term smuggled into a name. The longest real item in the catalogue is 23
  characters, so 40 is generous for a noun and cramped for a sentence.

  It won't stop someone determined and isn't meant to. What actually holds is that the condition is
  composed and has no slot to put terms in.
*/
const offerNoun = z.string().trim().min(2).max(40);

const dealFields = {
  avgSavingMinor: z.number().int().min(0).max(100_000_00),
  /* ISO 4217. Fixed length rather than an enum — the column is char(3) and the day a partner is
     billed in EUR this shouldn't need a deploy. */
  currency: z.string().trim().length(3).toUpperCase(),
  /* How often a member can use it again. 1 = daily. */
  refreshDays: z.number().int().min(1).max(365),
  /* 1+1 implies two people; the rest are usually one. Capped low because this is a table for two,
     not a group booking. */
  people: z.number().int().min(1).max(20),
  isActive: z.boolean(),
};

/* 8 MB. A resized WebP off the admin uploader is ~150KB, so this only ever catches a client that
   skipped the resize or something that isn't really a photo. */
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;

/* The complete, ordered list of the venue's photo ids. Partial lists are rejected in the service —
   see reorderVenuePhotos for why applying half an order is worse than refusing. */
const photoOrderBody = z.object({
  photoIds: z.array(z.string().uuid()).max(50),
});

/*
  A whole price list.

  Prices are BANI and integers, same rule as a deal's avgSavingMinor — the admin form converts what
  the person typed and nothing on the server multiplies anything.

  Bounded at 30 sections of 100 items: this replaces every row in one transaction, so an unbounded
  body is an unbounded write.
*/
const menuBody = z.object({
  /* null wipes the price list — a venue that genuinely has none, like a cinema. */
  kind: z.enum(["menu", "services"]).nullable(),
  sections: z
    .array(
      z.object({
        title: z.string().trim().min(1).max(120),
        items: z
          .array(
            z.object({
              name: z.string().trim().min(1).max(200),
              description: z
                .string()
                .trim()
                .max(500)
                .nullable()
                .transform((value) => (value === null || value === "" ? null : value)),
              priceMinor: z.number().int().min(0).max(100_000_00),
              currency: z.string().trim().length(3).toUpperCase(),
              isAvailable: z.boolean(),
            }),
          )
          .max(100),
      }),
    )
    .max(30),
});

const dealBody = z
  .discriminatedUnion("type", [
    /*
    A percentage is about the bill, not an item, so it names no noun. scopeLabel null means the
    whole thing — whatever "the whole thing" is called at this venue is worked out server-side from
    its menu_kind, not sent.

    ⚠️ scopeLabel is a menu section's TITLE, and it is NOT validated against the venue's sections.
    It's a snapshot: the form only offers titles that exist right now, and a section renamed later
    leaves the offer reading correctly but pointing at a name the menu no longer uses. Validating
    here would buy nothing that the form doesn't already give, and would fail on exactly the stale
    forms it's meant to catch.
  */
    z.object({
      type: z.literal("percentage"),
      percentOff: z.number().int().min(1).max(100),
      scopeLabel: z.string().trim().min(1).max(120).nullable(),
      ...dealFields,
    }),
    /*
    1+1 names one thing: what you get two of. Nothing else is offered because nothing else varies —
    the condition is always "the cheaper one is free", which is what 1+1 means.
  */
    z.object({
      type: z.literal("one_plus_one"),
      itemLabel: offerNoun,
      ...dealFields,
    }),
    /* A free item names what's free, and optionally what has to be bought to earn it. Both null is
     the "fără altă comandă" case — a free consultation is a real offer, not a malformed one. */
    z.object({
      type: z.literal("free_item"),
      itemLabel: offerNoun,
      requiredItem: offerNoun.nullable(),
      requiredGender: z.enum(["m", "f"]).nullable(),
      ...dealFields,
    }),
  ])
  /*
    ⚠️ requiredGender is required exactly when requiredItem is present, and refused when it isn't.

    It exists for one job — "la achiziția UNUI croissant" vs "UNEI cafele" — and Romanian gender
    can't be derived from spelling, so the owner picks it. The database enforces the same pairing in
    deals_required_gender_matches_item; this turns the violation into a named field error first.

    Checked out here rather than on the free_item member because zod's discriminatedUnion only
    accepts plain objects — a .refine() on a member makes it a ZodEffects and the union stops
    compiling.
  */
  .superRefine((value, ctx) => {
    if (value.type !== "free_item") return;
    if ((value.requiredItem === null) === (value.requiredGender === null)) return;

    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["requiredGender"],
      message: "requiredGender is required when requiredItem is set, and only then",
    });
  });

/*
  Splits the validated body into the offer and the rest.

  The wire shape is flat because that's what a form posts; the service takes a union so the
  impossible combinations can't be constructed. This is the one place that conversion happens.
*/
function toDealInput(body: z.infer<typeof dealBody>) {
  const { avgSavingMinor, currency, refreshDays, people, isActive } = body;
  const common = { avgSavingMinor, currency, refreshDays, people, isActive };

  switch (body.type) {
    case "percentage":
      return {
        ...common,
        offer: {
          type: "percentage" as const,
          percentOff: body.percentOff,
          scopeLabel: body.scopeLabel,
        },
      };
    case "one_plus_one":
      return { ...common, offer: { type: "one_plus_one" as const, itemLabel: body.itemLabel } };
    case "free_item":
      return {
        ...common,
        offer: {
          type: "free_item" as const,
          itemLabel: body.itemLabel,
          requiredItem: body.requiredItem,
          requiredGender: body.requiredGender,
        },
      };
  }
}

/*
  Set by the gate below once Access has been verified, so a handler can attribute a write to the
  person who made it rather than to ADMIN_ACTING_EMAIL.

  ⚠️ Absent on a localhost run with ALLOW_INSECURE_ADMIN — there's no token to derive them from, so
  anything reading these has to cope with undefined rather than assume.
*/
type AdminEnv = { Variables: { adminUserId: string; adminEmail: string } };

export const adminRoute = new Hono<AdminEnv>()

  /*
    One gate for the whole subtree — a per-route check is a check somebody forgets to add.

    TWO doors, answering different questions:

      1. x-admin-secret — did this come from the admin app's server-side proxy? A browser can't
         reach these routes without it, and neither can anyone who finds the API host.
      2. Cf-Access-Jwt-Assertion — WHICH PERSON got past Cloudflare Access? Verified against the
         team's signing keys, then matched to an active platform_owner in `users`.

    The secret alone can't identify anyone, and the token alone travels on a request a caller
    controls. Together they're "our server, on behalf of this named admin".

    ⚠️ Door 2 is skipped only on a localhost run that set ALLOW_INSECURE_ADMIN=yes, because Access
    can't mint a token for localhost. A deployed environment without the Access variables refuses to
    boot — see lib/env.ts.
  */
  .use("*", async (c, next) => {
    if (!secretMatches(c.req.header("x-admin-secret"))) {
      return c.json({ error: { code: "UNAUTHORIZED" } }, 401);
    }

    if (!adminIdentityEnabled) {
      await next();
      return;
    }

    const token = c.req.header("cf-access-jwt-assertion");
    if (!token) {
      /* Access sits in front of the whole subdomain, so a missing token means the request didn't
         come through it — a direct call to the API, or a proxy that stopped forwarding the header. */
      console.warn("admin request with no Cf-Access-Jwt-Assertion header");
      return c.json({ error: { code: "UNAUTHORIZED" } }, 401);
    }

    let identity: AccessIdentity;
    try {
      identity = await verifyAccessToken(token);
    } catch (error) {
      /*
        One response for every rejection. Expired, wrong audience, bad signature and unknown key all
        look identical to the caller — the distinction only helps someone probing. The detail goes
        to the log, where it's ours.
      */
      console.warn("Access token rejected:", error instanceof Error ? error.message : error);
      return c.json({ error: { code: "UNAUTHORIZED" } }, 401);
    }

    /*
      ⚠️ Getting past Access is not the same as being allowed in here.

      An Access policy could be widened, an identity provider could hand us someone new, and neither
      of those should grant platform_owner. The database is what decides — the token only says who
      is asking.
    */
    const admin = await findPlatformOwnerByEmail(identity.email);
    if (!admin) {
      console.warn(
        `Access allowed ${identity.email} through, but they are not an active platform_owner in users`,
      );
      return c.json({ error: { code: "FORBIDDEN" } }, 403);
    }

    c.set("adminUserId", admin.id);
    c.set("adminEmail", admin.email);
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
    The admin venues table.

    ⚠️ Declared BEFORE /venues/:id. Hono matches in order, and `:id` would happily swallow a
    request for `/venues` — the same trap venuesRoute documents for /near versus /:slug.

    Filters and sort come from the URL because the admin page keeps them there, so a filtered view
    is a link. Everything is validated: an unknown sort key would otherwise reach a Record lookup
    and hand `undefined` to the ORDER BY.
  */
  .get("/venues", async (c) => {
    const parsed = venueListQuery.safeParse(c.req.query());
    if (!parsed.success) {
      return c.json({ error: { code: "INVALID_QUERY", details: parsed.error.flatten() } }, 400);
    }

    const { category, published, sort, direction, page, perPage } = parsed.data;

    return c.json(
      await listVenuesForAdmin({
        categoryKey: category,
        isPublished: published,
        sort,
        direction,
        page,
        perPage,
      }),
    );
  })

  /*
    A new venue.

    Not nested under /partners/:id even though the admin UI creates from a partner's page — the
    partner is a field on the venue (and a nullable one), not the thing that owns the route. A
    future "add venue" button that isn't on a partner page sends partnerId: null and needs no new
    endpoint.
  */
  .post("/venues", async (c) => {
    const parsed = venueCreateBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: { code: "INVALID_BODY", details: parsed.error.flatten() } }, 400);
    }

    const result = await createVenueForAdmin(parsed.data);

    if (!result.ok) {
      /* 409 for a taken slug — the payload is fine, the world already contains this URL. The other
         three are the caller naming something that doesn't exist. */
      if (result.reason === "SLUG_TAKEN") {
        return c.json({ error: { code: "SLUG_TAKEN" } }, 409);
      }
      if (result.reason === "PARTNER_NOT_FOUND") {
        return c.json({ error: { code: "PARTNER_NOT_FOUND" } }, 404);
      }
      return c.json({ error: { code: result.reason } }, 400);
    }

    return c.json(result.venue, 201);
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
      /* Usually the category was changed and the old category's subcategories were left ticked. */
      if (result.reason === "SUBCATEGORY_INVALID") {
        return c.json({ error: { code: "SUBCATEGORY_INVALID" } }, 400);
      }
      return c.json({ error: { code: "CATEGORY_NOT_FOUND" } }, 400);
    }

    return c.json(result.venue);
  })

  /*
    Deals, nested under their venue.

    The nesting isn't decorative: every write is scoped to the (venue, deal) pair in SQL, so a deal
    id from another venue is a 404 rather than a successful edit of someone else's offer. And each
    one answers with the whole AdminVenue, so the dashboard replaces one cache entry instead of
    reconciling a nested array.
  */
  .post("/venues/:id/deals", async (c) => {
    const id = idParam.safeParse(c.req.param("id"));
    if (!id.success) return c.json({ error: { code: "INVALID_ID" } }, 400);

    const parsed = dealBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: { code: "INVALID_BODY", details: parsed.error.flatten() } }, 400);
    }

    const result = await createDeal(id.data, toDealInput(parsed.data));
    if (!result.ok) return c.json({ error: { code: "VENUE_NOT_FOUND" } }, 404);

    return c.json(result.venue, 201);
  })

  /* Full body, same reasoning as PATCH /partners/:id — the only caller is a form that always
     submits every field. */
  .patch("/venues/:id/deals/:dealId", async (c) => {
    const id = idParam.safeParse(c.req.param("id"));
    const dealId = idParam.safeParse(c.req.param("dealId"));
    if (!id.success || !dealId.success) return c.json({ error: { code: "INVALID_ID" } }, 400);

    const parsed = dealBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: { code: "INVALID_BODY", details: parsed.error.flatten() } }, 400);
    }

    const result = await updateDeal(id.data, dealId.data, toDealInput(parsed.data));
    if (!result.ok) return c.json({ error: { code: result.reason } }, 404);

    return c.json(result.venue);
  })

  .delete("/venues/:id/deals/:dealId", async (c) => {
    const id = idParam.safeParse(c.req.param("id"));
    const dealId = idParam.safeParse(c.req.param("dealId"));
    if (!id.success || !dealId.success) return c.json({ error: { code: "INVALID_ID" } }, 400);

    const result = await deleteDeal(id.data, dealId.data);
    if (!result.ok) return c.json({ error: { code: result.reason } }, 404);

    /* 200 with the venue rather than 204. The caller needs the new deal list anyway, and a second
       round trip to fetch what we already have in hand is wasted. */
    return c.json(result.venue);
  })

  /*
    Photo upload.

    Multipart rather than a presigned PUT straight to R2. The signed-URL shape keeps big bodies off
    the server, but it needs CORS configured by hand on the bucket and a second round trip to record
    the row — and the browser resizes to ~150KB before sending, so there is no big body to keep off.
    One code path, one place holding the credentials.

    Order matters: the object goes up FIRST, then the row. A row pointing at a key that was never
    written renders as a permanently broken image; an object with no row is invisible and costs
    nothing.
  */
  .post("/venues/:id/photos", async (c) => {
    const id = idParam.safeParse(c.req.param("id"));
    if (!id.success) return c.json({ error: { code: "INVALID_ID" } }, 400);

    const body = await c.req.parseBody().catch(() => null);
    const file = body?.file;
    if (!(file instanceof File)) {
      return c.json({ error: { code: "INVALID_BODY" } }, 400);
    }

    if (!UPLOADABLE_IMAGE_TYPES.has(file.type)) {
      return c.json({ error: { code: "UNSUPPORTED_MEDIA_TYPE" } }, 415);
    }

    /* Generous next to the ~150KB a resized WebP actually weighs. This is a backstop against a
       client that skipped the resize, not a budget. */
    if (file.size > MAX_UPLOAD_BYTES) {
      return c.json({ error: { code: "FILE_TOO_LARGE" } }, 413);
    }

    let path: string;
    try {
      path = await uploadVenuePhoto(id.data, new Uint8Array(await file.arrayBuffer()), file.type);
    } catch (error) {
      /* Ours to fix — bad credentials, bucket gone, R2 down. The caller can't act on the detail, so
         it goes to the log rather than the response. */
      console.error("R2 upload failed:", error);
      return c.json({ error: { code: "UPLOAD_FAILED" } }, 502);
    }

    const result = await addVenuePhoto(id.data, path);
    if (!result.ok) return c.json({ error: { code: "VENUE_NOT_FOUND" } }, 404);

    return c.json(result.venue, 201);
  })

  .delete("/venues/:id/photos/:photoId", async (c) => {
    const id = idParam.safeParse(c.req.param("id"));
    const photoId = idParam.safeParse(c.req.param("photoId"));
    if (!id.success || !photoId.success) return c.json({ error: { code: "INVALID_ID" } }, 400);

    const result = await deleteVenuePhoto(id.data, photoId.data);
    if (!result.ok) return c.json({ error: { code: result.reason } }, 404);

    /* Row first, object second, and the object delete is allowed to fail — see the note on
       deleteVenuePhotoObject. Not awaited into the response either way. */
    if (result.path) await deleteVenuePhotoObject(result.path);

    return c.json(result.venue);
  })

  /* Order is the array's order. "Make this one primary" is just this call with that id first —
     there is no is_primary column, the lowest sort_order IS the card image. */
  .patch("/venues/:id/photos/order", async (c) => {
    const id = idParam.safeParse(c.req.param("id"));
    if (!id.success) return c.json({ error: { code: "INVALID_ID" } }, 400);

    const parsed = photoOrderBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: { code: "INVALID_BODY", details: parsed.error.flatten() } }, 400);
    }

    const result = await reorderVenuePhotos(id.data, parsed.data.photoIds);
    if (!result.ok) return c.json({ error: { code: result.reason } }, 404);

    return c.json(result.venue);
  })

  /*
    The whole price list in one PATCH.

    Unlike deals, which get a route each. A menu is edited in bursts and nothing references a menu
    item id, so replacing it wholesale is far less machinery than section and item CRUD plus two
    kinds of reordering — see replaceVenueMenu for the full reasoning and the caveat.
  */
  .patch("/venues/:id/menu", async (c) => {
    const id = idParam.safeParse(c.req.param("id"));
    if (!id.success) return c.json({ error: { code: "INVALID_ID" } }, 400);

    const parsed = menuBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: { code: "INVALID_BODY", details: parsed.error.flatten() } }, 400);
    }

    const result = await replaceVenueMenu(id.data, parsed.data);
    if (!result.ok) return c.json({ error: { code: "VENUE_NOT_FOUND" } }, 404);

    return c.json(result.venue);
  })

  /*
    Members.

    ⚠️ Read-only, and it stays that way. Nothing an admin does should edit a member row — a phone
    number is changed by verifying the new one from the app, and there's nothing else here to edit.
    A refund or a plan change belongs to whatever owns payments, which isn't built.
  */
  .get("/members", async (c) => {
    const parsed = memberListQuery.safeParse(c.req.query());
    if (!parsed.success) {
      return c.json({ error: { code: "INVALID_QUERY", details: parsed.error.flatten() } }, 400);
    }

    const { q, segment, sort, direction, page, perPage } = parsed.data;

    return c.json(
      await listMembersForAdmin({
        search: q,
        expiringTrial: segment === "trial-expira",
        sort,
        direction,
        page,
        perPage,
      }),
    );
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
