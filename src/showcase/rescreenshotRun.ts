import { openShowcaseBrowser } from "./screenshot.js";
import { readFlag } from "./cliFlags.js";
import { rescreenshotScreens } from "./rescreenshot.js";
import { openShowcaseContext } from "./context.js";
import { runAsScript } from "./cli.js";

// CLI entrypoint for `npm run showcase:rescreenshot`. Kept apart from
// rescreenshot.ts for the same reason src/showcase/run.ts is kept apart from
// runner.ts: this half only reads env and wires Postgres, S3 and Chromium
// together, so it is excluded from coverage — while the loop it drives stays
// measured.
async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const force = argv.includes("--force");
  const dryRun = argv.includes("--dry-run");
  const limitFlag = readFlag(argv, "limit");
  const limit = limitFlag ? Number(limitFlag) : undefined;

  if (limit != null && (!Number.isFinite(limit) || limit <= 0)) {
    console.error("[rescreenshot] --limit must be a positive number");
    process.exit(1);
  }

  const ctx = await openShowcaseContext("rescreenshot");
  const browserSession = await openShowcaseBrowser();
  try {
    const summary = await rescreenshotScreens(
      {
        store: ctx.store,
        screenshot: (html) => browserSession.screenshot(html),
        async fetchHtml(url) {
          const res = await fetch(url);
          if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
          return res.text();
        },
        uploadPng: (key, body) => ctx.upload(key, body, "image/png"),
        log: (message) => console.log(message),
      },
      { force, dryRun, limit },
    );

    console.log(
      `[rescreenshot] done${dryRun ? " (dry run)" : ""} — ${summary.updated} updated, ` +
        `${summary.unchanged} unchanged, ${summary.failed} failed of ${summary.total}`,
    );
    if (summary.failed > 0) process.exitCode = 1;
  } finally {
    await browserSession.close();
    await ctx.close();
  }
}

runAsScript(import.meta.url, "rescreenshot", main);
