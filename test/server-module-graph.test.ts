import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src");

// Packages the server must never pull in at import time: they are
// devDependencies, so a production install (`npm ci --omit=dev`, which is what
// the deploy does) simply does not have them on disk. The showcase CLIs use
// them, and the CLIs are run from a dev checkout — but the moment a *route*
// imports a module that imports one of these, the API crashes at boot with
// "Cannot find module". This nearly happened when the "Open in Editor" route
// needed the screenshot viewport constants, which used to live next to
// `chromium` in showcase/screenshot.ts.
const DEV_ONLY_PACKAGES = ["playwright", "vitest", "@electric-sql/pglite"];

const IMPORT_RE = /(?:^|\n)\s*import[^;]*?from\s+["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g;

async function collectImports(file: string): Promise<string[]> {
  const source = await readFile(file, "utf8");
  const specifiers: string[] = [];
  for (const match of source.matchAll(IMPORT_RE)) {
    const specifier = match[1] ?? match[2];
    if (specifier) specifiers.push(specifier);
  }
  return specifiers;
}

/** Walks the real import graph from `entry`, returning every bare package hit. */
async function packagesReachableFrom(entry: string): Promise<Set<string>> {
  const packages = new Set<string>();
  const seen = new Set<string>();
  const queue = [entry];

  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);

    for (const specifier of await collectImports(file)) {
      if (specifier.startsWith(".")) {
        // NodeNext source imports carry a .js extension; the file on disk is .ts.
        const resolved = path
          .resolve(path.dirname(file), specifier)
          .replace(/\.js$/, ".ts");
        queue.push(resolved);
        continue;
      }
      // "playwright" and "playwright/test" are the same package.
      packages.add(specifier.split("/").slice(0, specifier.startsWith("@") ? 2 : 1).join("/"));
    }
  }

  return packages;
}

describe("server module graph", () => {
  it("never reaches a devDependency from the HTTP server's entrypoint", async () => {
    const reachable = await packagesReachableFrom(path.join(SRC, "app.ts"));
    const leaked = DEV_ONLY_PACKAGES.filter((pkg) => reachable.has(pkg));
    expect(leaked).toEqual([]);
  });
});
