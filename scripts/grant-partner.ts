import { sql } from "drizzle-orm";

import { db } from "@/db/client";

/*
  Creates a venue_owner and grants them venues, by email.

  The partner counterpart to admin:grant, and it exists for the same reason: venue owners never
  self-register (AGENTS.md), so SOMETHING has to make the first one. Eventually that's the admin
  dashboard's invite flow; until that's built, it's this.

  ⚠️ Two rows, not one. `users` says who they are and which company they work for; `user_venues`
  says which locations they may act on. Skipping the second gives you an account that signs in fine
  and sees nothing — which is a real state (an owner invited before their venue exists), so nothing
  will look broken.

  Usage:
    npm run partner:grant -- <email> "Full Name" <partner-cui>      # grants ALL that partner's venues
    npm run partner:grant -- <email> "Full Name" <partner-cui> <venue-slug> [venue-slug...]

  Find a CUI with:  npm run db:studio  — or the Parteneri page in admin.

  Safe to re-run: grants are upserted, so adding a venue later is the same command again.

  ⚠️ An email can only be ONE of these things. `users_email_lower_key` is unique on lower(email) and
  the users_partner_matches_role CHECK forbids a platform_owner from having a partner_id — so your
  own admin address cannot also be a partner. Use plus-addressing for a test account:
  you+partener@gmail.com is a different string to Postgres and the same inbox to Gmail.
*/

type ExistingUser = { id: string; email: string; name: string; role: string; status: string };
type PartnerRow = { id: string; company_name: string };
type VenueRow = { id: string; name: string; slug: string };

const [emailArg, nameArg, cuiArg, ...venueSlugs] = process.argv.slice(2);

function usage(message: string): never {
  console.error(`✗ ${message}\n`);
  console.error(
    'Usage: npm run partner:grant -- <email> "Full Name" <partner-cui> [venue-slug...]',
  );
  console.error("With no venue slugs, every venue belonging to that partner is granted.");
  process.exit(1);
}

/* Deliberately loose — this only catches a missing argument or an obvious typo. */
if (!emailArg || !emailArg.includes("@") || /\s/.test(emailArg))
  usage("Missing or malformed email");
if (!cuiArg) usage("Missing partner CUI — a venue_owner must belong to a company");

const email = emailArg.trim();
/* Digits only, same normalisation the admin form does. The same company writes its CUI three ways
   across a contract, an email and a CLI argument. */
const cui = cuiArg.replace(/^\s*ro/i, "").replace(/\D/g, "");

const partner = (
  await db.execute(sql`SELECT id, company_name FROM partners WHERE cui = ${cui} LIMIT 1`)
).rows[0] as PartnerRow | undefined;

if (!partner) {
  console.error(`✗ No partner with CUI ${cui}.`);
  const all = (
    await db.execute(sql`SELECT cui, company_name FROM partners ORDER BY company_name LIMIT 20`)
  ).rows as Array<{ cui: string; company_name: string }>;
  console.error("\nPartners that do exist:");
  for (const p of all) console.error(`  ${p.cui}  ${p.company_name}`);
  process.exit(1);
}

/*
  Which venues to grant. No slugs means all of this partner's — the common case, since a company
  that owns three locations normally has one person who runs all three.
*/
const venues = (
  venueSlugs.length > 0
    ? await db.execute(sql`
        SELECT id, name, slug FROM venues
        WHERE partner_id = ${partner.id} AND slug = ANY(${venueSlugs})
        ORDER BY name
      `)
    : await db.execute(sql`
        SELECT id, name, slug FROM venues WHERE partner_id = ${partner.id} ORDER BY name
      `)
).rows as VenueRow[];

/* Named slugs that matched nothing are almost always a typo, and silently granting the rest would
   hide it until someone wondered where a location went. */
if (venueSlugs.length > 0 && venues.length !== venueSlugs.length) {
  const found = new Set(venues.map((v) => v.slug));
  const missing = venueSlugs.filter((slug) => !found.has(slug));
  console.error(`✗ Not venues of ${partner.company_name}: ${missing.join(", ")}`);
  process.exit(1);
}

const existing = (
  await db.execute(sql`
    SELECT id, email, name, role, status FROM users WHERE lower(email) = lower(${email}) LIMIT 1
  `)
).rows[0] as ExistingUser | undefined;

let userId: string;

if (!existing) {
  const name = nameArg?.trim() || email.split("@")[0] || email;

  const [created] = (
    await db.execute(sql`
      INSERT INTO users (email, name, role, status, partner_id, invited_at, invite_expires_at)
      VALUES (${email}, ${name}, 'venue_owner', 'active', ${partner.id},
              now(), now() + interval '7 days')
      RETURNING id, email, name
    `)
  ).rows as Array<{ id: string; email: string; name: string }>;

  if (!created) throw new Error("insert returned no row");
  userId = created.id;
  console.log(
    `✓ created venue_owner ${created.email} (${created.name}) at ${partner.company_name}`,
  );
} else if (existing.role !== "venue_owner") {
  /*
    Refuses rather than converting. Demoting a platform_owner would take away admin access, and the
    CHECK constraint would reject it anyway — but the error you'd get is about a constraint rather
    than about what you actually did wrong.
  */
  console.error(`✗ ${existing.email} already exists as role '${existing.role}'.`);
  console.error("  An email can only be one of these. Use plus-addressing for a test account:");
  console.error(`  ${email.replace("@", "+partener@")}`);
  process.exit(1);
} else {
  userId = existing.id;
  if (existing.status !== "active") {
    await db.execute(sql`UPDATE users SET status = 'active' WHERE id = ${userId}`);
    console.log(`✓ reactivated ${existing.email} (was '${existing.status}')`);
  } else {
    console.log(`· ${existing.email} already a venue_owner — updating grants only`);
  }
}

/* ON CONFLICT so re-running is a no-op rather than a primary-key error. */
for (const venue of venues) {
  await db.execute(sql`
    INSERT INTO user_venues (user_id, venue_id) VALUES (${userId}, ${venue.id})
    ON CONFLICT (user_id, venue_id) DO NOTHING
  `);
}

const granted = (
  await db.execute(sql`
    SELECT v.name, v.slug FROM user_venues uv
    JOIN venues v ON v.id = uv.venue_id
    WHERE uv.user_id = ${userId}
    ORDER BY v.name
  `)
).rows as Array<{ name: string; slug: string }>;

console.log(`\n${email} can act on ${granted.length} venue(s):`);
for (const v of granted) console.log(`  · ${v.name} (${v.slug})`);

console.log("\nSign in: open the partner app, enter that email, then read the link");
console.log("from the API console (needs LOGIN_LINK_TO_CONSOLE=yes and PARTNER_BASE_URL).");

process.exit(0);
