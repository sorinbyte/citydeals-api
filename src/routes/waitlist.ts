import { Hono } from "hono";
import { z } from "zod";

import { sendEmail, waitlistConfirmEmail } from "@/lib/email";
import { env } from "@/lib/env";
import { allowRequest, clientIp } from "@/lib/rate-limit";
import { confirmWaitlist, joinWaitlist } from "@/services/waitlist";

/*
  The marketing site's "anunță-mă când lansați" list. Public, unauthenticated, called from the
  browser — so it's on the CORS allowlist alongside POST /partner-leads.

  Double opt-in: joining only sends a confirmation email; the address counts once its link is
  clicked (POST /waitlist/confirm, which the marketing site's /confirmare-email page calls).
*/

const joinBody = z.object({
  /* zod v3 in this repo, so .string().email() */
  email: z.string().trim().toLowerCase().email().max(320),
  /* The consent box. Must be literally true — an unticked box never reaches the database. */
  consent: z.literal(true),
  source: z.enum(["home", "abonament"]).default("home"),
});

const confirmBody = z.object({
  /* base64url of 32 bytes is 43 chars; bounded rather than pinned, same as the login tokens */
  token: z.string().min(20).max(128),
});

export const waitlistRoute = new Hono()
  .post("/", async (c) => {
    const parsed = joinBody.safeParse(await c.req.json().catch(() => null));
    /* Unlike the login link, a bad address here IS worth a 400: there's no account behind it to
       enumerate, and the form needs to tell someone they typed it wrong. */
    if (!parsed.success) return c.json({ error: { code: "INVALID_REQUEST" } }, 400);

    const { email, source } = parsed.data;

    // no origin to build the confirmation link from — refuse rather than store an address that
    // can never be confirmed (see MARKETING_BASE_URL in lib/env.ts)
    const marketingBase = env.MARKETING_BASE_URL;
    if (!marketingBase) return c.json({ error: { code: "WAITLIST_UNCONFIGURED" } }, 503);

    // counted before anything is looked up, for every well-formed address — same as request-link
    const ip = clientIp(c.req.header("x-forwarded-for"));
    const withinEmailLimit = allowRequest(`waitlist:email:${email}`, 3, 60 * 60 * 1000);
    const withinIpLimit = ip ? allowRequest(`waitlist:ip:${ip}`, 10, 60 * 60 * 1000) : true;
    if (!withinEmailLimit || !withinIpLimit) {
      return c.json({ error: { code: "TOO_MANY_REQUESTS" } }, 429);
    }

    const issued = await joinWaitlist(email, source);
    if (issued) {
      const link = `${marketingBase.replace(/\/+$/, "")}/confirmare-email?token=${issued.token}`;
      /*
        Not awaited, and the response is the same 204 whether or not a mail was due — someone typing
        a stranger's address learns nothing about whether it's already on the list. sendEmail never
        throws, so nothing floats unhandled.
      */
      void sendEmail(email, waitlistConfirmEmail(link));
    }

    return c.body(null, 204);
  })
  .post("/confirm", async (c) => {
    const parsed = confirmBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: { code: "INVALID_TOKEN" } }, 400);

    const ip = clientIp(c.req.header("x-forwarded-for"));
    if (ip && !allowRequest(`waitlist-confirm:ip:${ip}`, 20, 60 * 60 * 1000)) {
      return c.json({ error: { code: "TOO_MANY_REQUESTS" } }, 429);
    }

    const ok = await confirmWaitlist(parsed.data.token);
    /* Unknown, used or expired all read the same — a used link clicked twice is the common case,
       and the marketing page words it gently. */
    return ok ? c.body(null, 204) : c.json({ error: { code: "INVALID_TOKEN" } }, 400);
  });
