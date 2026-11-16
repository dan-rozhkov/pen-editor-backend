import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { afterAll, describe, expect, it } from "vitest";
// @ts-expect-error plain .mjs build script, no types
import { stubPlugin } from "../scripts/lib/stubPlugin.mjs";

// The local bundle replaces unreachable packages with throwing stubs
// (scripts/lib/stubPlugin.mjs). Named, default and namespace imports must all
// resolve to a stub that throws the intended message when used.
describe("local bundle stubs", () => {
  let dir = "";
  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("makes named, default and namespace imports throw the stub message on use", async () => {
    dir = await mkdtemp(join(tmpdir(), "sideform-stub-"));
    const entry = join(dir, "entry.mjs");
    await writeFile(
      entry,
      `import { S3Client } from "@aws-sdk/client-s3";
       import sharp from "sharp";
       import * as pg from "pg";
       import { Resend } from "resend";
       const attempt = (fn) => { try { fn(); return "did not throw"; } catch (e) { return e.message; } };
       export const results = [
         attempt(() => new S3Client()),
         attempt(() => sharp()),
         attempt(() => new pg.Pool()),
         attempt(() => new Resend("k")),
       ];`,
    );
    const out = join(dir, "out.mjs");
    await build({ entryPoints: [entry], outfile: out, bundle: true, platform: "node", format: "esm", logLevel: "silent", plugins: [stubPlugin] });
    const { results } = (await import(pathToFileURL(out).href)) as { results: string[] };
    expect(results).toEqual([
      '"@aws-sdk/client-s3" is not available in the local bundle',
      '"sharp" is not available in the local bundle',
      '"pg" is not available in the local bundle',
      '"resend" is not available in the local bundle',
    ]);
  });
});
