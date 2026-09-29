import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error plain .mjs script, no type declarations
import { buildVendorFiles, stripHeader } from "../scripts/sync-browser-vendor.mjs";

const desktop = path.resolve(__dirname, "../../pen-editor-desktop");
const vendorDir = path.resolve(__dirname, "../src/browser/vendor");

// Same cross-repo pattern as the frontend's toolContract test: no sibling
// checkout (CI of this repo alone) means nothing to compare against.
describe.skipIf(!existsSync(desktop))("vendored browser controller", () => {
  it("matches the sync script's output for the committed desktop sources", () => {
    const expected = buildVendorFiles(desktop) as Record<string, string>;
    for (const [name, content] of Object.entries(expected)) {
      const actual = readFileSync(path.join(vendorDir, name), "utf8");
      expect(stripHeader(actual), `${name} is stale — run \`npm run browser:sync\``).toBe(stripHeader(content));
    }
  });
});
