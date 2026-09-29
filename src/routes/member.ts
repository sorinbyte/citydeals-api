import { Hono, type MiddlewareHandler } from "hono";
import { z } from "zod";

import { env } from "@/lib/env";
import { allowRequest, clientIp } from "@/lib/rate-limit";
import { deliverPhoneCode } from "@/lib/sms";
import {
  destroyMemberSession,
  findMemberBySessionToken,
  normalisePhone,
  requestPhoneCode,
  startTrial,
  touchMemberSeen,
  verifyPhoneCode,
} from "@/services/member-auth";
import {
  getRedemptionStatusForSession,
  issueRedemption,
  voidRedemption,
} from "@/services/redemptions";
import type { MemberProfile } from "@/types/api";

/*
  The mobile app's own surface, mounted under /v1/member.

  ⚠️ Shares nothing with /v1/partner or /v1/admin. A member is a phone with a bearer token, a
  partner is an email with a cookie, an admin is a Cloudflare Access identity — three different
  proofs of three different things. AGENTS.md's blast-radius argument for keeping the dashboards
  apart applies here twice over, since this is the only one of the three that unauthenticated
  members of the public can reach at will.

  ⚠️ A bearer token, not a cookie. The client is a phone: there is no browser, no origin, no CSRF to
  defend against and nothing for SameSite to mean. The token lives in expo-secure-store on the
  device and as a SHA-256 here.
*/

const requestCodeBody = z
  .object({
    /* Loose here on purpose — normalisePhone does the real work, because "0721 100 206" and
       "+40721100206" are the same number and a regex at the boundary would reject half the ways
       people type it. */
    phone: z.string().trim().min(6).max(20),
  })
  .strict();

const verifyBody = z
  .object({
    phone: z.string().trim().min(6).max(20),
    /* Exactly six digits. A length check here saves a scrypt-free but still pointless round trip,
       and it's the one place the shape is genuinely fixed. */
    code: z
      .string()
      .trim()
      .regex(/^\d{6}$/),
  })
  .strict();

const issueBody = z.object({ dealId: z.string().uuid() }).strict();

const idParam = z.string().uuid();

type MemberEnv = { Variables: { member: MemberProfile; sessionToken: string } };

/*
  Requires a live member session.

  Applied per-route rather than to the whole subtree, because the two auth endpoints underneath are
  exactly the ones you reach WITHOUT one.

  ⚠️ Hono treats "/x/:id" and "/x/:id/*" as different paths, so a gate applied to one does not cover
  the other — routes/partner.ts carries the same warning and it is easy to miss. Everything here is
  gated by naming the middleware on each route instead, which is harder to get subtly wrong.
*/
const requireMember: MiddlewareHandler<MemberEnv> = async (c, next) => {
  const header = c.req.header("Authorization");
  const token = header?.startsWith("Bearer ") ? header.slice(7).trim() : null;
  if (!token) return c.json({ error: { code: "UNAUTHENTICATED" } }, 401);

  const member = await findMemberBySessionToken(token);
  /* Expired and unknown get the same answer — the app's move is identical either way, and the
     distinction only helps someone probing. */
  if (!member) return c.json({ error: { code: "UNAUTHENTICATED" } }, 401);

  c.set("member", member);
  c.set("sessionToken", token);

  /* Fire-and-forget: the request must not wait on a "last seen" bump, and a failed one is not worth
     failing a redemption over. */
  void touchMemberSeen(member.id).catch(() => {});

  await next();
};

