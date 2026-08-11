import { randomUUID } from "node:crypto";
import { DeleteObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

import { env } from "@/lib/env";

/*
  Writing objects to R2.

  R2 speaks the S3 API, so this is @aws-sdk/client-s3 pointed at Cloudflare's endpoint — the same
  arrangement scripts/upload-assets.ts uses for bulk seeding. This module is the online half: one
  photo at a time, uploaded by a person through the admin dashboard.

  ⚠️ Only the API touches these credentials. Clients get ASSET_BASE_URL, which is read-only and
  public; the keys here can overwrite and delete the bucket and must never reach a bundle.

  What this deliberately does NOT do is transcode. The offline script shells out to cwebp because
  it's processing a directory of originals; a browser upload arrives already resized and encoded to
  WebP on a canvas, so the server would be re-encoding something that's already right. Keeping
  ImageMagick-shaped dependencies out of the API is worth the trade.
*/

const client = new S3Client({
  region: "auto",
  endpoint: `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
  },
});

/* What a browser may send. Anything else is a 415 rather than an object nobody can render. */
export const UPLOADABLE_IMAGE_TYPES = new Set(["image/webp", "image/jpeg", "image/png"]);

const EXTENSIONS: Record<string, string> = {
  "image/webp": "webp",
  "image/jpeg": "jpg",
  "image/png": "png",
};

/*
  Where a venue's photos live.

  Keyed by venue ID, not slug. A slug is editable — that's the whole reason the admin page is
  addressed by id — and building paths from one would orphan every photo the first time someone
  fixes a typo. The uuid makes each upload its own object, which is what lets the immutable
  cache header below be safe: a key is never reused, so a cached copy can never be stale.

  Different shape from the offline script's keys (restaurants/italian-trattoria.webp), and that's
  fine — `path` is an opaque bucket key that assetUrl() composes onto, not something anything parses.
*/
function photoKey(venueId: string, contentType: string): string {
  return `venues/${venueId}/${randomUUID()}.${EXTENSIONS[contentType] ?? "bin"}`;
}

/* Returns the key to store in venue_photos.path — never a URL. Composing the URL is assetUrl's job,
   so the day the asset domain changes it's one env var rather than a table migration. */
export async function uploadVenuePhoto(
  venueId: string,
  body: Uint8Array,
  contentType: string,
): Promise<string> {
  const key = photoKey(venueId, contentType);

  await client.send(
    new PutObjectCommand({
      Bucket: env.R2_BUCKET,
      Key: key,
      Body: body,
      ContentType: contentType,
      /* Safe because keys carry a uuid and are never rewritten — replacing a photo means a new
         object. Same header the bulk script sets, for the same reason. */
      CacheControl: "public, max-age=31536000, immutable",
    }),
  );

  return key;
}

/*
  Best effort, and the caller must treat it that way.

  The database row is the thing that matters: a photo nobody references is invisible and costs
  fractions of a cent, whereas a row pointing at a deleted object renders as a broken image. So the
  row goes first and this is allowed to fail quietly.
*/
export async function deleteVenuePhotoObject(path: string): Promise<void> {
  try {
    await client.send(new DeleteObjectCommand({ Bucket: env.R2_BUCKET, Key: path }));
  } catch (error) {
    console.error(`R2 delete failed for ${path} (row already gone, object orphaned):`, error);
  }
}
