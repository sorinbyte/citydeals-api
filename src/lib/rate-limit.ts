/*
  A fixed-window counter, in memory, no dependency.

  ⚠️ Per-process, which is correct only while this API runs as a single Railway instance. A second
  replica doesn't break it — each process would allow the full quota, so the effective limit
  doubles — but that's the thing to revisit before scaling out, and the fix is a shared store
  (Redis, or Postgres if the volume stays this low) rather than a bigger map.

  Fixed window rather than sliding on purpose: a sliding window needs a timestamp list per key, and
  the whole point here is to be cheap enough to run in front of an unauthenticated endpoint.
*/

type Bucket = { count: number; resetAt: number };

const buckets = new Map<string, Bucket>();

/*
  Called on every write so the map can't grow without bound. Cheap because it only runs when a
  bucket is created, not on every hit — the endpoints behind this see single-digit requests a
  minute in normal use, and under an actual flood the sweep is the least of the work.
*/
function sweep(now: number): void {
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
}

/*
  Records a hit and says whether it's allowed. `false` means the caller is over the limit.

  Distinct `key` namespaces are the caller's job — pass "request-link:email:foo@bar.ro", not
  "foo@bar.ro", or two different limits on the same value would share a counter.
*/
export function allowRequest(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  const existing = buckets.get(key);

  if (!existing || existing.resetAt <= now) {
    sweep(now);
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }

  existing.count += 1;
  return existing.count <= limit;
}

/*
  Best-effort client IP.

  Railway (and any proxy) puts the real address first in X-Forwarded-For and appends its own hops
  after it, so we take the leftmost entry. ⚠️ That value is client-controlled — anyone can send a
  forged header — which is why it is only ever a *secondary* limit here. The per-email limit is the
  one that actually protects a partner's account, and an attacker can't forge someone else's email
  into being a different email.

  Returns null when there's no header at all (direct connection in local dev); callers skip the IP
  limit rather than lumping every such request into one shared bucket.
*/
export function clientIp(forwardedFor: string | undefined): string | null {
  if (!forwardedFor) return null;
  const first = forwardedFor.split(",")[0]?.trim();
  return first ? first : null;
}
