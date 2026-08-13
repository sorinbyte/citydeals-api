import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/*
  Making and checking the one-time secrets: magic-link tokens and session cookies.

  Both follow the same rule, and it's the only rule that matters here — the plaintext exists in
  transit (an email, a cookie) and NOWHERE at rest. What goes in the database is the SHA-256, so a
  dump is a list of useless hashes rather than a set of live logins.

  Zero dependencies: node:crypto does all of it.
*/

/*
  32 bytes, from the OS. That's 256 bits of entropy — there is no guessing it, which is the whole
  reason the hashing below can be a plain SHA-256 rather than argon2.

  ⚠️ randomBytes, never Math.random(). Math.random() is a fast PRNG seeded from the process, not a
  CSPRNG; its output is predictable given enough samples, and "predictable login token" is the
  worst possible thing to be wrong about.

  base64url rather than hex: same entropy in 43 characters instead of 64, and it survives being a
  path segment untouched — no percent-encoding to get wrong on either side of the link.
*/
export function generateToken(): string {
  return randomBytes(32).toString("base64url");
}

/*
  SHA-256, hex.

  Deliberately NOT bcrypt/argon2/scrypt. Those are slow on purpose, to make LOW-entropy secrets
  (passwords people choose) expensive to attack offline. These tokens are 32 random bytes: there is
  nothing to brute force, so a slow hash would buy nothing and add latency to every single sign-in
  and every authenticated request.

  Deterministic, which is the point — the lookup is a unique-index hit on the hash rather than a
  scan comparing every row.
*/
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/*
  Constant-time compare for two hex hashes.

  The database lookup is already an equality match on an indexed column, so this isn't on the main
  path — it's here for anywhere a hash gets compared in JavaScript, where `===` short-circuits on
  the first differing character and leaks how much of a guess was right.
*/
export function hashesMatch(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  // timingSafeEqual throws on a length mismatch, which would itself be the leak we're avoiding
  return left.length === right.length && timingSafeEqual(left, right);
}
