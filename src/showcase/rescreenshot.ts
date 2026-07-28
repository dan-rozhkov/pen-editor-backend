import { randomUUID } from "node:crypto";
import type { ShowcaseStore } from "./store.js";
import type { ScreenshotResult } from "./screenshot.js";

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
