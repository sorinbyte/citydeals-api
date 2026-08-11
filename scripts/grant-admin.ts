import { sql } from "drizzle-orm";

import { db } from "@/db/client";

/*
  Grants someone the platform_owner role, by email.

  Why this exists: Cloudflare Access and this table answer different questions, and BOTH have to say
  yes. Access authenticates — it decides a real person got through the door. `users` authorises — it
  decides that person is a platform owner. Getting past Access with an email that isn't in here is a
  403, which is exactly right, and also exactly how you lock yourself out of your own dashboard on
  the first deploy if nobody ran this.

  ⚠️ The email MUST be the one the identity provider hands to Access — the mailbox you actually
  click "sign in with" — not a role address or an alias that forwards. Access echoes the provider's
  spelling; a near-miss here is a 403 with nothing obviously wrong on either side.

  There's no password to set and never will be. This table holds role and status, nothing else.

  Usage:
    npm run admin:grant -- sorin@example.com "Sorin Dumitrașcu"

  Safe to re-run. It's also the one to re-run after `npm run db:seed` if you ever find the row gone —
  the seed only deletes its own placeholder admin by email, so a real grant survives, but that's a
  property worth re-checking rather than trusting.
*/

type ExistingUser = { id: string; email: string; name: string; role: string; status: string };

const [emailArg, nameArg] = process.argv.slice(2);

/* Deliberately loose. The real check is whether it matches what the identity provider sends, which
   nothing here can know — this only catches a missing argument or an obvious typo. */
if (!emailArg || !emailArg.includes("@") || /\s/.test(emailArg)) {
  console.error('Usage: npm run admin:grant -- <email> ["Full Name"]');
  console.error("The email must be the one your identity provider gives Cloudflare Access.");
  process.exit(1);
}

const email = emailArg.trim();

const existing = (
  await db.execute(sql`
    SELECT id, email, name, role, status FROM users WHERE lower(email) = lower(${email}) LIMIT 1
  `)
).rows[0] as ExistingUser | undefined;

if (!existing) {
  const name = nameArg?.trim() || email.split("@")[0] || email;

  /* partner_id stays null: a platform owner works for the platform, not a company, and the
     users_partner_matches_role CHECK enforces that. */
  const [created] = (
    await db.execute(sql`
      INSERT INTO users (email, name, role, status)
      VALUES (${email}, ${name}, 'platform_owner', 'active')
      RETURNING id, email, name
    `)
  ).rows as Array<{ id: string; email: string; name: string }>;

  console.log(`✓ granted platform_owner to ${created?.email} (${created?.name})`);
  console.log(`  id ${created?.id}`);
} else if (existing.role !== "platform_owner") {
  /*
    Refuses rather than promoting. A venue_owner is scoped to their own venues; quietly turning one
    into a platform owner because of a mistyped address would hand a restaurant every partner's
    numbers. If the promotion is genuinely intended, it's a deliberate UPDATE, not a CLI default.
  */
  console.error(`✗ ${existing.email} already exists as role '${existing.role}'.`);
  console.error("  Refusing to promote — do that deliberately if you really mean it.");
  process.exit(1);
} else if (existing.status !== "active") {
  await db.execute(sql`UPDATE users SET status = 'active' WHERE id = ${existing.id}`);
  console.log(`✓ reactivated ${existing.email} (was '${existing.status}')`);
} else {
  console.log(`· ${existing.email} is already an active platform_owner — nothing to do.`);
}

const owners = (
  await db.execute(sql`
    SELECT email, status FROM users WHERE role = 'platform_owner' ORDER BY email
  `)
).rows as Array<{ email: string; status: string }>;

console.log(`\nplatform owners (${owners.length}):`);
for (const o of owners) console.log(`  ${o.status === "active" ? "●" : "○"} ${o.email}`);

process.exit(0);
