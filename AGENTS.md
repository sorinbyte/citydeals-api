CLAUDE.md — Backend API (Hono + Postgres)

What this is

The backend for a paid membership discount platform for the Romanian market (Urban Point /
Neotaste style). Members pay a monthly/annual subscription and redeem discounts (1+1, % off,
free item) at partner venues — restaurants, spas, beauty, sport, entertainment — in person.
Multi-category from launch, dining-first, Bucharest-first.

**This service is the source of truth for the entire product.** Three clients talk to it:

- the mobile app (Expo / React Native) — members
- the platform admin dashboard — me
- the venue-owner dashboard — partners

They are all untrusted. Everything that matters is decided here.

Solo founder. No fixed deadline — favour correct and simple over fast and clever.

***
Related repos

This is **not** a monorepo. Three separate projects:

| Repo | What |
|---|---|
| `citydeals` | Expo mobile app — the member-facing product |
| `citydeals-api` | ← you are here |
| `citydeals-web` | Marketing site + both dashboards |

Changes here that alter a response shape break two other repos silently. See
**The cross-repo contract** below before changing any route's output.

***
Stack

	
Runtime	Node 22 (.nvmrc) — see the note below
Package manager	npm. The AGENTS.md used to say pnpm; it isn't what any of the three repos
	actually use, and unifying on the thing I know beats unifying on the thing that reads better.
Framework	Hono
Language	TypeScript, strict: true, noUncheckedIndexedAccess: true
Database	Postgres on Neon (Frankfurt, PG18), PostGIS enabled
DB layer	**Drizzle** + drizzle-kit. Decided — see below.
Driver	`pg` over TCP. Decided, and it constrains hosting — see below.
Validation	zod, at every trust boundary
Email	Resend (transactional only)
Lint/format	Biome

**DB layer — decided: Drizzle.** Picked over Kysely and plain SQL for `drizzle-kit generate`, which
writes the migration SQL from the schema instead of leaving it hand-maintained. Migrations are still
reviewed before they run — generated is not the same as trusted.

⚠️ **Two PostGIS gotchas, both already handled, both worth knowing before you touch the schema:**

1. **Drizzle has no `geography` type**, only `geometry`. That distinction is not cosmetic:
   `ST_DWithin` on geography takes **metres**, on geometry it takes **degrees**. A "2km" radius
   written against geometry silently means ~200km — the bug looks like "search returns everything"
   rather than an error. `src/db/types/geography.ts` is a hand-rolled `customType` for this. Use it;
   don't "simplify" it to `geometry`.
2. **drizzle-kit quotes any column type not on its hardcoded native-types allowlist**, and
   `geography` isn't on it — so generated SQL comes out as `"geography(Point, 4326)"`, which is
   invalid. `scripts/fix-geography-quoting.ts` unquotes it and runs automatically as part of
   `npm run db:generate`. Never run `drizzle-kit generate` bare, or you'll ship a migration that
   fails at deploy time.

⚠️ **Not decided yet — ask before picking:**
- **Auth implementation** — roll our own sessions vs. a library. Whatever it is, it must handle
  three role types and venue-scoped access (below).
- **Hosting / runtime target** — Cloudflare Workers vs. a Node container (Fly / Railway / Render).
  **Deferred deliberately, not forgotten.** Everything built so far is runtime-agnostic; `pg` over
  TCP is isolated in `src/db/client.ts` and that one file is what changes if we go to Workers.
  **The deadline is the redemption route** — Neon's HTTP driver cannot hold a transaction open
  across statements, and redemption needs `SELECT … FOR UPDATE` then `UPDATE` inside one
  transaction. Workers would force the WebSocket pool driver. Decide before writing that route.

**Node version:** `.nvmrc` says 22 because that's what's actually installed locally, and a `.nvmrc`
that disagrees with the dev machine means the deploy platform builds on a runtime nobody has tested
on. Bump all three repos to 24 together, deliberately, or leave them all on 22 — not one each.

Pinned versions live in package.json. Check there before reasoning about behaviour.

***
Hard rules

The client is always lying

Not "might be" — assume it is. Every value that arrives over HTTP is attacker-controlled: body,
query, headers, ids, prices, venue ids, timestamps, the lot.

- Validate every input with zod at the edge of the route. No `req.json()` straight into a query.
- Never accept a computed value the client could have computed itself — price, discount amount,
  eligibility, distance, expiry. Recompute or look it up.
