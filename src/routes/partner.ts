import { Hono, type MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { z } from "zod";

import { loginLinkEmail, sendEmail } from "@/lib/email";
import { env } from "@/lib/env";
import {
  MAX_UPLOAD_BYTES,
  UPLOADABLE_IMAGE_TYPES,
  deleteVenuePhotoObject,
  uploadVenuePhoto,
} from "@/lib/r2";
import { allowRequest, clientIp } from "@/lib/rate-limit";
import {
  type PartnerSession,
  consumeLoginToken,
  destroySessionByToken,
  findSessionByToken,
  issueLoginToken,
} from "@/services/auth";
import {
  addVenuePhoto,
  deleteVenuePhoto,
  getVenueForPartner,
  listVenuesForPartner,
  reorderVenuePhotos,
  replaceVenueHours,
  replaceVenueMenu,
  setDealActiveForPartner,
  updateVenueContactForPartner,
  venueGrantedTo,
} from "@/services/venues";

/*
  The partner dashboard's own surface, mounted under /v1/partner.

  ⚠️ Shares NOTHING with /v1/admin, and that separation is the point. Admin is gated by a shared
  secret plus a Cloudflare Access token and is scoped to nobody; this is gated by a session cookie
  and is scoped to a specific list of venue ids. A single "auth middleware" serving both is one
  refactor away from a restaurant owner reading platform-wide numbers — which is the blast-radius
  argument AGENTS.md makes for keeping the two dashboards apart in the first place.

  ⚠️ There is deliberately no x-admin-secret check here. The partner app's proxy does not hold that
  secret and must not; a venue owner authenticated as themselves has no business reaching an admin
  route, and the surest guarantee is that the credential doesn't exist on that server.
*/

/*
  The session cookie.

  Host-only — NO Domain attribute, which is what `setCookie` does when you don't pass one, and it
  matters more than anything else in this file. A cookie on `.<domain>` would ride along to the
  marketing site on every request for a stylesheet. AGENTS.md calls this "the one that will bite".

  It's set on the response that travels back through the partner app's own /api/* proxy, so the
  browser stores it against partner.<domain> and nothing else.
*/
const SESSION_COOKIE = "cd_partner_session";

function sessionCookieOptions(expires: Date) {
  return {
    httpOnly: true,
    /*
      ⚠️ Off only on an explicit localhost opt-in. Browsers refuse a Secure cookie over plain http,
      so on http://localhost:3003 this would silently store nothing — a 200 that leaves you logged
      out. See ALLOW_INSECURE_COOKIE in lib/env.ts for why it's not inferred from NODE_ENV.
    */
    secure: env.ALLOW_INSECURE_COOKIE !== "yes",
    /*
      Lax, not Strict. The magic link is a top-level navigation from an email client to
      /acces/<token>, and under Strict the cookie set by that flow wouldn't be sent on the first
      request that follows — you'd sign in and immediately look signed out.

      Lax still blocks the cross-site POST case that SameSite exists for.
    */
    sameSite: "Lax" as const,
    path: "/",
    expires,
  };
}

const requestLinkBody = z.object({
  /* zod v3 in this repo, so .string().email() — the bare z.email() the web apps use is v4. */
  email: z.string().trim().toLowerCase().email().max(320),
});

const sessionBody = z.object({
  /* base64url of 32 bytes is 43 chars. Bounded rather than pinned to that length so rotating the
     token size later isn't a coordinated change — the real check is whether the hash matches a row. */
  token: z.string().trim().min(20).max(200),
});

/*
  Mails the sign-in link.

  ⚠️ Never throws, and the route deliberately does NOT await it — see the note there. A send failure
  is our problem, not a signal we're allowed to hand back.
*/
async function deliverLoginLink(email: string, token: string): Promise<void> {
  /* Trailing slashes stripped: PARTNER_BASE_URL is pasted from a browser bar as often as it's
     typed, and `https://partner.example/` + `/acces/…` is a 404 nobody enjoys diagnosing. */
  const link = `${env.PARTNER_BASE_URL.replace(/\/+$/, "")}/acces/${token}`;

  const sent = await sendEmail(email, loginLinkEmail(link));
  if (!sent) {
    /* Loud, because the caller got a cheerful 204 and this is the only place anyone will ever find
       out that a partner is sitting there waiting for mail that isn't coming. */
    console.error(`login link for ${email} was minted but could not be delivered`);
  }
}

/*
  Set by the gates below, so a handler never re-reads the cookie or re-resolves who's calling.

  `venueId` is only present under /venues/:id/*, where requireVenueScope has proved the signed-in
  user was granted it.
*/
type PartnerEnv = {
  Variables: { session: PartnerSession; sessionToken: string; venueId: string };
};

/*
  Requires a live session. Applied per-route rather than to the whole subtree, because the two auth
  endpoints underneath are precisely the ones you reach WITHOUT a session.

  ⚠️ Any future data route goes behind this AND scopes its query to session.venues. This middleware
  answers "who is calling"; it does not answer "may they see this venue", and treating it as if it
  did is how one forgotten WHERE clause leaks another partner's numbers.
*/
const requireSession: MiddlewareHandler<PartnerEnv> = async (c, next) => {
  const token = getCookie(c, SESSION_COOKIE);
  if (!token) return c.json({ error: { code: "UNAUTHENTICATED" } }, 401);

  const session = await findSessionByToken(token);
  if (!session) {
    /* Expired, unknown, or the account was suspended. All three get the same answer: the browser
       can't act differently on any of them, and the distinction only helps someone probing. */
    deleteCookie(c, SESSION_COOKIE, { path: "/" });
    return c.json({ error: { code: "UNAUTHENTICATED" } }, 401);
  }

  c.set("session", session);
  c.set("sessionToken", token);
  await next();
};

/*
  Proves the signed-in user was granted the venue in the path, before any handler under it runs.

  ⚠️ THE most important twelve lines in this file. Everything below it reads or writes venue data,
  and this is the only thing that decides whose. AGENTS.md: the API is the boundary, and hiding a
  screen in the dashboard protects nothing.

  ⚠️ "Doesn't exist" and "isn't yours" are the SAME 404, deliberately. The scoped query can't tell
  them apart without a second one, and there's nothing to protect by distinguishing them anyway —
  GET /v1/venues is public, so venue existence is not a secret. What IS worth not leaking is which
  venues belong to which partner, and a 403 here would spell that out one id at a time.
*/
const requireVenueScope: MiddlewareHandler<PartnerEnv> = async (c, next) => {
  const venueId = idParam.safeParse(c.req.param("id"));
  /* A malformed id can't be anyone's, so it doesn't need distinguishing from one that isn't. */
  if (!venueId.success) return c.json({ error: { code: "VENUE_NOT_FOUND" } }, 404);

  const granted = await venueGrantedTo(c.get("session").user.id, venueId.data);
  if (!granted) return c.json({ error: { code: "VENUE_NOT_FOUND" } }, 404);

  c.set("venueId", venueId.data);
  await next();
};

/*
  Path ids get checked before they reach SQL. Not paranoia about injection — the queries are
  parameterised. It's that Postgres rejects a non-uuid cast with an error, which would surface as a
  500: the API claiming it broke when the honest answer is "that isn't an id".
*/
const idParam = z.string().uuid();

/*
  ⚠️ TWO FIELDS, and the list does not grow without a deliberate decision.

  `.strict()` so an unknown key is a 400 rather than being silently dropped. Without it, a request
  carrying `isPublished` or `slug` would answer 200 with those columns untouched, which reads as
  "accepted" to whoever sent it. The service can't write them either — belt and braces, because
  this is the boundary where a partner's input meets our catalogue.
*/
const contactBody = z
  .object({
    /* Null is "no phone on file", which is a real state. The dashboard sends null for an empty
       input rather than "" — two spellings of the same absence is how a column ends up with both. */
    phone: z.string().trim().min(6).max(32).nullable(),
    address: z.string().trim().min(2).max(300),
  })
  .strict();

/* Pause/resume, and nothing else. `.strict()` for the same reason as above, and here it's the
   difference between "you can't edit the terms" and "you can, it just doesn't save". */
const dealActiveBody = z.object({ isActive: z.boolean() }).strict();

/* The complete, ordered list of the venue's photo ids. Partial lists are rejected in the service —
   see reorderVenuePhotos for why applying half an order is worse than refusing. */
const photoOrderBody = z.object({ photoIds: z.array(z.string().uuid()).min(1).max(50) });

/*
  The whole opening schedule, replacing whatever is there. An empty array is legal and means
  "no hours on file", which the app renders as a venue with no opening times rather than one that
  is permanently shut.

  ⚠️ NO rule that closesAt must be after opensAt, and adding one would be a bug rather than a
  tightening. `closesAt <= opensAt` is how a window crossing midnight is stored — a restaurant open
  10:00–01:00 is a single Friday row closing Saturday morning, and lib/hours.ts reads it that way
  deliberately. Rejecting those would make it impossible to describe most restaurants in Bucharest.

  21 windows is three per day, which is more shifts than any venue in the catalogue runs.
*/
const hoursBody = z
  .object({
    windows: z
      .array(
        z.object({
          /* ISO-8601: 1 = Monday … 7 = Sunday, matching EXTRACT(ISODOW). */
          weekday: z.number().int().min(1).max(7),
          /* "HH:MM", 24-hour. Postgres casts it to `time`; the regex is what stops a bad string
             reaching that cast and surfacing as a 500 instead of a 400. */
          opensAt: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
          closesAt: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
        }),
      )
      .max(21),
  })
  .strict();

/*
  The price list. Same shape the admin route accepts, and deliberately a second copy rather than an
  import — routes/admin.ts and this file don't share code, and a schema is exactly the kind of thing
  that starts as a shared constant and ends as a shared gate.
*/
const menuBody = z
  .object({
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
                /* BANI. The form converts from the RON string someone typed before it gets here —
                   nothing on either side does money arithmetic. */
                priceMinor: z.number().int().min(0).max(100_000_00),
                currency: z.string().trim().length(3).toUpperCase(),
                isAvailable: z.boolean(),
              }),
            )
            .max(100),
        }),
      )
      .max(30),
  })
  .strict();

