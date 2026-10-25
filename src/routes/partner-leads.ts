import { Hono } from "hono";
import { z } from "zod";

import { partnerLeadEmail, sendEmail } from "@/lib/email";
import { leadNotifyEmails } from "@/lib/env";
import { allowRequest, clientIp } from "@/lib/rate-limit";
import { createLead } from "@/services/partners";

/*
  The /parteneri contact form. Public, unauthenticated, called from the marketing site's browser —
  so it's on the CORS allowlist alongside POST /waitlist.

  A lead, not a signup: it creates no account and grants nothing. It lands in admin → Lead-uri and
  gets mailed to LEAD_NOTIFY_EMAILS; converting it is still a human creating a partner by hand.
*/

const body = z.object({
  name: z.string().trim().min(1).max(120),
  venueName: z.string().trim().min(1).max(120),
  /* A taxonomy key or "altceva". Plain text on purpose, same as the column — see schema/partners.ts */
  category: z.string().trim().min(1).max(60),
  phone: z.string().trim().min(6).max(30),
  /* zod v3 in this repo, so .string().email() */
  email: z.string().trim().toLowerCase().email().max(320),
  message: z.string().trim().max(2000).optional(),
  // honeypot. The form already swallows a filled one; this is for anything posting directly
  website: z.string().optional(),
});

export const partnerLeadsRoute = new Hono().post("/", async (c) => {
  const parsed = body.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: { code: "INVALID_REQUEST" } }, 400);

  const { website, name, message, ...rest } = parsed.data;
  // a bot: same answer as a real submission, nothing stored, nobody mailed
  if (website) return c.body(null, 204);

  const ip = clientIp(c.req.header("x-forwarded-for"));
  const withinEmailLimit = allowRequest(`lead:email:${rest.email}`, 3, 60 * 60 * 1000);
  const withinIpLimit = ip ? allowRequest(`lead:ip:${ip}`, 5, 60 * 60 * 1000) : true;
  if (!withinEmailLimit || !withinIpLimit) {
    return c.json({ error: { code: "TOO_MANY_REQUESTS" } }, 429);
  }

  const lead = await createLead({ ...rest, contactName: name, message: message || null });

  /*
    Saved first, mailed second, and the mail isn't awaited. A Resend hiccup must not turn into
    "the form failed" for someone who's now in the database — admin still shows them either way.
  */
  if (leadNotifyEmails.length > 0) {
    void sendEmail(leadNotifyEmails, partnerLeadEmail(lead), { replyTo: lead.email });
  } else {
    console.warn(`partner lead ${lead.id} saved, nobody mailed (LEAD_NOTIFY_EMAILS unset)`);
  }

  return c.body(null, 201);
});
