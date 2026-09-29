import { type Context, Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { z } from "zod";

import { env } from "@/lib/env";
import { allowRequest, clientIp } from "@/lib/rate-limit";
import {
  confirmRedemption,
  findRedemptionByShortCode,
  findRedemptionByToken,
} from "@/services/redemptions";
import {
  enrolVenueDevice,
  findVenueByDeviceToken,
  revokeVenueDevice,
  verifyVenuePin,
} from "@/services/venue-pin";

/*
  The venue's side of a redemption, mounted under /v1/redeem. Entirely public — no session, no
  account, no app to install.

  That is the whole point of the design: a waiter picks up whatever phone is behind the bar, scans
  the member's screen with the camera app, and types four digits once. Anything that required them
  to have an account would mean onboarding every employee of every partner, and staff turnover in
  hospitality would make that a permanent job.

  ⚠️ Public and unauthenticated means everything here is reachable by anyone who can guess a URL.
  What protects it is that the token in the path is 128 random bits, the PIN is scrypt-hashed behind
  a lockout, and the short-code fallback is only reachable once a browser has proved the PIN.

  ⚠️ All of this is called SERVER-SIDE by the redeem app's own proxy, never by a browser directly.
  That is what lets the device cookie be host-only on the redeem app's origin, and it is why nothing
  here needed a change to the CORS allowlist in index.ts.
*/

/*
  The remembered venue.

  Host-only — no Domain attribute, which is what setCookie does when you don't pass one. Same rule
  and the same reason as the partner session cookie: a cookie on .<domain> would ride along to the
  marketing site on every request for a stylesheet.

  ⚠️ It carries a random token and NOTHING ELSE. If it held a venue id, the remembered venue would
  be a value the client could edit, and confirming redemptions at a venue of your choosing is
  precisely what this mechanism exists to prevent. The venue is looked up from our row, every time.
*/
const DEVICE_COOKIE = "cd_venue_device";

function deviceCookieOptions(expires: Date) {
  return {
    httpOnly: true,
    /* Browsers refuse a Secure cookie over plain http, so on a LAN IP in dev this would silently
       store nothing — a 200 that leaves the phone un-enrolled. Same opt-in as the partner cookie. */
    secure: env.ALLOW_INSECURE_COOKIE !== "yes",
    /* Lax: the page is reached by a top-level navigation from a camera app, which is exactly the
       case Strict would break. */
    sameSite: "Lax" as const,
    path: "/",
    expires,
  };
}

const confirmBody = z
  .object({
    /* Optional — a browser that already proved the PIN doesn't send one, which is the whole point
       of enrolling a device. */
    pin: z
      .string()
      .trim()
      .regex(/^\d{4}$/)
      .optional(),
  })
  .strict();

const byCodeBody = z
  .object({
    /* Six characters plus whatever separators or case they typed; the service canonicalises. */
    code: z.string().trim().min(6).max(12),
  })
  .strict();

/* base64url of 16 bytes is 22 chars. Bounded rather than pinned, so changing the token size later
   isn't a coordinated release — the real check is whether the hash matches a row. */
const tokenParam = z.string().trim().min(16).max(200);

export const redeemRoute = new Hono()
  /*
    What the page renders on arrival.

    ⚠️ Venue and deal only, never the member. Whoever scanned this is unauthenticated: they might be
    staff, or they might be the person at the next table who photographed a screen. Both of these
    fields are public catalogue data already.
  */
  .get("/:token", async (c) => {
    const token = tokenParam.safeParse(c.req.param("token"));
    if (!token.success) return c.json({ error: { code: "REDEMPTION_NOT_FOUND" } }, 404);

    const target = await findRedemptionByToken(token.data);
    if (!target) return c.json({ error: { code: "REDEMPTION_NOT_FOUND" } }, 404);

    /* Whether this browser still has to type the PIN. The venue has to match — a phone enrolled at
       one restaurant must not skip the PIN at another. */
    const deviceToken = getCookie(c, DEVICE_COOKIE);
    const deviceVenue = deviceToken ? await findVenueByDeviceToken(deviceToken) : null;

    return c.json({
      state: target.state,
      venue: target.venue,
      deal: target.deal,
      pinRequired: deviceVenue !== target.venue.id,
    });
  })

  /*
    Confirms it. The one write the whole product turns on.

    Two ways in: an enrolled device, or the PIN. A successful PIN enrols the device on the way
    through, so this is the last time anyone on this phone types it.
  */
  .post("/:token/confirm", async (c) => {
    const token = tokenParam.safeParse(c.req.param("token"));
    if (!token.success) return c.json({ error: { code: "REDEMPTION_NOT_FOUND" } }, 404);

    const parsed = confirmBody.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) {
      return c.json({ error: { code: "INVALID_BODY", details: parsed.error?.flatten() } }, 400);
    }

    const target = await findRedemptionByToken(token.data);
    if (!target) return c.json({ error: { code: "REDEMPTION_NOT_FOUND" } }, 404);

    const authorised = await authoriseForVenue(c, target.venue.id, parsed.data.pin);
    if (!authorised.ok) {
      return c.json({ error: { code: authorised.reason } }, authorised.status);
    }

    const result = await confirmRedemption(target.id, target.venue.id);
    if (!result.ok) return c.json({ error: { code: result.reason } }, 409);

    return c.json(result.confirmation);
  })

  /*
    The typed fallback, for when the scan won't work — a cracked screen, a camera that won't focus,
    a phone with the permission denied.

    ⚠️ Requires an already-enrolled device, deliberately. Without that, six characters would be a
    guessable handle on every live redemption on the platform; behind it, an attacker has to have
    got past the PIN at the venue first, at which point they could simply confirm things anyway.
  */
  .post("/by-code", async (c) => {
    const parsed = byCodeBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: { code: "INVALID_BODY", details: parsed.error?.flatten() } }, 400);
    }

    const deviceToken = getCookie(c, DEVICE_COOKIE);
    const venueId = deviceToken ? await findVenueByDeviceToken(deviceToken) : null;
    if (!venueId) return c.json({ error: { code: "PIN_INVALID" } }, 401);

    /* Its own ceiling. The code is short, and this is the one path where an attacker gets to pick
       what they try rather than having to hold a member's phone. */
    if (!allowRequest(`redeem-code:venue:${venueId}`, 30, 15 * 60_000)) {
      return c.json({ error: { code: "TOO_MANY_REQUESTS" } }, 429);
    }

    const target = await findRedemptionByShortCode(venueId, parsed.data.code);
    if (!target) return c.json({ error: { code: "REDEMPTION_NOT_FOUND" } }, 404);

    const result = await confirmRedemption(target.id, venueId);
    if (!result.ok) return c.json({ error: { code: result.reason } }, 409);

    return c.json(result.confirmation);
  })

  /* "Nu este localul meu" — a phone that ended up remembering the wrong venue, or one being handed
     on. Idempotent: clearing a cookie that's already gone is a no-op, not an error. */
  .delete("/device", async (c) => {
    const deviceToken = getCookie(c, DEVICE_COOKIE);
    if (deviceToken) await revokeVenueDevice(deviceToken);
    deleteCookie(c, DEVICE_COOKIE, { path: "/" });
    return c.body(null, 204);
  });