export const partnerRoute = new Hono<PartnerEnv>()

  /*
    Asks for a sign-in link.

    ⚠️ ALWAYS 204. Not 404 for an unknown address, not 200-with-a-flag, not a different latency if
    we can help it. An endpoint that answers differently for a known email is an endpoint that
    enumerates our partners' addresses one guess at a time — and those are the people whose venues
    we'd be helping someone target.

    Which is also why the partner app's copy hedges ("dacă adresa … are cont"). That vagueness is
    this decision showing through to the UI, not woolly writing.

    ⚠️ The rate limit below is NOT about mail volume. Every new token invalidates the previous one
    (services/auth.ts), so without a limit anyone who knows a partner's address can lock them out of
    their own account indefinitely by re-requesting faster than they can click.
  */
  .post("/auth/request-link", async (c) => {
    const parsed = requestLinkBody.safeParse(await c.req.json().catch(() => null));
    /*
      Even a malformed body gets 204. A 400 here would still separate "that's not an email" from
      "that email isn't one of ours", which is a smaller leak but the same kind.
    */
    if (!parsed.success) return c.body(null, 204);

    const email = parsed.data.email;

    /*
      ⚠️ Counted BEFORE the account lookup, and applied to every well-formed address whether or not
      it belongs to anyone. This is the whole trick: a limiter that only counted real accounts would
      answer 429 for a partner and 204 for a stranger, which is exactly the enumeration oracle the
      204 was designed to prevent — we'd have closed one hole by opening it somewhere louder.
    */
    const ip = clientIp(c.req.header("x-forwarded-for"));
    const withinEmailLimit = allowRequest(`request-link:email:${email}`, 3, 15 * 60 * 1000);
    /* No header at all means a direct connection (local dev). Skipped rather than bucketed under a
       shared key, which would rate-limit the whole of localhost as if it were one attacker. */
    const withinIpLimit = ip ? allowRequest(`request-link:ip:${ip}`, 10, 15 * 60 * 1000) : true;

    if (!withinEmailLimit || !withinIpLimit) {
      console.log(`login link rate-limited for ${email} (ip ${ip ?? "unknown"})`);
      return c.json({ error: { code: "TOO_MANY_REQUESTS" } }, 429);
    }

    const issued = await issueLoginToken(email);
    if (issued) {
      /*
        ⚠️ Deliberately NOT awaited, and `void` says so out loud rather than leaving it looking like
        a forgotten await.

        Awaiting it would put a round trip to Resend on the known-address path and nothing on the
        unknown one — a timing difference big enough to enumerate our partners' emails with, which
        is the exact thing the always-204 above exists to prevent. Answering at the same speed
        either way matters more than knowing whether the mail left before we reply.

        Safe to float: sendEmail swallows everything and returns a boolean, so there's no rejection
        to go unhandled, and this is a long-lived Node process rather than a request-scoped worker,
        so nothing cancels it at the end of the response.
      */
      void deliverLoginLink(email, issued.token);
    } else {
      /* Logged, never returned. Useful when someone swears they typed it right — usually they're a
         platform_owner, or the account was suspended. */
      console.log(`login link requested for ${email} — no active venue_owner`);
    }

    return c.body(null, 204);
  })

  /* Trades a link token for a session cookie. */
  .post("/auth/session", async (c) => {
    const parsed = sessionBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: { code: "TOKEN_INVALID" } }, 400);

    const result = await consumeLoginToken(parsed.data.token);
    if (!result.ok) {
      /* 400 rather than 401 on purpose: nothing about the caller's identity was rejected, the
         thing they presented was spent or stale. The partner app words each code differently. */
      return c.json({ error: { code: result.reason } }, 400);
    }

    setCookie(c, SESSION_COOKIE, result.sessionToken, sessionCookieOptions(result.expiresAt));

    /* The session comes back in the body too, so the app can render a name immediately instead of
       doing a second round trip to /session it already knows the answer to. */
    return c.json(result.session);
  })

  .get("/session", requireSession, (c) => c.json(c.get("session")))

  .delete("/session", requireSession, async (c) => {
    await destroySessionByToken(c.get("sessionToken"));
    /* Cleared on the way out as well as deleted server-side. Either alone would do; both means a
       browser that ignores one still ends up signed out. */
    deleteCookie(c, SESSION_COOKIE, { path: "/" });
    return c.body(null, 204);
  })

  /* --- venues -------------------------------------------------------------------------------- */

  .get("/venues", requireSession, async (c) =>
    c.json({ items: await listVenuesForPartner(c.get("session").user.id) }),
  )

  /*
    ⚠️ ONE GATE for everything under /venues/:id, rather than a check per handler. A per-route check
    is a check somebody eventually forgets to add, and the thing they'd be forgetting here is the
    only thing standing between a restaurant owner and another restaurant's page.

    Order matters: requireSession first (there's no user to scope to otherwise), then this.
  */
  .use("/venues/:id/*", requireSession, requireVenueScope)
  /* Hono matches "/venues/:id" and "/venues/:id/*" as different paths, so the detail route needs
     the gate named again. Easy to miss, and missing it is unauthenticated venue access. */
  .use("/venues/:id", requireSession, requireVenueScope)

  .get("/venues/:id", async (c) => {
    const venue = await getVenueForPartner(c.get("session").user.id, c.get("venueId"));
    if (!venue) return c.json({ error: { code: "VENUE_NOT_FOUND" } }, 404);

    return c.json(venue);
  })

  /*
    Phone and address.

    ⚠️ Its own path segment rather than PATCH /venues/:id, and that's not cosmetic. The admin route
    with that shape takes the whole venue including is_published and slug; giving the partner one
    that looks identical but means something much narrower is exactly the pair of endpoints someone
    later "unifies". /contact can't be confused with it.
  */
  .patch("/venues/:id/contact", async (c) => {
    const parsed = contactBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: { code: "INVALID_BODY", details: parsed.error.flatten() } }, 400);
    }

    const result = await updateVenueContactForPartner(
      c.get("session").user.id,
      c.get("venueId"),
      parsed.data,
    );
    if (!result.ok) return c.json({ error: { code: result.reason } }, 404);

    return c.json(result.venue);
  })

  /*
    Pause or resume an offer, and nothing else.

    ⚠️ `.strict()` on the body is load-bearing. Without it zod silently drops unknown keys, so a
    request carrying percentOff or title would 200 with the offer unchanged — which reads as "the
    edit was accepted" to anyone testing, and would send someone looking for a bug in the service.
    With it, trying to edit terms here is a 400 that says so.
  */
  .patch("/venues/:id/deals/:dealId", async (c) => {
    const dealId = idParam.safeParse(c.req.param("dealId"));
    if (!dealId.success) return c.json({ error: { code: "INVALID_ID" } }, 400);

    const parsed = dealActiveBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: { code: "INVALID_BODY", details: parsed.error.flatten() } }, 400);
    }

    const result = await setDealActiveForPartner(
      c.get("session").user.id,
      c.get("venueId"),
      dealId.data,
      parsed.data.isActive,
    );
    if (!result.ok) return c.json({ error: { code: result.reason } }, 404);

    return c.json(result.venue);
  })

  /*
    Photos. These three call the same services admin does, which is fine and deliberate: they're
    data access, they constrain every statement to the venue id they're handed, and the gate above
    has already proved that id is this user's. What is NOT shared is how we got here.
  */
  .post("/venues/:id/photos", async (c) => {
    const venueId = c.get("venueId");

    const body = await c.req.parseBody().catch(() => null);
    const file = body?.file;
    if (!(file instanceof File)) return c.json({ error: { code: "INVALID_BODY" } }, 400);

    if (!UPLOADABLE_IMAGE_TYPES.has(file.type)) {
      return c.json({ error: { code: "UNSUPPORTED_MEDIA_TYPE" } }, 415);
    }

    /* A backstop against a client that skipped the browser-side resize, not a budget. */
    if (file.size > MAX_UPLOAD_BYTES) {
      return c.json({ error: { code: "FILE_TOO_LARGE" } }, 413);
    }

    let path: string;
    try {
      path = await uploadVenuePhoto(venueId, new Uint8Array(await file.arrayBuffer()), file.type);
    } catch (error) {
      /* Ours to fix — bad credentials, bucket gone, R2 down. The caller can't act on the detail. */
      console.error("R2 upload failed:", error);
      return c.json({ error: { code: "UPLOAD_FAILED" } }, 502);
    }

    const result = await addVenuePhoto(venueId, path);
    if (!result.ok) {
      /* The object is already in R2 by now, so a refusal has to take it back out or the bucket
         collects one orphan per rejected upload. Allowed to fail — a stray object costs pennies. */
      await deleteVenuePhotoObject(path);

      /* 409, not 404: the venue is fine, it's full. A 404 here would send someone looking for a
         venue that's plainly on their screen. */
      if (result.reason === "PHOTO_LIMIT_REACHED") {
        return c.json({ error: { code: "PHOTO_LIMIT_REACHED" } }, 409);
      }
      return c.json({ error: { code: "VENUE_NOT_FOUND" } }, 404);
    }

    return c.json(result.venue, 201);
  })

  .delete("/venues/:id/photos/:photoId", async (c) => {
    const photoId = idParam.safeParse(c.req.param("photoId"));
    if (!photoId.success) return c.json({ error: { code: "INVALID_ID" } }, 400);

    const result = await deleteVenuePhoto(c.get("venueId"), photoId.data);
    if (!result.ok) return c.json({ error: { code: result.reason } }, 404);

    /* Row first, object second, and the object delete is allowed to fail — an orphaned R2 object
       costs pennies, a row pointing at a deleted object is a broken image forever. */
    if (result.path) await deleteVenuePhotoObject(result.path);

    return c.json(result.venue);
  })

  .patch("/venues/:id/photos/order", async (c) => {
    const parsed = photoOrderBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: { code: "INVALID_BODY", details: parsed.error.flatten() } }, 400);
    }

    const result = await reorderVenuePhotos(c.get("venueId"), parsed.data.photoIds);
    if (!result.ok) return c.json({ error: { code: result.reason } }, 404);

    return c.json(result.venue);
  })

  /*
    Opening hours and the price list.

    Both are unambiguously the partner's to set — when they open and what they charge is their
    business, not our catalogue policy — so unlike the offer routes there's no ratchet and nothing
    frozen here. The venue's own prices are also NOT the discount: that lives on the offers, which
    a partner still can't edit.
  */
  .patch("/venues/:id/hours", async (c) => {
    const parsed = hoursBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: { code: "INVALID_BODY", details: parsed.error.flatten() } }, 400);
    }

    const result = await replaceVenueHours(c.get("venueId"), parsed.data.windows);
    if (!result.ok) return c.json({ error: { code: result.reason } }, 404);

    return c.json(result.venue);
  })

  .patch("/venues/:id/menu", async (c) => {
    const parsed = menuBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: { code: "INVALID_BODY", details: parsed.error.flatten() } }, 400);
    }

    /* Same service admin uses. It constrains every statement to the venue id it's handed, and the
       gate above has already proved that id is this user's. */
    const result = await replaceVenueMenu(c.get("venueId"), parsed.data);
    if (!result.ok) return c.json({ error: { code: result.reason } }, 404);

    return c.json(result.venue);
  });