export const memberRoute = new Hono<MemberEnv>()
  /*
    Asks for a code.

    ⚠️ Always 204, whatever happens — even for a number that isn't Romanian, even when delivery
    fails. An endpoint that answers differently for a real number is one that enumerates our members
    one guess at a time, and phone numbers are guessable in a way email addresses are not: +407
    followed by eight digits is a walkable space.

    (PHONE_INVALID exists in the error union for the app's own client-side hint, not for this route
    to return.)
  */
  .post("/auth/request-code", async (c) => {
    const parsed = requestCodeBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.body(null, 204);

    const phone = normalisePhone(parsed.data.phone);
    if (!phone) return c.body(null, 204);

    /*
      Limits BEFORE anything else, and the per-phone one is the limit that matters — an attacker
      cannot forge someone else's number into being a different number, whereas X-Forwarded-For is
      client-controlled and the IP limit is only ever secondary. See lib/rate-limit.ts.

      Three per fifteen minutes is also a cost decision: once SMS is real, every one of these is
      money, and a resend button with no ceiling is a bill someone else writes.
    */
    if (!allowRequest(`member-code:phone:${phone}`, 3, 15 * 60_000)) {
      return c.body(null, 204);
    }
    const ip = clientIp(c.req.header("X-Forwarded-For"));
    if (ip && !allowRequest(`member-code:ip:${ip}`, 10, 15 * 60_000)) {
      return c.body(null, 204);
    }

    const issued = await requestPhoneCode(phone);
    const delivered = await deliverPhoneCode(phone, issued.code);
    if (!delivered) {
      /* Loud, because the caller got a cheerful 204 and this is the only place anyone finds out
         that a member is sitting there waiting for an SMS that isn't coming. */
      console.error(`verification code for ${phone} was minted but could not be delivered`);
    }

    /*
      ⚠️ The dev echo. This hands the code straight back to the caller, which in a deployed
      environment would make phone verification — the anti-fraud anchor of the product — completely
      decorative. It is gated on an explicit opt-in for that reason; see ALLOW_INSECURE_OTP.
    */
    if (env.ALLOW_INSECURE_OTP === "yes") {
      return c.json({ devCode: issued.code, expiresAt: issued.expiresAt.toISOString() });
    }

    return c.body(null, 204);
  })

  .post("/auth/verify", async (c) => {
    const parsed = verifyBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: { code: "INVALID_BODY", details: parsed.error?.flatten() } }, 400);
    }

    const phone = normalisePhone(parsed.data.phone);
    if (!phone) return c.json({ error: { code: "PHONE_INVALID" } }, 400);

    /* A second ceiling on guessing, above the per-code attempt cap: without it, an attacker just
       requests a fresh code every five failures and keeps going. */
    if (!allowRequest(`member-verify:phone:${phone}`, 10, 15 * 60_000)) {
      return c.json({ error: { code: "TOO_MANY_REQUESTS" } }, 429);
    }

    const result = await verifyPhoneCode(phone, parsed.data.code);
    if (!result.ok) {
      const status = result.reason === "TOO_MANY_ATTEMPTS" ? 429 : 400;
      return c.json({ error: { code: result.reason } }, status);
    }

    return c.json({
      token: result.token,
      expiresAt: result.expiresAt.toISOString(),
      member: result.member,
    });
  })

  .get("/me", requireMember, (c) => c.json(c.get("member")))

  .delete("/session", requireMember, async (c) => {
    await destroyMemberSession(c.get("sessionToken"));
    return c.body(null, 204);
  })

  /*
    Starts the trial.

    The length is ours and lives in the service — never sent by the client, and never negotiable
    per request. Idempotent: a second call returns the same profile rather than a second trial.
  */
  .post("/trial", requireMember, async (c) => {
    const member = await startTrial(c.get("member").id);
    if (!member) return c.json({ error: { code: "NOT_FOUND" } }, 404);
    return c.json(member);
  })

  /* ----------------------------------------------------------------------------------------- */

  /*
    Issues a redemption code.

    Rate-limited per member on top of the eligibility rules, because "one live code" stops a member
    holding two at once but does nothing about churning through a thousand — which would be a
    perfectly good way to hunt for a short-code collision, and a lot of rows.
  */
  .post("/redemptions", requireMember, async (c) => {
    const parsed = issueBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: { code: "INVALID_BODY", details: parsed.error?.flatten() } }, 400);
    }

    const member = c.get("member");
    if (!allowRequest(`redeem-issue:member:${member.id}`, 20, 15 * 60_000)) {
      return c.json({ error: { code: "TOO_MANY_REQUESTS" } }, 429);
    }

    const result = await issueRedemption(member.id, parsed.data.dealId);
    if (!result.ok) {
      const status = result.reason === "DEAL_NOT_FOUND" ? 404 : 409;
      /* availableAt rides along in details so the app can say WHEN, not just "not yet". */
      const details = result.availableAt ? { availableAt: result.availableAt } : undefined;
      return c.json({ error: { code: result.reason, details } }, status);
    }

    return c.json(result.redemption, 201);
  })

  /*
    What the redeem screen polls so it can go quiet the moment a waiter confirms.

    ⚠️ The ONE route here that doesn't use requireMember, and the reason is cost. It's polled every
    five seconds for up to fifteen minutes per redemption, which makes it hotter than everything
    else the app does put together — so it authenticates inside its own query rather than paying for
    a separate session lookup first. Two round trips become one.

    ⚠️ That is not a hole. getRedemptionStatusForSession puts the session check in the WHERE clause
    and can only return a redemption belonging to a live session — the same "scope in the query, not
    after it" rule AGENTS.md sets for venue access. Don't copy this shape onto a colder route: the
    middleware is the default for a reason, and this is the one case that earns the exception.
  */
  .get("/redemptions/:id", async (c) => {
    const header = c.req.header("Authorization");
    const token = header?.startsWith("Bearer ") ? header.slice(7).trim() : null;
    if (!token) return c.json({ error: { code: "UNAUTHENTICATED" } }, 401);

    const id = idParam.safeParse(c.req.param("id"));
    if (!id.success) return c.json({ error: { code: "INVALID_ID" } }, 400);

    const result = await getRedemptionStatusForSession(token, id.data);
    /* Kept distinct from a missing redemption: the app signs out on one and shows "cod inexistent"
       on the other, and collapsing them would strand a member behind the wrong message. */
    if (result.session === "invalid") return c.json({ error: { code: "UNAUTHENTICATED" } }, 401);
    if (!result.status) return c.json({ error: { code: "REDEMPTION_NOT_FOUND" } }, 404);

    return c.json(result.status);
  })

  /* The member closing the screen without using it — frees the one-live slot straight away instead
     of making them wait out the fifteen minutes to change their mind. */
  .delete("/redemptions/:id", requireMember, async (c) => {
    const id = idParam.safeParse(c.req.param("id"));
    if (!id.success) return c.json({ error: { code: "INVALID_ID" } }, 400);

    await voidRedemption(c.get("member").id, id.data);
    return c.body(null, 204);
  });