/* ------------------------------------------------------------------------------------------- */

type Authorisation =
  | { ok: true }
  | {
      ok: false;
      reason: "PIN_INVALID" | "PIN_LOCKED" | "PIN_NOT_SET" | "TOO_MANY_REQUESTS";
      status: 401 | 423 | 409 | 429;
    };

/*
  Is this browser allowed to confirm for this venue?

  An enrolled device short-circuits everything — which is not only a speed win. A PIN typed in front
  of every member is a PIN that leaks by lunchtime; typed once per phone, it mostly doesn't.

  ⚠️ The per-IP limit here is the layer that stops a PIN being brute-forced cheaply in parallel.
  It is not the only one — scrypt makes each guess expensive and the venue lockout bounds the total
  — and it is the weakest of the three, because X-Forwarded-For is client-controlled. All three
  matter; see services/venue-pin.ts.
*/
async function authoriseForVenue(
  c: Context,
  venueId: string,
  pin: string | undefined,
): Promise<Authorisation> {
  const deviceToken = getCookie(c, DEVICE_COOKIE);
  if (deviceToken) {
    const deviceVenue = await findVenueByDeviceToken(deviceToken);
    if (deviceVenue === venueId) return { ok: true };
  }

  if (!pin) return { ok: false, reason: "PIN_INVALID", status: 401 };

  const ip = clientIp(c.req.header("X-Forwarded-For"));
  if (ip && !allowRequest(`redeem-pin:ip:${ip}`, 10, 15 * 60_000)) {
    return { ok: false, reason: "TOO_MANY_REQUESTS", status: 429 };
  }

  const verified = await verifyVenuePin(venueId, pin);
  if (!verified.ok) {
    /* 423 Locked for the lockout, so a proxy or a log can tell it apart from an ordinary wrong
       guess without reading the body. */
    const status =
      verified.reason === "PIN_LOCKED" ? 423 : verified.reason === "PIN_NOT_SET" ? 409 : 401;
    return { ok: false, reason: verified.reason, status };
  }

  /* Proved it — so this phone never has to again. */
  const device = await enrolVenueDevice(venueId);
  setCookie(c, DEVICE_COOKIE, device.token, deviceCookieOptions(device.expiresAt));

  return { ok: true };
}
