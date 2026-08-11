import assert from "node:assert/strict";
import { type KeyObject, createSign, generateKeyPairSync } from "node:crypto";
import { test } from "node:test";

import { AccessRejected, createAccessVerifier } from "@/lib/access";

/*
  Cloudflare Access token verification.

  Worth testing properly because every failure here fails OPEN — a verifier that accepts a token it
  shouldn't doesn't throw, it just lets the wrong person in. Most of what follows is rejections.

  Real RSA keys are generated per run rather than checked in, so nothing here is a credential.
*/

const TEAM = "citydeals";
const ISSUER = `https://${TEAM}.cloudflareaccess.com`;
const AUD = "aud-tag-for-the-admin-app";

const keyPair = generateKeyPairSync("rsa", { modulusLength: 2048 });
const otherPair = generateKeyPairSync("rsa", { modulusLength: 2048 });

const base64url = (value: object | string) =>
  Buffer.from(typeof value === "string" ? value : JSON.stringify(value)).toString("base64url");

function signToken({
  key = keyPair.privateKey,
  kid = "key-1",
  alg = "RS256",
  claims = {},
}: {
  key?: KeyObject;
  kid?: string;
  alg?: string;
  claims?: Record<string, unknown>;
} = {}): string {
  const header = base64url({ alg, kid, typ: "JWT" });
  const payload = base64url({
    iss: ISSUER,
    aud: [AUD],
    email: "Sorin@Example.com",
    sub: "identity-123",
    exp: Math.floor(Date.now() / 1000) + 3600,
    ...claims,
  });

  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${payload}`);
  return `${header}.${payload}.${signer.sign(key).toString("base64url")}`;
}

/* Serves the public half as a JWKS, standing in for Cloudflare's certs endpoint. */
function jwksServing(publicKeys: Record<string, KeyObject>, onFetch?: () => void) {
  return async (): Promise<Response> => {
    onFetch?.();
    const keys = Object.entries(publicKeys).map(([kid, key]) => ({
      ...key.export({ format: "jwk" }),
      kid,
      alg: "RS256",
      use: "sig",
    }));
    return new Response(JSON.stringify({ keys }), { status: 200 });
  };
}

const verifierWith = (fetchJwks: () => Promise<Response>, options: { now?: () => number } = {}) =>
  createAccessVerifier({
    teamDomain: TEAM,
    aud: AUD,
    fetchJwks: fetchJwks as unknown as typeof fetch,
    ...options,
  });

test("accepts a properly signed token and lowercases the email", async () => {
  const verify = verifierWith(jwksServing({ "key-1": keyPair.publicKey }));
  const identity = await verify(signToken());

  /* Lowercased so the users lookup only ever compares one spelling — Access echoes whatever the
     identity provider sent. */
  assert.deepEqual(identity, { email: "sorin@example.com", subject: "identity-123" });
});

test("accepts a team domain given in full", async () => {
  const verify = createAccessVerifier({
    teamDomain: `${TEAM}.cloudflareaccess.com`,
    aud: AUD,
    fetchJwks: jwksServing({ "key-1": keyPair.publicKey }) as unknown as typeof fetch,
  });

  assert.equal((await verify(signToken())).email, "sorin@example.com");
});

test("rejects a token signed by someone else's key", async () => {
  /* The one that matters most: a well-formed token with every claim correct, signed by a key that
     isn't Cloudflare's. */
  const verify = verifierWith(jwksServing({ "key-1": keyPair.publicKey }));

  await assert.rejects(() => verify(signToken({ key: otherPair.privateKey })), AccessRejected);
});

test("rejects a tampered payload", async () => {
  const verify = verifierWith(jwksServing({ "key-1": keyPair.publicKey }));
  const [header, , signature] = signToken().split(".");
  const forged = base64url({
    iss: ISSUER,
    aud: [AUD],
    email: "attacker@example.com",
    sub: "identity-123",
    exp: Math.floor(Date.now() / 1000) + 3600,
  });

  await assert.rejects(() => verify(`${header}.${forged}.${signature}`), AccessRejected);
});

test("rejects alg other than RS256", async () => {
  /* Alg confusion: claim a different algorithm and hope the verifier follows the token's lead. */
  const verify = verifierWith(jwksServing({ "key-1": keyPair.publicKey }));

  await assert.rejects(() => verify(signToken({ alg: "none" })), AccessRejected);
  await assert.rejects(() => verify(signToken({ alg: "HS256" })), AccessRejected);
});

test("rejects a token for a different Access application", async () => {
  /* One team domain can protect several apps. Without the aud check, a token for any of them would
     open this one. */
  const verify = verifierWith(jwksServing({ "key-1": keyPair.publicKey }));

  await assert.rejects(
    () => verify(signToken({ claims: { aud: ["some-other-app"] } })),
    AccessRejected,
  );
});

test("rejects a token from a different issuer", async () => {
  const verify = verifierWith(jwksServing({ "key-1": keyPair.publicKey }));

  await assert.rejects(
    () => verify(signToken({ claims: { iss: "https://evil.cloudflareaccess.com" } })),
    AccessRejected,
  );
});

test("rejects an expired token, allowing for clock skew", async () => {
  const verify = verifierWith(jwksServing({ "key-1": keyPair.publicKey }));
  const nowSeconds = Math.floor(Date.now() / 1000);

  /* Thirty seconds past expiry is inside the skew allowance and still accepted. */
  await verify(signToken({ claims: { exp: nowSeconds - 30 } }));

  /* Ten minutes past is not. */
  await assert.rejects(
    () => verify(signToken({ claims: { exp: nowSeconds - 600 } })),
    AccessRejected,
  );
});

test("rejects a token with no expiry at all", async () => {
  const verify = verifierWith(jwksServing({ "key-1": keyPair.publicKey }));

  await assert.rejects(() => verify(signToken({ claims: { exp: undefined } })), AccessRejected);
});

test("rejects a token that isn't valid yet", async () => {
  const verify = verifierWith(jwksServing({ "key-1": keyPair.publicKey }));
  const nowSeconds = Math.floor(Date.now() / 1000);

  await assert.rejects(
    () => verify(signToken({ claims: { nbf: nowSeconds + 600 } })),
    AccessRejected,
  );
});

test("rejects a token carrying no email", async () => {
  /* A service-token request has no human behind it, so there's nobody to attribute writes to. */
  const verify = verifierWith(jwksServing({ "key-1": keyPair.publicKey }));

  await assert.rejects(() => verify(signToken({ claims: { email: undefined } })), AccessRejected);
});

test("rejects malformed tokens", async () => {
  const verify = verifierWith(jwksServing({ "key-1": keyPair.publicKey }));

  for (const bad of ["", "not-a-jwt", "only.two", "a.b.c.d", "..", "!!!.???.***"]) {
    await assert.rejects(() => verify(bad), AccessRejected, `expected rejection for ${bad}`);
  }
});

test("refetches once when a key has rotated, then gives up", async () => {
  /* During a rotation Cloudflare publishes both keys, so an unseen kid should heal on one refetch
     rather than failing for a whole cache TTL. */
  let fetches = 0;
  const store: Record<string, KeyObject> = { "key-1": keyPair.publicKey };
  const verify = verifierWith(
    jwksServing(store, () => {
      fetches += 1;
      /* The rotation lands between the first and second fetch. */
      if (fetches >= 2) store["key-2"] = otherPair.publicKey;
    }),
  );

  await verify(signToken());
  assert.equal(fetches, 1);

  const rotated = await verify(signToken({ key: otherPair.privateKey, kid: "key-2" }));
  assert.equal(rotated.email, "sorin@example.com");
  assert.equal(fetches, 2, "expected exactly one extra fetch for the unknown kid");

  /* A kid that will never exist must not refetch forever. */
  const before = fetches;
  await assert.rejects(() => verify(signToken({ kid: "never" })), AccessRejected);
  assert.ok(fetches - before <= 1, "an unknown kid should cost at most one refetch");
});

test("rejects when the certs endpoint is unreachable", async () => {
  /* Failing closed matters: an outage at Cloudflare must not turn into open access. */
  const verify = verifierWith(async () => new Response("nope", { status: 500 }));

  await assert.rejects(() => verify(signToken()), AccessRejected);
});
