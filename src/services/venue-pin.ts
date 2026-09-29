import {
  type ScryptOptions,
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
} from "node:crypto";
import { promisify } from "node:util";

import { sql } from "drizzle-orm";

import { db } from "@/db/client";
import { toDate } from "@/lib/rows";
import { generateToken, hashToken } from "@/lib/tokens";

/* promisify picks the 3-argument overload, which drops the options object we need for the cost
   parameters — so the promisified shape is spelled out here rather than inferred. */
const scrypt = promisify(scryptCallback) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: ScryptOptions,
) => Promise<Buffer>;

/*
  The venue's 4-digit PIN, and the staff devices that have proved they know it.

  ⚠️ Read this before changing anything here. Four digits is TEN THOUSAND possibilities — the entire
  keyspace fits in a text file — so unlike every other secret in this codebase it is genuinely
  guessable, and no single measure below is sufficient on its own. Three layers hold it up:

    1. scrypt, so each guess costs real CPU rather than a hash nobody notices.
    2. A per-IP limit at the route, so one attacker can't parallelise cheaply.
    3. A per-venue lockout here, so the whole keyspace can't be walked slowly from many addresses.

  And the reason (3) is survivable at all is venue_devices: a lockout would otherwise be a denial of
  service anyone could trigger against a working restaurant, but the phones already behind the bar
  skip the PIN entirely and keep confirming right through it. Removing devices means rethinking the
  lockout. They are one design, not two features.
*/

/*
  N=16384, r=8, p=1 — roughly 100ms and 16MB per guess on the hardware this runs on.

  The whole keyspace is therefore about seventeen minutes of one core, which is NOT a defence by
  itself; it's what makes the lockout below meaningful instead of something an attacker outruns.

  Stored alongside the hash rather than read from here at verify time, so raising the cost later
  doesn't invalidate every PIN already set.
*/
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LENGTH = 32;

/* Twenty wrong guesses buys a fifteen-minute pause. Generous on purpose — staff DO fat-finger it,
   and the cost of locking a real counter out is higher than the cost of twenty free guesses. */
const MAX_PIN_FAILURES = 20;
const LOCKOUT_MINUTES = 15;

/* Six months, matching the member session. A phone behind a bar is not re-enrolled often, and the
   answer to one that walks off is revoking it, not waiting for it to lapse. */
const DEVICE_TTL_DAYS = 180;

/* ------------------------------------------------------------------------------------------- */

async function derive(pin: string, salt: Buffer, n: number, r: number, p: number): Promise<Buffer> {
  /* ⚠️ maxmem has to be raised explicitly — node's default is 32MB and refuses anything above it,
     which turns a cost increase into a runtime throw rather than a slower hash. */
  return scrypt(pin, salt, KEY_LENGTH, { N: n, r, p, maxmem: 256 * 1024 * 1024 });
}

/* `scrypt$N$r$p$salt$hash`, all hex. Self-describing so the parameters can change without a
   migration or a forced reset — the row carries the cost it was made with. */
function encode(n: number, r: number, p: number, salt: Buffer, hash: Buffer): string {
  return `scrypt$${n}$${r}$${p}$${salt.toString("hex")}$${hash.toString("hex")}`;
}

export async function hashPin(pin: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await derive(pin, salt, SCRYPT_N, SCRYPT_R, SCRYPT_P);
  return encode(SCRYPT_N, SCRYPT_R, SCRYPT_P, salt, hash);
}

