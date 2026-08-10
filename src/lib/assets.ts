import { env } from "@/lib/env";

/*
  Turns a stored relative key ("restaurants/italian-trattoria.webp") into a URL a client can fetch.

  Done here rather than in the clients on purpose. The asset domain isn't final, and a mobile app
  that bundled the base URL would keep pointing at the old one for every user who never updates —
  and you can't make them update. Server-side, changing it is one env var and every client picks it
  up on the next request.
*/
export function assetUrl(path: string | null): string | null {
  if (!path) return null;
  // stored keys never start with a slash; guard anyway so a stray one doesn't produce a double
  return `${env.ASSET_BASE_URL.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}
