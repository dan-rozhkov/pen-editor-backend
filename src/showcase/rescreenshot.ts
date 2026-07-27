import { randomUUID } from "node:crypto";
import { loadConfig } from "../config.js";
import { createPgPool } from "../tracing/traceStore.js";
import { createShowcaseStore, type ShowcaseStore } from "./store.js";
import { createS3Client, uploadObject } from "../services/s3.js";
import { openShowcaseBrowser, type ScreenshotResult } from "./screenshot.js";
import { readFlag } from "./cliFlags.js";

// Re-renders the PNG of every screen already in `showcase_screens` from its
// stored HTML. The HTML — not the image — is the source of truth, so a fix to
// the screenshot pipeline (e.g. a bottom bar that used to be sliced off) can be
// applied retroactively to screens the gallery is already serving, without
// re-running the design agent and getting different designs.
//
// Rendering is not deterministic in the small: remote photos come from
// picsum.photos seeds and fonts load over the network, so pixels can differ run
// to run. Only screens whose *dimensions* change are re-uploaded by default —
// that is exactly the class of bug this repairs — unless `force` is set.

export interface RescreenshotDeps {
  store: Pick<ShowcaseStore, "listScreenSources" | "updateScreenImage">;
  screenshot(html: string): Promise<ScreenshotResult>;
  fetchHtml(url: string): Promise<string>;
  uploadPng(key: string, body: Buffer): Promise<string>;
  log?(message: string): void;
}

export interface RescreenshotOptions {
  // Re-upload even when the re-render comes out the same size.
  force?: boolean;
  // Render and report, but touch neither S3 nor the database.
  dryRun?: boolean;
  // Stop after N screens (oldest first) — handy for a trial run.
  limit?: number;
}

export interface RescreenshotSummary {
  total: number;
  updated: number;
  unchanged: number;
  failed: number;
}

export async function rescreenshotScreens(
  deps: RescreenshotDeps,
  options: RescreenshotOptions = {},
): Promise<RescreenshotSummary> {
  const log = deps.log ?? (() => {});
  const all = await deps.store.listScreenSources();
  const screens = options.limit != null ? all.slice(0, options.limit) : all;

  const summary: RescreenshotSummary = {
    total: screens.length,
    updated: 0,
    unchanged: 0,
    failed: 0,
  };

  for (const screen of screens) {
    const label = `${screen.title} (${screen.id})`;
    try {
      const html = await deps.fetchHtml(screen.htmlUrl);
      const { buffer, width, height } = await deps.screenshot(html);
      const sameSize = width === screen.width && height === screen.height;

      if (sameSize && !options.force) {
        summary.unchanged++;
        log(`[rescreenshot] unchanged ${width}x${height}: ${label}`);
        continue;
      }

      if (options.dryRun) {
        summary.updated++;
        log(
          `[rescreenshot] would update ${screen.width}x${screen.height} -> ${width}x${height}: ${label}`,
        );
        continue;
      }

      // A fresh key rather than an overwrite: the old PNG may already be sitting
      // in a browser or CDN cache under its current URL, and a repair nobody can
      // see is not a repair.
      const imageUrl = await deps.uploadPng(
        `showcase/rerender/${randomUUID()}.png`,
        buffer,
      );
      await deps.store.updateScreenImage({ id: screen.id, imageUrl, width, height });

      summary.updated++;
      log(
        `[rescreenshot] updated ${screen.width}x${screen.height} -> ${width}x${height}: ${label}`,
      );
    } catch (err) {
      // One bad screen (S3 404, a hung render) must not abandon the rest.
      summary.failed++;
      log(`[rescreenshot] FAILED ${label}: ${(err as Error).message}`);
    }
  }

  return summary;
}

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
