import { desc, sql } from "drizzle-orm";

import { db } from "@/db/client";
import { waitlistSignups } from "@/db/schema";
import { generateToken, hashToken } from "@/lib/tokens";

/* How long a confirmation link works. Long enough to find the email tomorrow morning. */
const CONFIRM_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/*
  Adds an address, or refreshes an unconfirmed one, and returns the confirmation token to email —
  or null when there's nothing to send because the address is already confirmed.

  ⚠️ The route answers the same way in every case. Whether an address is already on the list is
  nobody's business but its owner's, and "you're already subscribed" would hand that out to anyone
  who types a stranger's email.
*/
export async function joinWaitlist(
  email: string,
  source: string,
): Promise<{ token: string } | null> {
  const token = generateToken();
  const now = new Date();
  const expires = new Date(now.getTime() + CONFIRM_TTL_MS);

  const [row] = await db
    .insert(waitlistSignups)
    .values({
      email,
      source,
      consentedAt: now,
      confirmTokenHash: hashToken(token),
      confirmTokenExpiresAt: expires,
    })
    /*
      Already there: refresh consent and issue a fresh link — but only while unconfirmed. A
      confirmed row is left exactly as it is (the WHERE makes the update a no-op, and RETURNING
      then gives back nothing), so a second signup can't quietly un-confirm anyone.
    */
    .onConflictDoUpdate({
      target: waitlistSignups.email,
      set: {
        consentedAt: now,
        confirmTokenHash: hashToken(token),
        confirmTokenExpiresAt: expires,
        updatedAt: now,
      },
      setWhere: sql`${waitlistSignups.confirmedAt} IS NULL`,
    })
    .returning({ id: waitlistSignups.id });

  return row ? { token } : null;
}

/*
  Spends a confirmation token. True when it confirmed someone, false for an unknown, used or
  expired token — the route doesn't distinguish those to the caller, there's nothing they'd do
  differently.
*/
export async function confirmWaitlist(token: string): Promise<boolean> {
  const now = new Date();
  const [row] = await db
    .update(waitlistSignups)
    .set({ confirmedAt: now, confirmTokenHash: null, confirmTokenExpiresAt: null, updatedAt: now })
    .where(
      sql`${waitlistSignups.confirmTokenHash} = ${hashToken(token)}
          AND ${waitlistSignups.confirmTokenExpiresAt} > ${now}`,
    )
    .returning({ id: waitlistSignups.id });

  return Boolean(row);
}

export type WaitlistEntry = {
  id: string;
  email: string;
  source: string;
  createdAt: string;
  confirmedAt: string | null;
};

/* For admin: everyone, newest first, plus the two numbers that matter. */
export async function listWaitlist(): Promise<{
  items: WaitlistEntry[];
  total: number;
  confirmed: number;
}> {
  const rows = await db
    .select({
      id: waitlistSignups.id,
      email: waitlistSignups.email,
      source: waitlistSignups.source,
      createdAt: waitlistSignups.createdAt,
      confirmedAt: waitlistSignups.confirmedAt,
    })
    .from(waitlistSignups)
    .orderBy(desc(waitlistSignups.createdAt));

  const items = rows.map((r) => ({
    id: r.id,
    email: r.email,
    source: r.source,
    createdAt: r.createdAt.toISOString(),
    confirmedAt: r.confirmedAt ? r.confirmedAt.toISOString() : null,
  }));

  return {
    items,
    total: items.length,
    confirmed: items.filter((i) => i.confirmedAt !== null).length,
  };
}
