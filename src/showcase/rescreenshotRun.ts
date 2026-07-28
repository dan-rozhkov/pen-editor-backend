import { loadConfig } from "../config.js";
import { createPgPool } from "../tracing/traceStore.js";
import { createShowcaseStore } from "./store.js";
import { createS3Client, uploadObject } from "../services/s3.js";
import { openShowcaseBrowser } from "./screenshot.js";
import { readFlag } from "./cliFlags.js";
import { rescreenshotScreens } from "./rescreenshot.js";

// CLI entrypoint for `npm run showcase:rescreenshot`. Kept apart from
// rescreenshot.ts for the same reason src/showcase/run.ts is kept apart from
// runner.ts: this half only reads env and wires Postgres, S3 and Chromium
// together, so it is excluded from coverage — while the loop it drives stays
// measured.
async function main(): Promise<void> {
  const config = loadConfig();
  const argv = process.argv.slice(2);
  const force = argv.includes("--force");
  const dryRun = argv.includes("--dry-run");
  const limitFlag = readFlag(argv, "limit");
  const limit = limitFlag ? Number(limitFlag) : undefined;

  if (limit != null && (!Number.isFinite(limit) || limit <= 0)) {
    console.error("[rescreenshot] --limit must be a positive number");
    process.exit(1);
  }

  if (!config.TRACE_DATABASE_URL) {
    console.error("[rescreenshot] TRACE_DATABASE_URL is required");
    process.exit(1);
  }

  const s3Client = createS3Client(config);
  if (!s3Client || !config.S3_BUCKET || !config.S3_ENDPOINT) {
    console.error(
      "[rescreenshot] S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY are all required",
    );
    process.exit(1);
  }
  const bucket = config.S3_BUCKET;
  const endpoint = config.S3_ENDPOINT;

  const pool = createPgPool(config.TRACE_DATABASE_URL);
  const store = createShowcaseStore(config, pool);
  if (!store) {
    console.error("[rescreenshot] failed to construct showcase store");
    process.exit(1);
  }

  const browserSession = await openShowcaseBrowser();
  try {
    const summary = await rescreenshotScreens(
      {
        store,
        screenshot: (html) => browserSession.screenshot(html),
        async fetchHtml(url) {
          const res = await fetch(url);
          if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
          return res.text();
        },
        uploadPng: (key, body) =>
          uploadObject(s3Client, bucket, endpoint, key, body, "image/png"),
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
    await store.close();
  }
}

// Only run as a script, not on import (mirrors src/showcase/run.ts).
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop()!)) {
  main().catch((err) => {
    console.error("[rescreenshot] failed:", err);
    process.exit(1);
  });
}
