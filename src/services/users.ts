import { sql } from "drizzle-orm";

import { db } from "@/db/client";

/*
  Looking up who's allowed to use the admin dashboard.

  ⚠️ This is the authorisation half, and it is deliberately separate from authentication. Cloudflare
  Access answers "is this a real person we let through the door"; this answers "is that person a
  platform owner". Conflating them means an Access policy widened by accident — or an identity
  provider that starts handing us a whole Google Workspace — becomes an admin grant.

  `users` has no credentials and never will: no password hash, no tokens. Identity comes from
  Access, and this table only records role and status.
*/

export type PlatformOwner = { id: string; email: string; name: string };

/*
  The active platform_owner with this email, or null.

  Both conditions matter. `role` is the grant; `status` is how a grant gets taken away without
  deleting the row, which has to stay for the audit trail — `partners.created_by_user_id` is NOT
  NULL and ON DELETE RESTRICT precisely so "who signed this company" survives someone leaving.

  Compared lowercased on both sides. Access echoes whatever the identity provider sent, and an email
  that differs only in case is the same mailbox.
*/
export async function findPlatformOwnerByEmail(email: string): Promise<PlatformOwner | null> {
  const result = await db.execute(sql`
    SELECT id, email, name
    FROM users
    WHERE lower(email) = lower(${email})
      AND role = 'platform_owner'
      AND status = 'active'
    LIMIT 1
  `);

  return (result.rows[0] as PlatformOwner | undefined) ?? null;
}
