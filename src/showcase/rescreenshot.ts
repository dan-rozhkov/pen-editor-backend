import { randomUUID, createHash } from "node:crypto";
import type { ShowcaseStore } from "./store.js";
import type { ScreenshotResult } from "./screenshot.js";
import { buildDerivatives } from "./derivatives.js";
import { normalizeShowcaseHtml } from "./normalizeHtml.js";
import type { ShowcasePlatform } from "./platform.js";

// Re-renders every screen already in `showcase_screens` from its stored HTML.
// The HTML — not the image — is the source of truth, so a fix to the
// screenshot pipeline (e.g. a bottom bar that used to be sliced off) can be
// applied retroactively to screens the gallery is already serving, without
// re-running the design agent and getting different designs.
//
// Rendering is not deterministic in the small: remote photos come from
// picsum.photos seeds and fonts load over the network, so pixels can differ run
// to run. Only screens whose *dimensions* change are re-uploaded by default —
// that is exactly the class of bug this repairs — unless `force` is set.
//
// A re-render goes through the same `buildDerivatives` + two-WebP-object
// pipeline as `publish.ts`, and updates the row via `updateScreenDerivatives`
// (image_url, image_url_1x, lqip, width, height together) rather than the
// PNG-only `updateScreenImage`. That is deliberate: a rescreenshot that wrote
// a fresh `image_url` without also refreshing `image_url_1x`/`lqip` would
// leave the row half-updated, and srcset would keep serving the stale @1x
// image forever since every derivative object is content-hashed and
// `immutable`-cached.

export interface RescreenshotDeps {
  store: Pick<
    ShowcaseStore,
    "listScreenSources" | "updateScreenDerivatives" | "updateScreenHtmlUrl"
  >;
  // Re-renders at the screen's OWN platform (`ShowcaseScreenSource.platform`)
  // — a sweep spans every published screen, mobile and desktop alike, so the
  // viewport can't be fixed once for the whole run the way `run.ts`/
  // `ingestRun.ts` fix it.
  screenshot(html: string, platform: ShowcasePlatform): Promise<ScreenshotResult>;
  fetchHtml(url: string): Promise<string>;
  uploadWebp(key: string, body: Buffer): Promise<string>;
  uploadHtml(key: string, body: Buffer): Promise<string>;
  log?(message: string): void;
}

export interface RescreenshotOptions {
  // Re-upload even when the re-render comes out the same size.
  force?: boolean;
  // Render and report, but touch neither S3 nor the database.
  dryRun?: boolean;
  // Stop after N screens (oldest first) — handy for a trial run.
  limit?: number;
  // Restrict the sweep to one app: a run_id, or the id of any screen in it.
  appOf?: string;
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
  const all = await deps.store.listScreenSources({ appOf: options.appOf });
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
      const stored = await deps.fetchHtml(screen.htmlUrl);
      // Screens published before `normalizeShowcaseHtml` existed still carry
      // whatever the agent wrote, so their form controls are still wearing the
      // user agent's clothes — in the image AND in the lightbox iframe, which
      // serves this very HTML. Normalizing here is what makes one
      // `showcase:rescreenshot` sweep a repair path for both.
      const html = normalizeShowcaseHtml(stored);
      const htmlChanged = html !== stored;

      const { buffer, width, height } = await deps.screenshot(html, screen.platform);
      const sameSize = width === screen.width && height === screen.height;

      if (sameSize && !options.force && !htmlChanged) {
        summary.unchanged++;
        log(`[rescreenshot] unchanged ${width}x${height}: ${label}`);
        continue;
      }

      if (options.dryRun) {
        summary.updated++;
        log(
          `[rescreenshot] would update ${screen.width}x${screen.height} -> ${width}x${height}${htmlChanged ? " (+normalized HTML)" : ""}: ${label}`,
        );
        continue;
      }

      // The HTML first: it is the source of truth, and if the image upload
      // below fails the screen is at least left with markup a later sweep can
      // re-render from. A fresh key, never an overwrite — the old object is
      // served `immutable` for a year (same reasoning as replaceHtml.ts).
      if (htmlChanged) {
        const body = Buffer.from(html, "utf8");
        const htmlSha8 = createHash("sha256").update(body).digest("hex").slice(0, 8);
        const htmlUrl = await deps.uploadHtml(
          `showcase/revision/${randomUUID()}-${htmlSha8}.html`,
          body,
        );
        await deps.store.updateScreenHtmlUrl(screen.id, htmlUrl);
        log(`[rescreenshot] normalized HTML -> ${htmlUrl}: ${label}`);
      }

      const derivatives = await buildDerivatives(buffer);
      // Content hash of the 2x body, shared by both variants — same
      // convention as publish.ts, so one screen has one hash.
      const sha8 = createHash("sha256")
        .update(derivatives.webp2x.body)
        .digest("hex")
        .slice(0, 8);

      // A fresh, content-hashed key rather than an overwrite: the old WebP
      // may already be sitting in a browser or CDN cache under its current
      // URL (now `immutable`, see s3.ts), and a repair nobody can see is not
      // a repair.
      const base = `showcase/rerender/${randomUUID()}-${sha8}`;
      const imageUrl = await deps.uploadWebp(`${base}.webp`, derivatives.webp2x.body);
      const imageUrl1x = await deps.uploadWebp(`${base}@1x.webp`, derivatives.webp1x.body);
      await deps.store.updateScreenDerivatives({
        id: screen.id,
        imageUrl,
        imageUrl1x,
        lqip: derivatives.lqip,
        // The dimensions of the object actually stored at `imageUrl`
        // (buildDerivatives never resizes the 2x variant, only re-encodes
        // the format, so these equal the screenshot's own `width`/`height`
        // — but deriving them from the WebP itself is what keeps that true
        // by construction rather than by coincidence).
        width: derivatives.webp2x.width,
        height: derivatives.webp2x.height,
      });

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
