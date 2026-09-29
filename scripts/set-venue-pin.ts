import { sql } from "drizzle-orm";

import { db } from "@/db/client";
import { setVenuePin } from "@/services/venue-pin";

/*
  Sets or rotates a venue's 4-digit redemption PIN, by slug.

  Why this exists as a script: the partner dashboard has no screen for it yet, and the seeded venues
  all have `pin_hash` NULL — which means none of them can confirm a redemption at all. Without this
  there is no way to exercise the flow end to end.

  ⚠️ It is also the right long-term shape for the platform-owner side of it. Making a venue able to
  take money off a bill is not something that should be one careless click away in a dashboard, the
  same reasoning that keeps grant-admin.ts out of the admin UI.

  ⚠️ There is no way to READ a PIN back, here or anywhere. It's stored as a scrypt hash, so a
  forgotten one is rotated, not recovered. That's the right trade for a code written on a card by
  the till — but it does mean whoever runs this has to tell the venue what it is.

  Usage:
    npm run venue:pin -- italian-trattoria 4821

  Safe to re-run: rotating clears any lockout and invalidates nothing else. Devices already enrolled
  KEEP working, because they hold their own token rather than the PIN — if the reason you're
  rotating is that the PIN leaked, revoke those too.
*/

type VenueRow = { id: string; name: string; pin_set_at: string | null };

const [slugArg, pinArg] = process.argv.slice(2);

if (!slugArg || !pinArg) {
  console.error("Usage: npm run venue:pin -- <venue-slug> <4-digit-pin>");
  process.exit(1);
}

const slug = slugArg.trim();
const pin = pinArg.trim();

/* Four digits exactly. The redeem page's input is numeric and fixed-length, so anything else would
   be a PIN nobody could ever type in. */
if (!/^\d{4}$/.test(pin)) {
  console.error(`"${pin}" is not a 4-digit PIN.`);
  process.exit(1);
}

/*
  ⚠️ Rejecting the obvious ones. A 4-digit space is small enough that the handful of PINs everybody
  reaches for first are a meaningful fraction of it — "1234" and "0000" alone would be most of what
  an attacker tries before anything else. The lockout would stop them eventually; not handing them
  the answer on guess one is cheaper.
*/
const WEAK = new Set([
  "0000",
  "1111",
  "2222",
  "3333",
  "4444",
  "5555",
  "6666",
  "7777",
  "8888",
  "9999",
  "1234",
  "4321",
  "1122",
  "2580",
]);
if (WEAK.has(pin)) {
  console.error(`"${pin}" is one of the first PINs anyone guesses. Pick another.`);
  process.exit(1);
}

const venue = (
  await db.execute(sql`
    SELECT id, name, to_json(pin_set_at)#>>'{}' AS pin_set_at
    FROM venues WHERE slug = ${slug} LIMIT 1
  `)
).rows[0] as VenueRow | undefined;

if (!venue) {
  console.error(`No venue with slug "${slug}".`);
  process.exit(1);
}

const rotating = venue.pin_set_at !== null;
const ok = await setVenuePin(venue.id, pin);

if (!ok) {
  console.error(`Failed to set the PIN for "${venue.name}".`);
  process.exit(1);
}

console.log(`${rotating ? "Rotated" : "Set"} the PIN for ${venue.name} (${slug}).`);
if (rotating) {
  console.log("Devices already enrolled keep working — revoke them too if the old PIN leaked.");
}

process.exit(0);
