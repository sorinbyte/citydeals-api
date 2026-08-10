import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";

import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

/*
  Converts venue photos to WebP and uploads them to R2, preserving folder structure.

  Usage:
    npm run assets:upload -- ../citydeals/assets/images
    npm run assets:upload -- ../citydeals/assets/images --dry-run

  The source directory is an argument rather than a hardcoded path on purpose — the images live in
  the mobile repo and this one shouldn't reach across into a sibling checkout by assumption.

  Why WebP and why resize: the source PNGs are ~1536px and up to 3MB each. The member who matters
  is standing at a counter on bad 4G. ~85% comes off the wire for no visible quality loss.

  Needs cwebp (`brew install webp`). Deliberately not a node dependency — this is a one-off admin
  task, and cwebp is the reference encoder.
*/

const QUALITY = 82; // photographic sweet spot; above ~85 the file grows faster than the quality
const MAX_WIDTH = 1280; // wider than any phone hero; downscaling is where most of the saving is

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set — see .env.example`);
  return value;
}

function assertCwebp(): void {
  try {
    execFileSync("cwebp", ["-version"], { stdio: "ignore" });
  } catch {
    throw new Error("cwebp not found. Install it with: brew install webp");
  }
}

/*
  Walks the tree and returns content images, as paths relative to the source root.

  ⚠️ Files sitting at the ROOT of the source dir are skipped on purpose. In the mobile repo that
  level holds app chrome — icon.png, favicon, splash-icon, the android adaptive-icon layers — which
  belongs in the app bundle, not in R2. Only the category subfolders hold venue photos.

  This also dodges an upscaling problem: those icons are small, and cwebp's -resize happily blows a
  512px icon up to 1280, producing a file several times LARGER than the source.
*/
function findImages(root: string, prefix = ""): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(root, prefix), { withFileTypes: true })) {
    const rel = join(prefix, entry.name);
    if (entry.isDirectory()) out.push(...findImages(root, rel));
    else if (
      prefix !== "" &&
      [".png", ".jpg", ".jpeg"].includes(extname(entry.name).toLowerCase())
    ) {
      out.push(rel);
    }
  }
  return out;
}

const mib = (bytes: number) => `${(bytes / 1_048_576).toFixed(1)}MB`;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const sourceArg = args.find((a) => !a.startsWith("--"));

  if (!sourceArg) {
    throw new Error("Usage: npm run assets:upload -- <source-dir> [--dry-run]");
  }

  const sourceRoot = resolve(sourceArg);
  if (!statSync(sourceRoot).isDirectory()) throw new Error(`${sourceRoot} is not a directory`);

  assertCwebp();

  // Only demand credentials when we're actually going to use them, so --dry-run works unconfigured
  const client = dryRun
    ? undefined
    : new S3Client({
        region: "auto",
        endpoint: `https://${requireEnv("R2_ACCOUNT_ID")}.r2.cloudflarestorage.com`,
        credentials: {
          accessKeyId: requireEnv("R2_ACCESS_KEY_ID"),
          secretAccessKey: requireEnv("R2_SECRET_ACCESS_KEY"),
        },
      });
  const bucket = dryRun ? "(dry run)" : requireEnv("R2_BUCKET");

  const images = findImages(sourceRoot);
  if (!images.length) throw new Error(`no images found under ${sourceRoot}`);

  const staging = mkdtempSync(join(tmpdir(), "citydeals-assets-"));
  let sourceBytes = 0;
  let outputBytes = 0;

  console.log(`${images.length} images from ${sourceRoot}`);
  if (dryRun) console.log("DRY RUN — converting to measure, uploading nothing\n");

  try {
    for (const rel of images) {
      const src = join(sourceRoot, rel);
      // same path, new extension — this is what ends up in venue_photos.path
      const key = rel.replace(/\.(png|jpe?g)$/i, ".webp");
      const out = join(staging, key);
      mkdirSync(dirname(out), { recursive: true });

      execFileSync(
        "cwebp",
        ["-q", String(QUALITY), "-resize", String(MAX_WIDTH), "0", "-quiet", src, "-o", out],
        { stdio: "inherit" },
      );

      const before = statSync(src).size;
      const after = statSync(out).size;
      sourceBytes += before;
      outputBytes += after;

      if (client) {
        await client.send(
          new PutObjectCommand({
            Bucket: bucket,
            Key: key,
            Body: readFileSync(out),
            ContentType: "image/webp",
            // Immutable because the filename IS the version — replacing a photo means a new name.
            // Without this every venue page re-fetches every image on every visit.
            CacheControl: "public, max-age=31536000, immutable",
          }),
        );
      }

      // Growing means the source was smaller than MAX_WIDTH and got upscaled, or it wasn't a photo
      // at all. Worth shouting about rather than quietly shipping a bigger file.
      if (after > before) {
        console.warn(`  ⚠️  ${key} GREW ${mib(before)} → ${mib(after)} — is this a photo?`);
      } else {
        console.log(
          `  ${key}  ${mib(before)} → ${mib(after)}  (-${Math.round((1 - after / before) * 100)}%)`,
        );
      }
    }
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }

  console.log(
    `\n${images.length} files: ${mib(sourceBytes)} → ${mib(outputBytes)} ` +
      `(-${Math.round((1 - outputBytes / sourceBytes) * 100)}%)`,
  );
  if (dryRun) console.log("nothing uploaded — drop --dry-run to push to R2");
  else console.log(`uploaded to r2://${bucket}`);
}

await main();
