import { sql } from "drizzle-orm";

import { db } from "@/db/client";
import { type IssuedToken, issueTokenForUser } from "@/services/auth";

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

/*
  Creating a venue_owner and inviting them.

  This is the HTTP half of what scripts/grant-partner.ts does at the command line, and it exists
  because the CLI can't be part of onboarding a real partner — admin needs to do it, and the invite
  has to go out by mail rather than being read off a terminal.

  ⚠️ Venue owners never self-register. There is no public signup anywhere, by design (AGENTS.md), so
  this and the CLI are the only two ways an account comes into existence.
*/

export type PartnerUser = { id: string; email: string; name: string };

export type CreatePartnerUserInput = {
  partnerId: string;
  email: string;
  name: string;
  venueIds: string[];
};

/* Distinct codes because the remedy differs, and admin is a UI with one user who deserves to be
   told which mistake they made rather than "invalid". */
export type CreatePartnerUserFailure =
  | "PARTNER_NOT_FOUND"
  | "EMAIL_IS_PLATFORM_OWNER"
  | "EMAIL_TAKEN"
  | "VENUE_NOT_OWNED";

export type CreatePartnerUserResult =
  | { ok: true; user: PartnerUser; companyName: string; invite: IssuedToken }
  | { ok: false; reason: CreatePartnerUserFailure };

export async function createPartnerUser(
  input: CreatePartnerUserInput,
): Promise<CreatePartnerUserResult> {
  /*
    User row and venue grants go in one transaction — a user created without their venues is an
    owner who signs in successfully and sees an empty dashboard, which reads as our bug and costs a
    support conversation.

    The invite token is minted AFTER this commits, on purpose: issueTokenForUser runs on the pooled
    `db` handle rather than this `tx`, and enlisting it here would either deadlock or quietly write
    outside the transaction. The worst case of splitting them is an account with no invite yet, and
    resendPartnerInvite below is exactly the recovery for that.
  */
  const created = await db.transaction(async (tx) => {
    const partner = (
      await tx.execute(sql`
        SELECT id, company_name FROM partners WHERE id = ${input.partnerId} LIMIT 1
      `)
    ).rows[0] as { id: string; company_name: string } | undefined;

    if (!partner) return { ok: false as const, reason: "PARTNER_NOT_FOUND" as const };

    /*
      An email can be a platform_owner OR a venue_owner, never both — users_email_lower_key is
      unique on lower(email) and the users_partner_matches_role CHECK forbids a platform owner from
      carrying a partner_id.

      Refused rather than converted, same as the CLI: demoting yourself out of admin by filling in a
      form is not a thing that should be possible, and the constraint would reject it anyway with an
      error about a constraint instead of about what you did.
    */
    const existing = (
      await tx.execute(sql`
        SELECT id, role FROM users WHERE lower(email) = lower(${input.email}) LIMIT 1
      `)
    ).rows[0] as { id: string; role: string } | undefined;

    if (existing) {
      return {
        ok: false as const,
        reason:
          existing.role === "platform_owner"
            ? ("EMAIL_IS_PLATFORM_OWNER" as const)
            : ("EMAIL_TAKEN" as const),
      };
    }

    /*
      ⚠️ Every venue must belong to the partner we're attaching this person to. Nothing else checks
      it — user_venues has no opinion about which company a venue belongs to, so without this a
      typo in admin hands one restaurant's dashboard to a different company's owner. The CLI never
      needed this because a human read the venue names back off the terminal first.

      sql.param + an explicit cast: an inlined array becomes `ANY(($1, $2))`, which Postgres reads
      as a record and refuses to compare against uuid. Same reasoning as services/venues.ts:809.
    */
    if (input.venueIds.length > 0) {
      const owned = (
        await tx.execute(sql`
          SELECT count(*)::int AS count
          FROM venues
          WHERE id = ANY(${sql.param(input.venueIds)}::uuid[])
            AND partner_id = ${input.partnerId}
        `)
      ).rows[0] as { count: number } | undefined;

      /* Compared against a de-duplicated list — the same id sent twice would otherwise fail this
         check for looking like one venue too few. */
      if ((owned?.count ?? 0) !== new Set(input.venueIds).size) {
        return { ok: false as const, reason: "VENUE_NOT_OWNED" as const };
      }
    }

    const user = (
      await tx.execute(sql`
        INSERT INTO users (email, name, role, status, partner_id, invited_at, invite_expires_at)
        VALUES (${input.email}, ${input.name}, 'venue_owner', 'active', ${input.partnerId},
                now(), now() + interval '7 days')
        RETURNING id, email, name
      `)
    ).rows[0] as PartnerUser | undefined;

    if (!user) throw new Error("insert returned no user row");

    /* ON CONFLICT so a retried request is a no-op rather than a primary-key error. */
    for (const venueId of input.venueIds) {
      await tx.execute(sql`
        INSERT INTO user_venues (user_id, venue_id) VALUES (${user.id}, ${venueId})
        ON CONFLICT (user_id, venue_id) DO NOTHING
      `);
    }

    return { ok: true as const, user, companyName: partner.company_name };
  });

  if (!created.ok) return created;

  const invite = await issueTokenForUser(created.user.id, "invite");
  return { ok: true, user: created.user, companyName: created.companyName, invite };
}

export type ResendInviteResult =
  | { ok: true; user: PartnerUser; companyName: string; invite: IssuedToken }
  | { ok: false; reason: "USER_NOT_FOUND" | "ALREADY_ACCEPTED" };

/*
  Mints a fresh invite for someone who never used theirs.

  Invites last seven days and the first one gets lost — filtered, deleted, or sent to the address
  the restaurant checks once a month. Without this the only recovery is the CLI, which is the thing
  we're getting rid of.

  ⚠️ Refuses once the invite has been accepted. That person has an account and should use the normal
  sign-in link; re-inviting them would work, but it's a different flow with different copy, and
  quietly treating "resend invite" as "send login link" is how the two stop meaning anything.
*/
export async function resendPartnerInvite(userId: string): Promise<ResendInviteResult> {
  const row = (
    await db.execute(sql`
      SELECT u.id, u.email, u.name, u.invite_accepted_at, p.company_name
      FROM users u
      JOIN partners p ON p.id = u.partner_id
      WHERE u.id = ${userId} AND u.role = 'venue_owner' AND u.status = 'active'
      LIMIT 1
    `)
  ).rows[0] as
    | { id: string; email: string; name: string; invite_accepted_at: unknown; company_name: string }
    | undefined;

  if (!row) return { ok: false, reason: "USER_NOT_FOUND" };
  if (row.invite_accepted_at !== null) return { ok: false, reason: "ALREADY_ACCEPTED" };

  await db.execute(sql`
    UPDATE users SET invite_expires_at = now() + interval '7 days', updated_at = now()
    WHERE id = ${userId}
  `);

  const invite = await issueTokenForUser(userId, "invite");
  return {
    ok: true,
    user: { id: row.id, email: row.email, name: row.name },
    companyName: row.company_name,
    invite,
  };
}
