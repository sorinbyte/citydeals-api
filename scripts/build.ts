import { readFileSync } from "node:fs";

import { build } from "esbuild";

/*
  Bundles src/index.ts into dist/index.js for production.

  Why a bundle at all, rather than running tsx in production: tsx transpiles on every boot and drags
  the whole dev toolchain into the deployed image. A bundle boots as plain JavaScript, and the host
  only needs `dependencies` installed.

  Why not `tsc`: the `@/*` path alias. tsc emits the aliases verbatim — `import "@/db/client"` stays
  in the output and Node has no idea what that means at runtime. esbuild reads the same tsconfig
  paths and inlines those modules, so the alias never survives to runtime.

  ⚠️ NOT `--packages=external`. That externalises anything not starting with "." or "/", and "@/db/
  client" looks exactly like a scoped package name — the aliases would be left unresolved and the
  process would die on its first import. The explicit list below is what keeps that from happening,
  so don't "simplify" it back.
*/

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  dependencies?: Record<string, string>;
};

/*
  Runtime deps stay external and load from node_modules.

  Bundling them buys nothing here (there's no cold-start budget to win on a long-lived Node process)
  and actively breaks pg and the AWS SDK, both of which resolve things at runtime in ways a bundler
  can't see.

  Both forms are needed: esbuild treats "hono" and "hono/cors" as separate specifiers, so without the
  wildcard every subpath import gets inlined anyway.
*/
const external = Object.keys(pkg.dependencies ?? {}).flatMap((name) => [name, `${name}/*`]);

await build({
  entryPoints: ["src/index.ts"],
  outfile: "dist/index.js",
  bundle: true,
  platform: "node",
  /* Matches "type": "module" in package.json — a CJS bundle in an ESM package fails at load. */
  format: "esm",
  target: "node22",
  /* Cheap, and the alternative is a production stack trace pointing at a column in a bundle. */
  sourcemap: true,
  external,
  logLevel: "info",
});
