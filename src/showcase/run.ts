import { randomUUID } from "node:crypto";
import { loadConfig } from "../config.js";
import { createPgPool } from "../tracing/traceStore.js";
import { migrate } from "../analysis/migrate.js";
import { createShowcaseStore } from "./store.js";
import { createS3Client, uploadObject } from "../services/s3.js";
import { SHOWCASE_THEMES, pickTheme } from "./themes.js";
import { runShowcaseGeneration } from "./runner.js";
import { openShowcaseBrowser } from "./screenshot.js";

const RECENT_THEMES_WINDOW = 10;

async function main(): Promise<void> {
  const config = loadConfig();

  if (!config.TRACE_DATABASE_URL) {
    console.error("[showcase] TRACE_DATABASE_URL is required to run showcase generation");
    process.exit(1);
  }
  if (
    !config.S3_ENDPOINT ||
    !config.S3_BUCKET ||
    !config.S3_ACCESS_KEY_ID ||
    !config.S3_SECRET_ACCESS_KEY
  ) {
    console.error(
      "[showcase] S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY are all required to run showcase generation",
    );
    process.exit(1);
  }

  const s3Client = createS3Client(config);
  if (!s3Client) {
    // Unreachable given the check above, but keeps createS3Client's
    // contract (Config -> S3Client | null) honest for the type checker.
    console.error("[showcase] failed to construct S3 client");
    process.exit(1);
  }

  const pool = createPgPool(config.TRACE_DATABASE_URL);
  const store = createShowcaseStore(config, pool);
  if (!store) {
    console.error("[showcase] failed to construct showcase store");
    process.exit(1);
  }

  let browserSession: Awaited<ReturnType<typeof openShowcaseBrowser>> | undefined;

  try {
    const migrationClient = await pool.connect();
    try {
      const applied = await migrate(migrationClient);
      if (applied.length) {
        console.log(`[showcase] applied migrations: ${applied.join(", ")}`);
      }
    } finally {
      migrationClient.release();
    }

    const recent = await store.recentThemes(RECENT_THEMES_WINDOW);
    const theme = pickTheme(SHOWCASE_THEMES, recent, Math.random);
    console.log(`[showcase] generating screens for theme "${theme}"`);

    const result = await runShowcaseGeneration(config, theme);
    if (result.screens.length === 0) {
      console.error(`[showcase] no embed screens were produced for theme "${theme}"`);
      process.exitCode = 1;
      return;
    }

    browserSession = await openShowcaseBrowser();
    const runId = randomUUID();
    const savedUrls: Array<{ title: string; imageUrl: string }> = [];

    for (let i = 0; i < result.screens.length; i++) {
      const screen = result.screens[i];
      const index = i + 1;

      const { buffer, width, height } = await browserSession.screenshot(
        screen.htmlContent,
      );

      const imageUrl = await uploadObject(
        s3Client,
        config.S3_BUCKET,
        config.S3_ENDPOINT,
        `showcase/${runId}/${index}.png`,
        buffer,
        "image/png",
      );
      const htmlUrl = await uploadObject(
        s3Client,
        config.S3_BUCKET,
        config.S3_ENDPOINT,
        `showcase/${runId}/${index}.html`,
        Buffer.from(screen.htmlContent, "utf8"),
        "text/html; charset=utf-8",
      );

      const title = screen.name || `${theme} — экран ${index}`;

      await store.insertScreen({
        id: randomUUID(),
        runId,
        theme,
        title,
        prompt: result.prompt,
        model: result.model,
        imageUrl,
        htmlUrl,
        width,
        height,
      });

      savedUrls.push({ title, imageUrl });
      console.log(`[showcase] saved screen ${index}/${result.screens.length}: ${title}`);
    }

    console.log(
      `[showcase] done — theme "${theme}", ${savedUrls.length} screen(s):\n` +
        savedUrls.map((s) => `  - ${s.title}: ${s.imageUrl}`).join("\n"),
    );
  } finally {
    if (browserSession) await browserSession.close();
    await store.close();
  }
}

// Only run as a script, not on import (mirrors src/analysis/run.ts).
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop()!)) {
  main().catch((err) => {
    console.error("[showcase] failed:", err);
    process.exit(1);
  });
}