- Authorization is checked on every request, per resource, server-side. There is no such thing as
  a trusted client-side check.

Redemption — treat as adversarial

Redemption fraud is the #1 operational risk of the whole business. This service is the only thing
standing between a member and infinite free meals.

- **We issue the code, we verify it, we mark it used.** Signed, single-use, short TTL. The mobile
  app displays it and does nothing else.
- Verification must be **atomic and idempotent** — a single-use code marked used inside the same
  transaction that validates it. Two scans arriving 50ms apart is a normal event at a busy counter,
  not an edge case. `SELECT … FOR UPDATE` or a unique constraint on the redemption row; never a
  read-then-write.
- Rate-limit issuance per member, per venue, per offer. Cooldowns are ours to enforce.
- Expiry is measured against **server time**, never a timestamp from the request.
- Log every redemption attempt with its outcome. When a partner disputes a bill, this log is the
  answer.

Money

- Integers in **bani** (RON minor units), always, plus an explicit currency code in the response.
- Never floats. Not in TypeScript, not in a Postgres column. `integer`/`bigint`, or `numeric` if
  something genuinely needs it — never `float`/`double precision`.
- All money arithmetic happens here. Clients display what we send; if a client needs a total, we
  send the total.

Geo / proximity

- PostGIS does the distance work — `geography` columns, `ST_DWithin`, GIST index. Not JS, not
  application-side filtering after a broad fetch.
- "Offers near me" takes coordinates and returns results already sorted and bounded. Clients never
  do distance math; there is no haversine anywhere in this product.
- Geocoding runs **once per venue at onboarding**, not at query time.

Phone verification (anti-fraud gate)

This gate is why the trial isn't infinitely farmable. It's enforced here or it isn't enforced.

- **+40 numbers only**, rejected server-side. Return an error code; the client owns the copy.
- Reject VOIP / virtual numbers — that's the actual attack, not typos.
- Rate-limit by phone number **and** by IP **and** by device where we can. Resend cooldown is
  dictated by us and returned in the response; clients must not run their own timer.
- Verification is bound to trial activation. A verified phone is single-use across accounts.

Roles and scoping

Three roles. Only two touch the web:

- `platform_owner` — me, later staff. Sees everything.
- `venue_owner` — scoped to a **list** of venue ids, never a single one. Restaurant groups with
  several locations are normal; retrofitting the list later is painful.
- `member` — mobile only. No web login exists for members at all.

**Venue scoping happens in the query, not after it.** Fetching a venue's stats and then checking
ownership is how you leak another partner's revenue through a timing difference or a forgotten
branch. The caller's venue ids go into the `WHERE` clause.

Time

- Store `timestamptz`, always UTC. Clients convert to Europe/Bucharest for display.
- Never trust a client timestamp for anything security-relevant. Expiry, cooldowns, and trial
  windows are measured against `now()` here.

i18n — the API returns codes, not sentences

- Error responses carry a stable machine-readable code (`PHONE_NOT_RO`, `CODE_EXPIRED`,
  `REDEMPTION_ALREADY_USED`). Clients own the human copy.
- Never return a user-facing Romanian string from a route. The moment we do, copy changes need a
  backend deploy and the mobile app can't fix its own wording over OTA.
- Codes are part of the contract — renaming one is a breaking change across three repos.

⚠️ Payments — DO NOT wire up IAP

The membership unlocks real-world services consumed in person. Under App Store Guideline 3.1.3(e)
that means payment happens **outside** IAP (Apple Pay / card via Stripe or Netopia), and Apple
actually requires non-IAP for physical/real-world goods. Getting this wrong costs 15–30% of revenue.

- Never build a flow where the membership grants something digital — in-app content, credits,
  vouchers, points. The redemption code is a verification token, not a purchased voucher. The
  moment something digital is unlocked, the exemption breaks.
- Flag any request that would do this rather than implementing it.

Secrets and config

- Real env vars, never committed. Nothing sensitive ever reaches a client — that's the entire
  reason this service exists.
- Every outbound hostname (asset base URL, dashboard URLs used in email links) comes from config.
  **The domain is not finalised** — see the mobile repo's `todolist.md`. No hardcoded hostnames.

***
The cross-repo contract

Three repos means the type-safety that would be free in a monorepo has to be built. This is the
main tax of the split and it needs deciding early.

⚠️ **Not decided yet.** The options:

