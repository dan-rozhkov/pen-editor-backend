import type { ShowcaseStore } from "./store.js";
import { buildDerivatives } from "./derivatives.js";
import { createHash } from "node:crypto";

// Backfills the WebP derivatives (`image_url_1x`, `lqip`) onto rows published
// before they existed. No Chromium involved — the pixels are byte-identical
// to what's already live, since the source is the PNG already stored, not a
// re-render of the HTML (that's `showcase:rescreenshot`'s job). A run takes
// seconds rather than minutes.

export interface ReencodeDeps {
  store: Pick<ShowcaseStore, "listScreenImages" | "updateScreenDerivatives">;
  // Fetches the bytes at `imageUrl`. Only ever called for rows whose
  // `image_url` still names a `.png` object — a row already re-encoded to
  // WebP (by `publish.ts` or an earlier `reencode` run) is skipped before
  // this is invoked, so the name stays honest: this always fetches a PNG,
  // never a WebP being asked to re-encode itself.
  fetchPng(url: string): Promise<Buffer>;
  uploadWebp(key: string, body: Buffer): Promise<string>;
  log?(message: string): void;
}

export interface ReencodeOptions {
  // Reprocess rows that already have `image_url_1x`. Never bypasses the
  // PNG-source check below — a WebP row is skipped even under --force,
  // since there is no lossless source left to re-derive it from.
  force?: boolean;
  // Compute and report, but touch neither S3 nor the database.
  dryRun?: boolean;
  // Stop after N screens (oldest first) — handy for a trial run, same as
  // `showcase:rescreenshot --limit`.
  limit?: number;
}

export interface ReencodeSummary {
  total: number;
  updated: number;
  skipped: number;
  failed: number;
}

// This codebase names PNG objects `*.png` and WebP objects `*.webp`/`*@1x.webp`
// (see publish.ts and this file's own upload keys below) — the extension is
// enough to tell a not-yet-encoded row from an already-encoded one.
function isPngSource(imageUrl: string): boolean {
  return /\.png(?:[?#]|$)/i.test(imageUrl);
}

export async function reencodeScreens(
  deps: ReencodeDeps,
  options: ReencodeOptions = {},
): Promise<ReencodeSummary> {
  const log = deps.log ?? (() => {});
  const all = await deps.store.listScreenImages();
  const screens = options.limit != null ? all.slice(0, options.limit) : all;

  const summary: ReencodeSummary = {
    total: screens.length,
    updated: 0,
    skipped: 0,
    failed: 0,
  };

  for (const screen of screens) {
    const label = `${screen.title} (${screen.id})`;

    // Not a PNG: it has already been re-encoded (or was published straight
    // to WebP). Re-encoding a WebP into another WebP is a generational
    // quality loss with no upside, so this is never bypassed by --force —
    // unlike the "already has image_url_1x" skip below, which --force exists
    // specifically to bypass.
    if (!isPngSource(screen.imageUrl)) {
      summary.skipped++;
      log(`[reencode] skipped (image_url is not a PNG, already re-encoded): ${label}`);
      continue;
    }

    // Already backfilled and no --force: nothing to do. Keeps a rerun after a
    // partial failure cheap — it only touches what's still missing.
    if (screen.imageUrl1x && !options.force) {
      summary.skipped++;
      log(`[reencode] skipped (already has derivatives): ${label}`);
      continue;
    }

    try {
      const png = await deps.fetchPng(screen.imageUrl);
      const derivatives = await buildDerivatives(png);
      const sha8 = createHash("sha256")
        .update(derivatives.webp2x.body)
        .digest("hex")
        .slice(0, 8);

      if (options.dryRun) {
        summary.updated++;
        log(`[reencode] would update: ${label}`);
        continue;
      }

      // Keyed under the screen's own id rather than a run/index path — this
      // backfill has no notion of "run" or "position in run" the way publish
      // does, and the id is already unique and stable.
      const imageUrl = await deps.uploadWebp(
        `showcase/reencode/${screen.id}-${sha8}.webp`,
        derivatives.webp2x.body,
      );
      const imageUrl1x = await deps.uploadWebp(
        `showcase/reencode/${screen.id}-${sha8}@1x.webp`,
        derivatives.webp1x.body,
      );

      await deps.store.updateScreenDerivatives({
        id: screen.id,
        imageUrl,
        imageUrl1x,
        lqip: derivatives.lqip,
        width: derivatives.webp2x.width,
        height: derivatives.webp2x.height,
      });

      summary.updated++;
      log(`[reencode] updated: ${label}`);
    } catch (err) {
      // One bad screen (a 404'd PNG, a decode failure) must not abandon the
      // rest — the pass is idempotent, so a rerun picks up what failed.
      summary.failed++;
      log(`[reencode] FAILED ${label}: ${(err as Error).message}`);
    }
  }

  return summary;
}
