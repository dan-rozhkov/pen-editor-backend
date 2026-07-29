import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { openShowcaseBrowser } from "./screenshot.js";
import { hasFlag, readFlag, parsePlatformFlag } from "./cliFlags.js";
import { openShowcaseContext } from "./context.js";
import { publishDepsFrom, publishScreens } from "./publish.js";
import { coverIndexFrom, parseManifest, resolveCoverIndex, resolveScreens } from "./ingest.js";
import { runAsScript } from "./cli.js";

// CLI entrypoint for `npm run showcase:ingest -- --manifest path/to/run.json`.
// Same wiring-only shape as run.ts / rescreenshotRun.ts: env, Postgres, S3,
// Chromium. The parsing seam lives in ingest.ts and is unit-tested.
async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const manifestPath = readFlag(argv, "manifest");
  const dryRun = argv.includes("--dry-run");
  const coverFlag = readFlag(argv, "cover");
  const coverFlagPresent = hasFlag(argv, "cover");
  const platform = parsePlatformFlag(argv, "ingest");

  if (!manifestPath) {
    console.error(
      "[ingest] --manifest=path/to/run.json is required " +
        '(shape: { theme, prompt?, model?, screens: [{ name, file | htmlContent, cover? }] })',
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

  // `--cover` overrides the manifest's `cover: true` marker — a one-off pick
  // shouldn't require editing the file that's meant to be reusable.
  let coverIndex: number | undefined;
  try {
    coverIndex = resolveCoverIndex({
      raw: coverFlag,
      flagPresent: coverFlagPresent,
      manifestDefault: coverIndexFrom(manifest),
      screenCount: screens.length,
    });
  } catch (err) {
    console.error(`[ingest] ${(err as Error).message}`);
    process.exit(1);
  }

  const theme = manifest.theme;
  const prompt = manifest.prompt ?? theme;
  const model = manifest.model ?? "hand-authored";

  console.log(
    `[ingest] publishing ${screens.length} ${platform} screen(s) for theme "${theme}" as model "${model}"` +
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
      publishDepsFrom(ctx, (html, screenPlatform) => browserSession.screenshot(html, screenPlatform)),
      { runId: randomUUID(), theme, prompt, model, screens, coverIndex, platform },
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
