import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { openShowcaseBrowser } from "./screenshot.js";
import { readFlag } from "./cliFlags.js";
import { openShowcaseContext } from "./context.js";
import { publishDepsFrom, publishScreens } from "./publish.js";
import { parseManifest, resolveScreens } from "./ingest.js";
import { runAsScript } from "./cli.js";

// CLI entrypoint for `npm run showcase:ingest -- --manifest path/to/run.json`.
// Same wiring-only shape as run.ts / rescreenshotRun.ts: env, Postgres, S3,
// Chromium. The parsing seam lives in ingest.ts and is unit-tested.
async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const manifestPath = readFlag(argv, "manifest");
  const dryRun = argv.includes("--dry-run");

  if (!manifestPath) {
    console.error(
      "[ingest] --manifest=path/to/run.json is required " +
        '(shape: { theme, prompt?, model?, screens: [{ name, file | htmlContent }] })',
    );
    process.exit(1);
  }

  const absManifest = resolve(process.cwd(), manifestPath);
  const manifestDir = dirname(absManifest);
  const manifest = parseManifest(await readFile(absManifest, "utf8"));
  const screens = await resolveScreens(
    { readFile: (rel) => readFile(resolve(manifestDir, rel), "utf8") },
    manifest,
  );

  const theme = manifest.theme;
  const prompt = manifest.prompt ?? theme;
  const model = manifest.model ?? "hand-authored";

  console.log(
    `[ingest] publishing ${screens.length} screen(s) for theme "${theme}" as model "${model}"` +
      (dryRun ? " (dry run — nothing is uploaded or stored)" : ""),
  );

  if (dryRun) {
    for (const screen of screens) {
      console.log(`  - ${screen.name} (${screen.htmlContent.length} bytes of HTML)`);
    }
    return;
  }

  const ctx = await openShowcaseContext("ingest");
  const browserSession = await openShowcaseBrowser();

  try {
    const published = await publishScreens(
      publishDepsFrom(ctx, (html) => browserSession.screenshot(html)),
      { runId: randomUUID(), theme, prompt, model, screens },
    );

    for (const screen of published) {
      console.log(`[ingest] ${screen.title}: ${screen.imageUrl}`);
    }
    console.log(`[ingest] done — theme "${theme}", ${published.length} screen(s)`);
  } finally {
    await browserSession.close();
    await ctx.close();
  }
}

runAsScript(import.meta.url, "ingest", main);
