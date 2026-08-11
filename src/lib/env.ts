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

  /*
    R2 write credentials.

    These used to be read only by scripts/upload-assets.ts through its own requireEnv, because
    uploading was an offline chore. The admin dashboard uploads venue photos now, so they're part of
    the running service and belong in the same validated block as everything else — a missing key
    should stop the process at boot, not surface as a failed upload the first time someone drags a
    photo in.

    ⚠️ WRITE credentials. Server-side only, never NEXT_PUBLIC_/EXPO_PUBLIC_ — those are inlined into
    client bundles at build time, and a write key in a bundle is a public write key. ASSET_BASE_URL
    above is the only R2 value that belongs in a client, and it's read-only.
  */
  R2_ACCOUNT_ID: z.string().min(1),
  R2_ACCESS_KEY_ID: z.string().min(1),
  R2_SECRET_ACCESS_KEY: z.string().min(1),
  R2_BUCKET: z.string().min(1),
  // 3001, not 3000 — Next.js takes 3000 and you'll often want the marketing site and the API
  // running at the same time. Colliding defaults is a papercut you'd hit every single day.
  PORT: z.coerce.number().int().positive().default(3001),

  /*
    Browser origins allowed to call this API cross-origin. Comma-separated, exact origins
    (scheme + host + port), no trailing slash, no wildcards.

    Env-driven with no default because the domain isn't decided (AGENTS.md) — a hostname written
    into this file is a grep across three repos the day it changes.

    ⚠️ This is a browser rule, NOT a security boundary. CORS stops another site's JavaScript from
    reading our responses in a visitor's browser. It does nothing about curl, a script, or the
    mobile app, and it is not what protects /v1/admin — that's the two doors in routes/admin.ts.
    Never reason about this as if it kept anyone out.

    The whole cross-origin surface is one route: POST /v1/partner-leads, submitted from the
    marketing site's browser. Every other call the web apps make is server-side and carries no
    Origin at all, which is why leaving this unset breaks exactly one form and nothing else.
  */
  CORS_ALLOWED_ORIGINS: z.string().optional(),

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

  /*
    Cloudflare Access — who is actually calling.

    ⚠️ These are what turn /v1/admin from "reachable by our server" into "reachable by a named
    person". ADMIN_API_SECRET proves the request came from the admin app's proxy; this proves a
    human got past Access first. Different questions, both worth answering.

    CF_ACCESS_TEAM_DOMAIN is either "myteam" or "myteam.cloudflareaccess.com" — both are what people
    copy out of the dashboard, and access.ts normalises it.

    CF_ACCESS_AUD is the Access application's AUD tag. It's per-application, and checking it is what
    stops a token minted for a DIFFERENT app on the same team domain opening this one.
  */
  CF_ACCESS_TEAM_DOMAIN: z.string().min(1).optional(),
  CF_ACCESS_AUD: z.string().min(1).optional(),

  /*
    ⚠️ THE ONLY WAY TO RUN /v1/admin WITHOUT IDENTITY, and it has to be asked for out loud.

    Access doesn't exist on localhost — there's no edge in front of `localhost:3002` to mint a token
    — so local development needs a way through. The tempting shape is "if the Access vars are
    missing, skip the check", and that's a trap: one forgotten variable in a deployed environment
    would silently turn authentication off, with nothing in the logs and nothing to notice.

    So it's an explicit opt-in instead, the same posture as ALLOW_SEED, and for the same reason
    written out there: the process refuses to start rather than quietly doing the unsafe thing.
  */
  ALLOW_INSECURE_ADMIN: z.literal("yes").optional(),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
  throw new Error(`Invalid environment:\n${issues}\n\nSee .env.example.`);
}

/*
  Admin identity is configured, or the process refuses to start.

  ⚠️ The failure this prevents: deploying with CF_ACCESS_AUD unset and never noticing, because
  everything keeps working — the admin dashboard would just be authenticated by nothing but a shared
  secret that lives in an env var. There is no log line loud enough to catch that; the only reliable
  signal is not booting.

  Both variables or neither. One without the other is a half-configured verifier, which would either
  reject every token or check the wrong thing.
*/
const accessConfigured =
  parsed.data.CF_ACCESS_TEAM_DOMAIN !== undefined && parsed.data.CF_ACCESS_AUD !== undefined;
const partiallyConfigured =
  !accessConfigured &&
  (parsed.data.CF_ACCESS_TEAM_DOMAIN !== undefined || parsed.data.CF_ACCESS_AUD !== undefined);

if (partiallyConfigured) {
  throw new Error(
    "Invalid environment: CF_ACCESS_TEAM_DOMAIN and CF_ACCESS_AUD must be set together. " +
      "One without the other is a verifier that can't verify anything.",
  );
}

if (!accessConfigured && parsed.data.ALLOW_INSECURE_ADMIN !== "yes") {
  throw new Error(
    "Refusing to start: /v1/admin has no identity check.\n\n" +
      "Set CF_ACCESS_TEAM_DOMAIN and CF_ACCESS_AUD (from Zero Trust → Access → your application), " +
      "or set ALLOW_INSECURE_ADMIN=yes for local development where Cloudflare Access can't reach.\n\n" +
      "Never set ALLOW_INSECURE_ADMIN in a deployed environment — it leaves every admin write behind " +
      "a shared secret and nothing else.",
  );
}

export const env = parsed.data;

/*
  Whether /v1/admin can identify its caller. False only on a localhost run that opted in above.

  Exported rather than recomputed at the route, so there's exactly one definition of "is this
  secured" and the boot check and the middleware can't drift apart.
*/
export const adminIdentityEnabled = accessConfigured;

/*
  The CORS allowlist, parsed once.

  Trailing slashes are stripped because an Origin header never has one — "https://x.ro/" in the env
  var would silently match nothing, and the symptom (one form failing in the browser, everything
  else fine) points nowhere near this file.
*/
export const corsAllowedOrigins = new Set(
  (parsed.data.CORS_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim().replace(/\/+$/, ""))
    .filter(Boolean),
);
