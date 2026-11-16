#!/usr/bin/env node
// Bundles the local backend (src/local/index.ts) into dist-local/server.mjs
// plus its data files (dist-local/skills), runnable with plain `node` and NO
// node_modules. See docs/specs/2026-11-16-sideform-light-local-mode.md.
import { build } from "esbuild";
import { cp, rm, mkdir, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { stubPlugin } from "./lib/stubPlugin.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const out = join(root, "dist-local");

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });

const result = await build({
  entryPoints: [join(root, "src/local/index.ts")],
  outfile: join(out, "server.mjs"),
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  sourcemap: false,
  legalComments: "none",
  logLevel: "warning",
  metafile: true,
  // Tells src/local/index.ts it runs as the bundle (skills sit next to server.mjs).
  define: { __SIDEFORM_LOCAL_BUNDLE__: "true" },
  // CJS dependencies call require()/__dirname inside the ESM bundle.
  banner: {
    js: [
      "import { createRequire as __sfCreateRequire } from 'node:module';",
      "import { fileURLToPath as __sfFileURLToPath } from 'node:url';",
      "import { dirname as __sfDirname } from 'node:path';",
      "const require = __sfCreateRequire(import.meta.url);",
      "const __filename = __sfFileURLToPath(import.meta.url);",
      "const __dirname = __sfDirname(__filename);",
    ].join("\n"),
  },
  plugins: [stubPlugin],
});

await cp(join(root, "src/skills"), join(out, "skills"), { recursive: true });

const size = (await stat(join(out, "server.mjs"))).size;
const stubbed = new Set();
for (const input of Object.keys(result.metafile.inputs)) {
  if (input.startsWith("stub:")) stubbed.add(input.slice("stub:".length));
}
console.log(`dist-local/server.mjs ${(size / 1024 / 1024).toFixed(2)} MB; stubbed: ${[...stubbed].sort().join(", ") || "none"}`);