1. **Publish a types-only package** from this repo (`@citydeals/api-types`) that the two clients
   depend on. Hono's RPC client (`hc<AppType>`) works this way and gives genuinely end-to-end types.
2. **Git dependency** — clients `npm install` this repo at a tag. Zero registry infrastructure, which
   suits a solo founder, but versioning is manual.
3. **OpenAPI + codegen** — publish a spec, clients generate their client. Most portable, most
   moving parts.

Until it's decided: **any change to a response shape is a breaking change to two other codebases
that will fail silently at runtime.** Treat route outputs as a published API even while everything
is pre-launch. Additive changes are safe; renames and removals are not.

***
Project conventions

- Folder layout: `src/routes/`, `src/db/`, `src/lib/`, `src/middleware/`, `src/services/`.
- Path alias `@/` → `src/`.
- Keep routes thin — validation and response shaping in the route, real logic in `src/services/`.
- IDs are UUIDv7, opaque to clients. Never let a client-supplied id skip an ownership check.
- Migrations are forward-only and reviewed. Never edit an applied migration.
- Every table that holds member or partner data gets a `created_at`/`updated_at` and, where it
  matters, an audit trail. Disputes are a real operational event.

Testing

**This is the repo where tests earn their keep** — the mobile app deliberately has few because the
logic isn't there, it's here.

Do write:
- Redemption: double-scan, expired code, wrong venue, already-used, concurrent verify.
- Authorization: a `venue_owner` cannot read or write another venue's anything. Test the negative.
- Phone verification: rate limits, VOIP rejection, resend cooldown, reuse across accounts.
- Money: bani arithmetic, rounding at boundaries.
- Pure helpers and mappers.

Do NOT write: tests that assert a mock was called, tests for Hono's own routing behaviour.

Before saying a task is done: `npm run typecheck` and `npm run lint` always. If typecheck is red,
the task isn't done.

***
Code comments — write them like a human wrote them for themselves

Comment the code so a real person skimming it later understands what each section is doing and why.
Casual, plain-spoken, explaining the intent or the gotcha — not narrating the obvious.

The voice I want:

```ts
// mark it used inside the same tx that validates it — two scans 50ms apart is normal at a busy counter
const used = await tx.update(redemptions).set({ usedAt: now }).where(...).returning();

// venue ids go in the WHERE, not a check after the fetch. one forgotten branch = partner sees
// another partner's revenue
.where(inArray(venues.id, session.venueIds))

// PostGIS does the distance. we never ship coordinates math to a client
ST_DWithin(v.location, ST_MakePoint($1, $2)::geography, $3)

// VOIP numbers are the actual attack here, typos are just noise
if (await isVirtualNumber(phone)) return err('PHONE_VOIP_REJECTED');
```

NOT this — textbook narrator voice, restating what the code already says:

```ts
// This function updates the redemption record.   <-- no. obvious.
// Check if the user is authorized.               <-- no. says nothing the code doesn't.
```

Rules of thumb: explain the why and the gotcha, skip the what when the code already says it. A short
note above a tricky block beats a comment on every line. Flag anything non-obvious or
"don't touch this / here's why" for future-me. Don't comment self-explanatory lines just to have a
comment there.

***
Workflow

- Conventional commits. Branches `feat/…`, `fix/…`, `chore/…`. Squash merge.
- Small, reviewable changes. Explain non-obvious decisions in the PR, not in code comments.
- When unsure about a Hono / Postgres / PostGIS API: read the docs or ask. Don't invent an API to
  avoid a search.

Never

- Trust a client value, or check authorization anywhere but server-side per request.
- Return a user-facing Romanian string instead of an error code.
- Do money as floats, or let a client compute an amount.
- Write distance math in application code.
- Let a `venue_owner` query run unscoped.
- Wire up IAP, or let the membership unlock anything digital.
- Change a response shape without remembering two other repos consume it.
- Use `any` — use `unknown` and narrow.
- Disable a lint rule inline to make something pass.
- Edit an already-applied migration.

Context worth carrying

- ~90% of users never pay. Keep infrastructure cost boring and predictable.
- Single-country app. One region close to Romania + a CDN is correct — no edge/distributed anything.
- The competitor (Bonapp Club) is a food-waste app with a bolted-on discount tab. Our edge is a
  focused, premium, multi-category, dining-first product.
- The critical moment in the whole product is a member at a counter on bad wifi with a waiter
  waiting. Every latency and reliability decision here should be judged against that moment.
