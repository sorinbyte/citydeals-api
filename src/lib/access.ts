import { type KeyObject, createPublicKey, createVerify } from "node:crypto";

/*
  Verifying the JWT Cloudflare Access puts on every request that got past it.

  Access authenticates at the edge, before the admin app loads, and forwards proof as a signed token
  in `Cf-Access-Jwt-Assertion`. This turns that token into "which person is calling", which is the
  thing ADMIN_API_SECRET can't answer — a shared secret says the request came from our server, not
  who was sitting in front of it.

  ⚠️ NEVER trust the header without verifying it. It arrives on a request, which means a caller can
  set it — and the admin app's proxy forwards it verbatim. Unverified, "identity" would be whatever
  the caller typed. Everything below exists so that can't happen.

  Zero dependencies on purpose: Node's crypto imports a JWK directly and verifies RS256, so a JWT
  library would buy nothing but supply chain.
*/

/* Cloudflare signs Access tokens with RS256 and nothing else. Anything claiming another algorithm
   is either a different issuer or an attempt at the alg-confusion trick, and is refused rather than
   handled. */
const EXPECTED_ALG = "RS256";

/* Keys rotate. Long enough that a healthy request doesn't refetch, short enough that a rotation
   heals on its own within a couple of minutes. */
const JWKS_TTL_MS = 60 * 1000;

/* Cloudflare's own tolerance for clock skew between their edge and our server. */
const CLOCK_SKEW_SECONDS = 60;

type Jwk = { kid: string; kty: string; alg?: string; n: string; e: string };

export type AccessIdentity = {
  /* The claim everything else keys off. Access always issues one for a human login. */
  email: string;
  /* Cloudflare's stable id for the identity. Kept because an email can change and this doesn't. */
  subject: string;
};

export type AccessVerifier = (token: string) => Promise<AccessIdentity>;

/* Thrown for every rejection. The route turns it into one 401 — the caller learns nothing about
   WHY, because "expired" versus "wrong audience" versus "bad signature" is information only an
   attacker benefits from. It's logged server-side in full. */
export class AccessRejected extends Error {}

const decodeSegment = (segment: string): unknown => {
  try {
    return JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
  } catch {
    throw new AccessRejected("token segment is not base64url JSON");
  }
};

/*
  Fetches the team's signing keys, caching them for a minute.

  Cached by kid rather than as a blob so a token signed with a key we haven't seen forces exactly
  one refetch — during a rotation both the old and new key are published, and a stale cache would
  otherwise reject perfectly good tokens for a full TTL.
*/
function createKeyStore(certsUrl: string, fetchJwks: typeof fetch) {
  let keys = new Map<string, KeyObject>();
  let fetchedAt = 0;

  async function refresh(): Promise<void> {
    const response = await fetchJwks(certsUrl);
    if (!response.ok) {
      throw new AccessRejected(`Access certs endpoint returned ${response.status}`);
    }

    const body = (await response.json()) as { keys?: Jwk[] };
    if (!Array.isArray(body.keys)) throw new AccessRejected("Access certs response has no keys");

    const next = new Map<string, KeyObject>();
    for (const jwk of body.keys) {
      /* Only RSA signing keys. createPublicKey would happily import something else and then fail
         confusingly at verify time. */
      if (jwk.kty !== "RSA" || !jwk.kid) continue;
      next.set(jwk.kid, createPublicKey({ key: jwk, format: "jwk" }));
    }

    keys = next;
    fetchedAt = Date.now();
  }

  return async function keyFor(kid: string): Promise<KeyObject> {
    if (Date.now() - fetchedAt > JWKS_TTL_MS) await refresh();

    const cached = keys.get(kid);
    if (cached) return cached;

    /* Unknown kid on a fresh-enough cache means a rotation we haven't picked up. One refetch, then
       give up — retrying forever on an unknown kid is a way to be DoS'd by a bad token. */
    await refresh();

    const rotated = keys.get(kid);
    if (!rotated) throw new AccessRejected(`no Access signing key for kid ${kid}`);
    return rotated;
  };
}

/*
  Builds a verifier for one Access application.

  `aud` is the application's AUD tag from the Zero Trust dashboard, and checking it is what stops a
  token minted for a DIFFERENT application in the same account being replayed here. A team domain
  can protect several apps; without this check they'd all be interchangeable.

  `fetchJwks` is injectable so the tests can serve their own keys instead of reaching Cloudflare.
*/
export function createAccessVerifier({
  teamDomain,
  aud,
  fetchJwks = fetch,
  now = () => Date.now(),
}: {
  /* Either "myteam" or "myteam.cloudflareaccess.com" — normalised below, because both are what
     people copy out of the dashboard. */
  teamDomain: string;
  aud: string;
  fetchJwks?: typeof fetch;
  now?: () => number;
}): AccessVerifier {
  const host = teamDomain.includes(".") ? teamDomain : `${teamDomain}.cloudflareaccess.com`;
  const issuer = `https://${host}`;
  const keyFor = createKeyStore(`${issuer}/cdn-cgi/access/certs`, fetchJwks);

  return async function verify(token: string): Promise<AccessIdentity> {
    const parts = token.split(".");
    const [encodedHeader, encodedPayload, encodedSignature] = parts;

    if (parts.length !== 3 || !encodedHeader || !encodedPayload || !encodedSignature) {
      throw new AccessRejected("token is not a three-part JWT");
    }

    const header = decodeSegment(encodedHeader) as { alg?: string; kid?: string };
    if (header.alg !== EXPECTED_ALG) throw new AccessRejected(`unexpected alg ${header.alg}`);
    if (!header.kid) throw new AccessRejected("token header has no kid");

    /*
      ⚠️ Signature FIRST, claims after. Reading claims out of an unverified token and acting on them
      — even to pick a key — is how "alg: none" and its descendants work. The only thing taken from
      the token before this point is the kid, and an attacker controlling that can at worst name a
      key that doesn't exist.
    */
    const key = await keyFor(header.kid);
    const verifier = createVerify("RSA-SHA256");
    verifier.update(`${encodedHeader}.${encodedPayload}`);

    if (!verifier.verify(key, Buffer.from(encodedSignature, "base64url"))) {
      throw new AccessRejected("signature does not verify");
    }

    const payload = decodeSegment(encodedPayload) as {
      aud?: string | string[];
      iss?: string;
      exp?: number;
      nbf?: number;
      email?: string;
      sub?: string;
    };

    if (payload.iss !== issuer) throw new AccessRejected(`unexpected issuer ${payload.iss}`);

    /* `aud` is an array in Access tokens, but the spec allows a bare string — handle both rather
       than depending on which one Cloudflare happens to emit. */
    const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!audiences.includes(aud)) throw new AccessRejected("token is for a different application");

    const nowSeconds = Math.floor(now() / 1000);
    if (typeof payload.exp !== "number" || payload.exp + CLOCK_SKEW_SECONDS < nowSeconds) {
      throw new AccessRejected("token has expired");
    }
    if (typeof payload.nbf === "number" && payload.nbf - CLOCK_SKEW_SECONDS > nowSeconds) {
      throw new AccessRejected("token is not valid yet");
    }

    if (!payload.email) throw new AccessRejected("token carries no email claim");
    if (!payload.sub) throw new AccessRejected("token carries no subject");

    /* Lowercased here so every comparison downstream — the users lookup especially — is against one
       spelling. Access echoes whatever the identity provider sent. */
    return { email: payload.email.toLowerCase(), subject: payload.sub };
  };
}
