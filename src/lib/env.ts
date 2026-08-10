import { z } from "zod";

/*
  Validated once at startup so a missing or malformed value is a loud crash on boot rather than a
  confusing 500 on the first request that happens to need it.
*/
const schema = z.object({
  DATABASE_URL: z.string().url(),
  /*
    Where venue photos live. Required, not optional — an API that serves relative paths dressed up
    as image URLs produces broken images in three clients and no error anywhere.

    In dev this is R2's public development URL (R2 → bucket → Settings → Public Development URL).
    In production it's the custom domain. Clients never hold this value: we compose the full URL
    here so changing the domain is one env var, not a mobile release users may never install.
  */
  ASSET_BASE_URL: z.string().url(),
  // 3001, not 3000 — Next.js takes 3000 and you'll often want the marketing site and the API
  // running at the same time. Colliding defaults is a papercut you'd hit every single day.
  PORT: z.coerce.number().int().positive().default(3001),

  /*
    ⚠️ STOPGAP, and the only thing standing in front of the admin write routes.

    Real auth isn't built (see AGENTS.md — it's still an open decision), but /v1/admin/* can
    create partners and edit leads, and this service currently runs behind `cors()` wide open. A
    shared secret is not authentication: it doesn't identify anyone, it can't be revoked per user
    and it says nothing about roles. What it does buy is that a browser can't call these routes —
    the value lives server-side in the admin app's proxy and never reaches a bundle.

    Delete this the day Cloudflare Access identity is verified here properly.
  */
  ADMIN_API_SECRET: z.string().min(32, "Use a long random value — this guards every admin write"),

  /*
    Who admin writes are attributed to until there's a real session.

    `partners.created_by_user_id` is NOT NULL because "which admin signed this company" is a
    question that gets asked during a dispute. With no auth there's nobody to ask, so the acting
    admin is named here and resolved server-side — NEVER taken from the request. A client-supplied
    user id would make the audit trail something the caller writes, which is worse than not having
    one.

    Must already exist in `users` as a platform_owner; the API refuses the write otherwise rather
    than inventing an account. In dev that's the seed admin, which also means partners you create
    through the UI are cleared by the next `db:seed` — they're dev data, and the seed owns them.
  */
  ADMIN_ACTING_EMAIL: z.string().email(),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
  throw new Error(`Invalid environment:\n${issues}\n\nSee .env.example.`);
}

export const env = parsed.data;