async function pinMatches(pin: string, encoded: string): Promise<boolean> {
  const parts = encoded.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;

  const [, n, r, p, saltHex, hashHex] = parts;
  if (!n || !r || !p || !saltHex || !hashHex) return false;

  const expected = Buffer.from(hashHex, "hex");
  const actual = await derive(pin, Buffer.from(saltHex, "hex"), Number(n), Number(r), Number(p));

  /* timingSafeEqual throws on a length mismatch, which would itself be the leak it exists to
     avoid — so the lengths get compared first. */
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/* ------------------------------------------------------------------------------------------- */

export type PinFailure = "PIN_INVALID" | "PIN_LOCKED" | "PIN_NOT_SET";
export type PinResult = { ok: true } | { ok: false; reason: PinFailure };

type PinRow = { pin_hash: string | null; locked: boolean };

/*
  Checks a PIN against a venue, counting the failure if it's wrong.

  ⚠️ PIN_NOT_SET is a real and currently common state — every seeded venue is in it — and it must
  not read as "wrong PIN". An employee told their correct code is wrong will retype it until they're
  locked out; told the venue isn't set up yet, they call someone. Same event, completely different
  evening.
*/
export async function verifyVenuePin(venueId: string, pin: string): Promise<PinResult> {
  const found = await db.execute(sql`
    SELECT pin_hash, (pin_locked_until IS NOT NULL AND pin_locked_until > now()) AS locked
    FROM venues
    WHERE id = ${venueId}
    LIMIT 1
  `);

  const row = found.rows[0] as PinRow | undefined;
  if (!row) return { ok: false, reason: "PIN_NOT_SET" };
  if (row.locked) return { ok: false, reason: "PIN_LOCKED" };
  if (!row.pin_hash) return { ok: false, reason: "PIN_NOT_SET" };

  if (await pinMatches(pin, row.pin_hash)) {
    /* A success clears the counter. Otherwise twenty typos spread across a month would eventually
       lock a venue that has been working perfectly the whole time. */
    await db.execute(sql`
      UPDATE venues
      SET pin_failed_count = 0, pin_locked_until = NULL, updated_at = now()
      WHERE id = ${venueId} AND (pin_failed_count <> 0 OR pin_locked_until IS NOT NULL)
    `);
    return { ok: true };
  }

  /*
    Count the miss, and lock once it crosses the line.

    Done in one statement rather than read-then-write so simultaneous guesses can't both see the
    same count and neither trip the limit.
  */
  const updated = await db.execute(sql`
    UPDATE venues
    SET pin_failed_count = pin_failed_count + 1,
        pin_locked_until = CASE
          WHEN pin_failed_count + 1 >= ${MAX_PIN_FAILURES}
            THEN now() + ${LOCKOUT_MINUTES} * interval '1 minute'
          ELSE pin_locked_until
        END,
        updated_at = now()
    WHERE id = ${venueId}
    RETURNING (pin_locked_until IS NOT NULL AND pin_locked_until > now()) AS locked
  `);

  const after = updated.rows[0] as { locked: boolean } | undefined;
  return { ok: false, reason: after?.locked ? "PIN_LOCKED" : "PIN_INVALID" };
}

/*
  Sets or rotates a venue's PIN, clearing any lockout.

  There is no "read the current PIN" anywhere, deliberately — it's stored as a one-way hash, so
  rotating is the only way to recover a forgotten one. That's the right trade for a shared code
  written on a card by the till.
*/
export async function setVenuePin(venueId: string, pin: string): Promise<boolean> {
  const encoded = await hashPin(pin);

  const result = await db.execute(sql`
    UPDATE venues
    SET pin_hash = ${encoded},
        pin_set_at = now(),
        pin_failed_count = 0,
        pin_locked_until = NULL,
        updated_at = now()
    WHERE id = ${venueId}
    RETURNING id
  `);

  return result.rows.length > 0;
}

/* ------------------------------------------------------------------------------------------- */

export type EnrolledDevice = { token: string; expiresAt: Date };

/*
  Remembers a browser as belonging to a venue, after it proved the PIN.

  This is what makes the second scan on a staff phone one tap instead of four digits — which is not
  only a speed win. A PIN typed in front of every member is a PIN that leaks by lunchtime; typed
  once per phone, it mostly doesn't.
*/
export async function enrolVenueDevice(venueId: string): Promise<EnrolledDevice> {
  const token = generateToken();

  const inserted = await db.execute(sql`
    INSERT INTO venue_devices (venue_id, token_hash, expires_at, last_used_at)
    VALUES (${venueId}, ${hashToken(token)}, now() + ${DEVICE_TTL_DAYS} * interval '1 day', now())
    RETURNING expires_at
  `);

  const row = inserted.rows[0] as { expires_at: unknown } | undefined;
  if (!row) throw new Error("failed to enrol venue device");

  return { token, expiresAt: toDate(row.expires_at) };
}

/*
  Which venue this browser is, or null.

  ⚠️ Returns the venue from OUR row, never from anything the cookie carries. The cookie holds a
  random token and nothing else; if it held a venue id the "remembered venue" would be a value the
  client could edit, and confirming redemptions at a venue of your choosing is the one thing this
  whole mechanism exists to prevent.
*/
export async function findVenueByDeviceToken(token: string): Promise<string | null> {
  const result = await db.execute(sql`
    UPDATE venue_devices
    SET last_used_at = now(), updated_at = now()
    WHERE token_hash = ${hashToken(token)} AND expires_at > now()
    RETURNING venue_id
  `);

  const row = result.rows[0] as { venue_id: string } | undefined;
  return row?.venue_id ?? null;
}

/* "Nu este localul meu" — and what you run for every device at a venue whose PIN leaked. */
export async function revokeVenueDevice(token: string): Promise<void> {
  await db.execute(sql`DELETE FROM venue_devices WHERE token_hash = ${hashToken(token)}`);
}
